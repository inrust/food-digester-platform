import { observeDataPathPhase, observeReceiptResult } from '@fdp/observability';
/**
 * BE-IOT-03 幂等收据服务（ingestion_receipts，DB-01 表结构）。
 *
 * - 幂等键：`{deviceId}:{topicType}:{seq}`（实施方案 9.2，idempotency_key 唯一约束兜底并发）；
 * - 相同键相同 Hash：DUPLICATE_SKIPPED，业务写入只执行一次（重复跳过）；
 * - 相同键不同 Hash：安全异常，抛 QUARANTINE/PAYLOAD_CONFLICT（冲突隔离），原 receipt 不覆盖；
 * - 业务写入、receipt、outbox 在同一事务（DB-02 withTransaction 嵌套复用）；
 * - receipt 落库后同事务做缺口检测（见 gap.ts；缺口为追加记录，不阻塞后续消息）。
 */
import { createHash } from 'node:crypto';
import type { DbClient } from '@fdp/database';
import { acquireTransactionLock, withTransaction } from '@fdp/database';
import { quarantineError } from './errors.js';
import { recordGapForNewReceipt } from './gap.js';

export interface ReceiptKey {
  readonly deviceId: string;
  readonly topicType: string;
  readonly seq: number;
}

export type ReceiptOutcome = 'PROCESSED' | 'DUPLICATE_SKIPPED';

export interface ProcessReceiptResult<T> {
  readonly outcome: ReceiptOutcome;
  /** outcome=PROCESSED 时为 business 返回值；DUPLICATE_SKIPPED 时为 undefined。 */
  readonly result: T | undefined;
}

export function idempotencyKeyOf(key: ReceiptKey): string {
  return `${key.deviceId}:${key.topicType}:${key.seq}`;
}

/** 规范化 JSON（对象键排序、剔除 undefined）的 SHA-256：同键 Payload Hash 比较基准。 */
export function hashPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export interface ProcessWithReceiptParams<T> {
  readonly key: ReceiptKey;
  readonly payloadHash: string;
  /** broker 接收时间（iotReceivedAt，epoch ms）；缺省当前时间。 */
  readonly receivedAtMs?: number;
  /** 设备事件时间；完整率和历史归属均以此时间为准。 */
  readonly occurredAt?: Date;
  /** 当前台账归属作为无历史 assignment 时的回退；绝不取 Payload。 */
  readonly customerId?: string | null;
  readonly siteId?: string | null;
  readonly now?: () => Date;
  /** 业务写入（与 receipt 同事务；重复消息不会执行）。 */
  readonly business: (tx: DbClient, attribution: EventAttribution) => Promise<T>;
  /** Outbox 事件写入（同事务；下行通知/归档事件）。 */
  readonly outbox?: (tx: DbClient) => Promise<void>;
}

export interface EventAttribution {
  readonly customerId: string | null;
  readonly siteId: string | null;
}

interface ReceiptDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findFirst(args: { where: Record<string, unknown> }): Promise<{ id?: string; payloadHash: string } | null>;
}

interface AssignmentDelegate {
  findFirst(args: { where: Record<string, unknown>; orderBy: Record<string, unknown> }): Promise<{
    customerId: string;
    siteId: string;
  } | null>;
}

function receipts(client: DbClient): ReceiptDelegate {
  return (client as unknown as Record<string, unknown>).ingestionReceipt as ReceiptDelegate;
}

/** Prisma 唯一约束冲突（P2002）。 */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

export async function processWithReceipt<T>(
  client: DbClient,
  params: ProcessWithReceiptParams<T>,
): Promise<ProcessReceiptResult<T>> {
  const now = params.now ?? (() => new Date());
  let receiptId: unknown;
  try {
    const processed = await observeDataPathPhase('db-transaction', () =>
      withTransaction(client, async (tx) =>
        observeDataPathPhase('db-transaction-callback', async () => {
          // 同设备同 Topic 串行化 receipt 与业务事务：同时消除 gap 漏检、Telemetry
          // 读改写丢增量和 Report 重叠检查的并发窗口。
          await observeDataPathPhase('db-lock', () =>
            acquireTransactionLock(tx, `ingestion:${params.key.deviceId}:${params.key.topicType}`),
          );
          const receivedAt = params.receivedAtMs !== undefined ? new Date(params.receivedAtMs) : now();
          const occurredAt = params.occurredAt ?? receivedAt;
          const assignment = await observeDataPathPhase('db-assignment', () =>
            ((tx as unknown as Record<string, unknown>).deviceAssignment as AssignmentDelegate).findFirst({
              where: {
                deviceId: params.key.deviceId,
                assignedAt: { lte: occurredAt },
                OR: [{ endedAt: null }, { endedAt: { gt: occurredAt } }],
              },
              orderBy: { assignedAt: 'desc' },
            }),
          );
          const attribution: EventAttribution = {
            customerId: assignment?.customerId ?? params.customerId ?? null,
            siteId: assignment?.siteId ?? params.siteId ?? null,
          };
          const created = await observeDataPathPhase('db-receipt', () =>
            receipts(tx).create({
              data: {
                idempotencyKey: idempotencyKeyOf(params.key),
                deviceId: params.key.deviceId,
                customerId: attribution.customerId,
                siteId: attribution.siteId,
                topicType: params.key.topicType,
                seq: params.key.seq,
                payloadHash: params.payloadHash,
                result: 'PROCESSED',
                receivedAt,
                occurredAt,
                processedAt: now(),
              },
            }),
          );
          receiptId = (created as { id?: unknown } | null)?.id;
          const result = await observeDataPathPhase('db-business', () => params.business(tx, attribution));
          if (params.outbox) await observeDataPathPhase('db-outbox', () => params.outbox!(tx));
          // 缺口检测同事务追加（纯信息记录，不阻塞本条及后续消息）
          await observeDataPathPhase('db-gap', () => recordGapForNewReceipt(tx, params.key));
          return { outcome: 'PROCESSED' as const, result };
        }),
      ),
    );
    observeReceiptResult('PROCESSED', receiptId, typeof (client as { $connect?: unknown }).$connect === 'function');
    return processed;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // 并发/重复：回读胜出记录比较 Hash（DB-02 P2002 幂等兜底模式）
    const existing = await observeDataPathPhase('duplicate-readback', () =>
      receipts(client).findFirst({
        where: { idempotencyKey: idempotencyKeyOf(params.key) },
      }),
    );
    if (existing && existing.payloadHash === params.payloadHash) {
      observeReceiptResult(
        'DUPLICATE_SKIPPED',
        existing.id,
        typeof (client as { $connect?: unknown }).$connect === 'function',
      );
      return { outcome: 'DUPLICATE_SKIPPED', result: undefined };
    }
    // 相同键不同 Hash = 安全异常：隔离冲突消息，不覆盖原 receipt
    throw quarantineError(
      'PAYLOAD_CONFLICT',
      'meta.seq',
      `receipt key ${idempotencyKeyOf(params.key)} already recorded with different payload hash (security anomaly)`,
    );
  }
}
