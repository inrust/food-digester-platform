/**
 * BE-IOT-07 Alarm Handler：Alarm ACTIVE/CLEARED 处理。
 *
 * - ACTIVE：插入新 Alarm 行（每次激活独立记录，保存历史），生成归档事件；
 * - CLEARED：条件关闭同设备同 code 的全部 ACTIVE 行（status→CLEARED + clearedAt=清除消息 detectedTime），
 *   生成归档事件；重复 CLEAR / 无 ACTIVE 行 → 幂等 no-op（clear-noop）；
 * - Event 消息不经过本 Handler（不误创建 Alarm 由类型路由保证）。
 */
import type { DbClient } from '@fdp/database';
import { quarantineError } from '../ingest/errors.js';
import { hashPayload, processWithReceipt } from '../ingest/receipt.js';
import type { ReceiptOutcome } from '../ingest/receipt.js';
import type { ValidatedMessage } from '../ingest/pipeline.js';
import { requireCustomerId, writeArchiveOutbox } from './archive.js';

export interface AlarmHandlerDeps {
  readonly client: DbClient;
}

export type AlarmAction = 'activated' | 'cleared' | 'clear-noop';

export interface AlarmHandleResult {
  readonly handled: boolean;
  readonly outcome: ReceiptOutcome | undefined;
  readonly action: AlarmAction | undefined;
  readonly archived: boolean;
}

const NOT_HANDLED: AlarmHandleResult = { handled: false, outcome: undefined, action: undefined, archived: false };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumberString(value: unknown): string | undefined {
  return typeof value === 'number' ? String(value) : undefined;
}

interface AlarmDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function alarms(client: DbClient): AlarmDelegate {
  return (client as unknown as Record<string, unknown>).alarm as AlarmDelegate;
}

export function createAlarmHandler(deps: AlarmHandlerDeps): (message: ValidatedMessage) => Promise<AlarmHandleResult> {
  return async (message) => {
    if (message.envelope.iotType !== 'alarm') return NOT_HANDLED;

    const data = message.data;
    const code = asString(data.code);
    const status = asString(data.status);
    if (!code || (status !== 'ACTIVE' && status !== 'CLEARED')) {
      throw quarantineError('INVALID_ENVELOPE', 'data.code', 'alarm missing code or has invalid status');
    }
    const detectedTime = asString(data.detectedTime) ?? message.occurredAt;

    const meta = message.envelope.payload.meta as Record<string, unknown>;
    const seq = Number(meta.seq);
    const deviceId = message.device.deviceId;
    const payloadHash = hashPayload(message.envelope.payload);
    const auditHash = ((message.audit as Record<string, unknown> | null)?.hash as string | undefined) ?? null;

    const processed = await processWithReceipt(deps.client, {
      key: { deviceId, topicType: 'alarm', seq },
      payloadHash,
      receivedAtMs: message.envelope.iotReceivedAt,
      business: async (tx) => {
        const customerId = requireCustomerId(message.device.customerId);
        let action: AlarmAction;
        let columns: Record<string, unknown>;
        if (status === 'ACTIVE') {
          columns = {
            deviceId,
            customerId,
            code,
            category: asString(data.category) ?? 'UNKNOWN',
            severity: asString(data.severity) ?? 'WARNING',
            status: 'ACTIVE',
            detectedTime: new Date(detectedTime),
            component: asString(data.component) ?? null,
            currentValue: asNumberString(data.currentValue) ?? null,
            threshold: asNumberString(data.threshold) ?? null,
            unit: asString(data.unit) ?? null,
            message: asString(data.message) ?? null,
            recommendedAction: asString(data.recommendedAction) ?? null,
            sourceMessageId: message.messageId,
          };
          await alarms(tx).create({ data: columns });
          action = 'activated';
        } else {
          // CLEARED：关闭同设备同 code 的全部 ACTIVE 行；重复 CLEAR/无 ACTIVE → 幂等 no-op
          const { count } = await alarms(tx).updateMany({
            where: { deviceId, code, status: 'ACTIVE' },
            data: { status: 'CLEARED', clearedAt: new Date(detectedTime) },
          });
          action = count > 0 ? 'cleared' : 'clear-noop';
          columns = {
            deviceId,
            customerId,
            code,
            status: 'CLEARED',
            clearedAt: new Date(detectedTime),
            closedCount: count,
          };
        }
        await writeArchiveOutbox(tx, {
          topicType: 'alarm',
          messageId: message.messageId,
          deviceId,
          customerId,
          occurredAt: message.occurredAt,
          receivedAtMs: message.envelope.iotReceivedAt,
          payloadHash,
          auditHash,
          columns,
          payload: message.envelope.payload,
        });
        return action;
      },
    });

    if (processed.outcome === 'DUPLICATE_SKIPPED') {
      return { handled: true, outcome: processed.outcome, action: undefined, archived: false };
    }
    return { handled: true, outcome: processed.outcome, action: processed.result, archived: true };
  };
}
