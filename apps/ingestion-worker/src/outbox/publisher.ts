/**
 * Transactional Outbox Publisher：读取未发布 outbox event；ARCHIVE 发送 Archive SQS，
 * CT-04 Notification 发送设备 MQTT Topic，并原子记录发布时间和重试信息。
 *
 * 语义（at-least-once）：
 * - 事件 ID 稳定：Archive 的 eventId、Notification 的 meta.id 均由 outbox_events.id 派生；
 *   重复投递必须由下游/设备按消息 ID 去重；
 * - 进程在发送前中断：事件保持 PENDING，下一轮补发（不丢）；
 * - 进程在发送后、标记前中断：下一轮重复发送，下游去重（不丢、不重复归档）；
 * - 发送失败：原子记录 retryCount+1/lastError；达到 maxAttempts → FAILED（不再自动领取，
 *   人工处置归边界外）；单条失败不阻塞批次内其他事件；
 * - 发布失败不影响已提交业务记录：业务写入已在 BE-IOT-03 receipt 事务提交，
 *   Publisher 只触碰 outbox 行自身（逐条独立更新，无跨行事务）。
 */
import type { ArchiveEventMessage, ArchiveEventSender, MqttMessageSender } from '@fdp/aws-clients';
import { isKnownNotification, NOTIFICATION_CATALOG } from '@fdp/contracts/mqtt/catalogs.js';
import { parseTopic } from '@fdp/contracts/mqtt/topics.js';
import type { DbClient } from '@fdp/database';

export interface OutboxPublisherDeps {
  readonly client: DbClient;
  readonly sender: ArchiveEventSender;
  /** 配置后同时消费 CT-04 Notification Outbox；缺省保持仅归档行为。 */
  readonly notificationSender?: MqttMessageSender | undefined;
  /** 单批领取上限（缺省 50）。 */
  readonly batchSize?: number | undefined;
  /** 最大尝试次数，达到后标记 FAILED（缺省 8）。 */
  readonly maxAttempts?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface PublishBatchResult {
  /** 本轮领取的 PENDING 事件数。 */
  readonly claimed: number;
  /** 本轮成功发布（PUBLISHED）数。 */
  readonly published: number;
  /** 本轮发送失败、记录重试信息（仍 PENDING）数。 */
  readonly retried: number;
  /** 本轮达到 maxAttempts 标记 FAILED 数。 */
  readonly failed: number;
}

interface OutboxRow {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly retryCount: number;
  readonly createdAt: Date;
}

interface OutboxDelegate {
  findMany(args: Record<string, unknown>): Promise<OutboxRow[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

const MAX_ERROR_LENGTH = 500;

interface NotificationOutboxPayload {
  readonly topic: string;
  readonly data: Readonly<Record<string, unknown>>;
}

function notificationPayloadOf(row: OutboxRow): NotificationOutboxPayload {
  if (!isKnownNotification(row.eventType)) throw new Error(`Unsupported notification event: ${row.eventType}`);
  if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
    throw new Error('Notification payload must be an object');
  }
  const payload = row.payload as Record<string, unknown>;
  if (typeof payload.topic !== 'string') throw new Error('Notification topic must be a string');
  const topic = parseTopic(payload.topic);
  if (topic.type !== 'notification' || topic.direction !== 'downlink') {
    throw new Error('Notification must target a downlink notification topic');
  }
  if (row.aggregateType === 'device' && topic.deviceId !== row.aggregateId) {
    throw new Error('Notification topic does not match aggregate device');
  }
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw new Error('Notification data must be an object');
  }
  const data = payload.data as Record<string, unknown>;
  if (data.type !== row.eventType) throw new Error('Notification data.type does not match eventType');
  return { topic: payload.topic, data };
}

export function createOutboxPublisher(deps: OutboxPublisherDeps): {
  publishPendingBatch(): Promise<PublishBatchResult>;
} {
  const batchSize = deps.batchSize ?? 50;
  const maxAttempts = deps.maxAttempts ?? 8;
  const now = deps.now ?? (() => new Date());
  const notificationSender = deps.notificationSender;
  const outbox = (deps.client as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;

  async function markPublished(id: string): Promise<boolean> {
    // 条件更新：仅当仍 PENDING 时标记（并发/中断恢复下不覆盖其他处理器的结果）
    const { count } = await outbox.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'PUBLISHED', publishedAt: now(), lastError: null },
    });
    return count === 1;
  }

  async function markRetry(row: OutboxRow, err: unknown): Promise<'retried' | 'failed'> {
    const attempts = row.retryCount + 1;
    const terminal = attempts >= maxAttempts;
    const lastError = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
    await outbox.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { retryCount: attempts, lastError, status: terminal ? 'FAILED' : 'PENDING' },
    });
    return terminal ? 'failed' : 'retried';
  }

  return {
    async publishPendingBatch() {
      const batch = await outbox.findMany({
        where: {
          status: 'PENDING',
          eventType: notificationSender ? { in: ['ARCHIVE', ...Object.keys(NOTIFICATION_CATALOG)] } : 'ARCHIVE',
        },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
      });
      let published = 0;
      let retried = 0;
      let failed = 0;
      for (const row of batch) {
        try {
          if (row.eventType === 'ARCHIVE') {
            const message: ArchiveEventMessage = {
              eventId: row.id,
              eventType: row.eventType,
              aggregateType: row.aggregateType,
              aggregateId: row.aggregateId,
              payload: row.payload,
              createdAt: row.createdAt.toISOString(),
            };
            await deps.sender.send(message);
          } else {
            if (!notificationSender) throw new Error('Notification sender is not configured');
            const notification = notificationPayloadOf(row);
            await notificationSender.publish({
              topic: notification.topic,
              qos: 1,
              payload: JSON.stringify({
                meta: { id: `NTF-${row.id.toUpperCase()}`, ts: row.createdAt.toISOString(), schemaVer: '1.0' },
                data: notification.data,
              }),
            });
          }
        } catch (err) {
          // 发送失败（含发送后中断的误判：实际已送达则下游去重）：原子记录重试信息
          const result = await markRetry(row, err);
          if (result === 'failed') failed += 1;
          else retried += 1;
          continue;
        }
        if (await markPublished(row.id)) published += 1;
      }
      return { claimed: batch.length, published, retried, failed };
    },
  };
}
