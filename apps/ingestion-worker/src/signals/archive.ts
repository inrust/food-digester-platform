/**
 * BE-IOT-07 共享：归档 outbox 写入（Alarm/Event/Tamper 三个 Handler 同源）。
 * 载荷含原始 Payload、payloadHash、audit.hash（Tamper 强制，DEC-002）与映射列。
 */
import type { DbClient } from '@fdp/database';
import { quarantineError } from '../ingest/errors.js';

export interface ArchiveOutboxParams {
  readonly topicType: 'alarm' | 'event' | 'tamper' | 'ack';
  readonly messageId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly occurredAt: string;
  readonly receivedAtMs: number;
  readonly payloadHash: string;
  readonly auditHash: string | null;
  readonly rawBody: string;
  /** 与 RDS 行同源的映射列（可选）。 */
  readonly columns?: Record<string, unknown> | undefined;
  readonly payload: unknown;
}

interface OutboxDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

export async function writeArchiveOutbox(client: DbClient, params: ArchiveOutboxParams): Promise<void> {
  const outbox = (client as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
  await outbox.create({
    data: {
      eventType: 'ARCHIVE',
      aggregateType: 'device',
      aggregateId: params.deviceId,
      payload: {
        archiveClass: 'MQTT_RAW',
        envelopeVersion: '1.0',
        aggregateId: params.deviceId,
        topicType: params.topicType,
        messageId: params.messageId,
        deviceId: params.deviceId,
        customerId: params.customerId,
        occurredAt: params.occurredAt,
        receivedAtMs: params.receivedAtMs,
        payloadHash: params.payloadHash,
        auditHash: params.auditHash,
        rawBody: params.rawBody,
        columns: params.columns ?? null,
        payload: params.payload,
      },
    },
  });
}

/** 三表 customerId 均非空（DB-01）：未分配客户设备的消息隔离待 Replay（同 BE-IOT-05/06 决策）。 */
export function requireCustomerId(customerId: string | null): string {
  if (!customerId) {
    throw quarantineError('UNKNOWN_DEVICE', 'device.customerId', 'device has no customer assignment');
  }
  return customerId;
}

/**
 * BE-ALM-02 生产侧：Critical 业务告警领域事件（Alarm 激活 / Tamper），与业务行同事务提交。
 * 消费方为业务通知适配器（apps/cloud-api/src/notification/business-notifier）；
 * 载荷仅含白名单业务字段（通知内容不得含敏感凭据）。
 */
export const CRITICAL_ALERT_RAISED_EVENT = 'CRITICAL_ALERT_RAISED' as const;

export interface CriticalAlertPayload {
  readonly type: typeof CRITICAL_ALERT_RAISED_EVENT;
  readonly kind: 'alarm' | 'tamper';
  readonly alarmId?: string;
  readonly tamperEventId?: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly severity: 'CRITICAL';
  readonly occurredAt: string;
  // alarm 专属
  readonly code?: string;
  readonly category?: string;
  readonly message?: string | null;
  // tamper 专属
  readonly eventType?: string;
  readonly component?: string | null;
}

export async function writeCriticalAlertOutbox(client: DbClient, payload: CriticalAlertPayload): Promise<void> {
  const outbox = (client as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
  await outbox.create({
    data: {
      eventType: CRITICAL_ALERT_RAISED_EVENT,
      aggregateType: payload.kind,
      aggregateId: payload.alarmId ?? payload.tamperEventId ?? payload.deviceId,
      payload,
    },
  });
}
