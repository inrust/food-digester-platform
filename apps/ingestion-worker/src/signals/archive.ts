/**
 * BE-IOT-07 共享：归档 outbox 写入（Alarm/Event/Tamper 三个 Handler 同源）。
 * 载荷含原始 Payload、payloadHash、audit.hash（Tamper 强制，DEC-002）与映射列。
 */
import type { DbClient } from '@fdp/database';
import { quarantineError } from '../ingest/errors.js';

export interface ArchiveOutboxParams {
  readonly topicType: 'alarm' | 'event' | 'tamper';
  readonly messageId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly occurredAt: string;
  readonly receivedAtMs: number;
  readonly payloadHash: string;
  readonly auditHash: string | null;
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
        topicType: params.topicType,
        messageId: params.messageId,
        deviceId: params.deviceId,
        customerId: params.customerId,
        occurredAt: params.occurredAt,
        receivedAtMs: params.receivedAtMs,
        payloadHash: params.payloadHash,
        auditHash: params.auditHash,
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
