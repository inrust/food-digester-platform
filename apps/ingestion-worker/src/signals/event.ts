/**
 * BE-IOT-07 Event Handler：操作事件历史保存 + 归档。
 *
 * 仅写 device_events（eventType/userId/username/source/remarks/occurredAt=meta.ts），
 * 不创建 Alarm（事件与告警为不同信号通道）。
 */
import type { DbClient } from '@fdp/database';
import { hashPayload, processWithReceipt } from '../ingest/receipt.js';
import type { ReceiptOutcome } from '../ingest/receipt.js';
import type { ValidatedMessage } from '../ingest/pipeline.js';
import { requireCustomerId, writeArchiveOutbox } from './archive.js';

export interface EventHandlerDeps {
  readonly client: DbClient;
}

export interface EventHandleResult {
  readonly handled: boolean;
  readonly outcome: ReceiptOutcome | undefined;
  readonly archived: boolean;
}

const NOT_HANDLED: EventHandleResult = { handled: false, outcome: undefined, archived: false };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

interface DeviceEventDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

export function createEventHandler(deps: EventHandlerDeps): (message: ValidatedMessage) => Promise<EventHandleResult> {
  return async (message) => {
    if (message.envelope.iotType !== 'event') return NOT_HANDLED;

    const data = message.data;
    const meta = message.envelope.payload.meta as Record<string, unknown>;
    const seq = Number(meta.seq);
    const deviceId = message.device.deviceId;
    const payloadHash = hashPayload(message.envelope.payload);

    const processed = await processWithReceipt(deps.client, {
      key: { deviceId, topicType: 'event', seq },
      payloadHash,
      receivedAtMs: message.envelope.iotReceivedAt,
      business: async (tx) => {
        const customerId = requireCustomerId(message.device.customerId);
        const columns = {
          deviceId,
          customerId,
          eventType: asString(data.eventType) ?? 'UNKNOWN',
          userId: asString(data.userId) ?? null,
          username: asString(data.username) ?? null,
          source: asString(data.source) ?? null,
          remarks: asString(data.remarks) ?? null,
          occurredAt: new Date(message.occurredAt),
          sourceMessageId: message.messageId,
        };
        const events = (tx as unknown as Record<string, unknown>).deviceEvent as DeviceEventDelegate;
        await events.create({ data: columns });
        await writeArchiveOutbox(tx, {
          topicType: 'event',
          messageId: message.messageId,
          deviceId,
          customerId,
          occurredAt: message.occurredAt,
          receivedAtMs: message.envelope.iotReceivedAt,
          payloadHash,
          auditHash: ((message.audit as Record<string, unknown> | null)?.hash as string | undefined) ?? null,
          columns,
          payload: message.envelope.payload,
        });
      },
    });

    return { handled: true, outcome: processed.outcome, archived: processed.outcome === 'PROCESSED' };
  };
}
