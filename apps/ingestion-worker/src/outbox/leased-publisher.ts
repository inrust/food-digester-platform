import { randomUUID } from 'node:crypto';
import type { DbClient } from '@fdp/database';

export interface PublishBatchResult {
  /** 本轮成功取得租约的事件数。 */
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly failed: number;
}

export interface OutboxRow {
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

export interface LeasedPublisherDeps {
  readonly client: DbClient;
  readonly eventTypes: readonly string[];
  readonly send: (row: OutboxRow) => Promise<void>;
  readonly batchSize?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly leaseMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly leaseToken?: (() => string) | undefined;
}

const MAX_ERROR_LENGTH = 500;

/**
 * 用逐行条件更新取得可恢复租约。候选查询可以并发返回同一行，但只有一个 Publisher
 * 能把自己的 leaseToken 写入；发送失败后的 retryCount 也由数据库原子 increment。
 */
export function createLeasedOutboxPublisher(deps: LeasedPublisherDeps): {
  publishPendingBatch(): Promise<PublishBatchResult>;
} {
  const outbox = (deps.client as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
  const batchSize = deps.batchSize ?? 50;
  const maxAttempts = deps.maxAttempts ?? 8;
  const leaseMs = deps.leaseMs ?? 5 * 60_000;
  const now = deps.now ?? (() => new Date());
  const newLeaseToken = deps.leaseToken ?? randomUUID;
  const eventTypeWhere = deps.eventTypes.length === 1 ? deps.eventTypes[0] : { in: [...deps.eventTypes] };

  if (batchSize <= 0 || maxAttempts <= 0 || leaseMs <= 0) {
    throw new Error('batchSize、maxAttempts 和 leaseMs 必须为正数');
  }

  return {
    async publishPendingBatch() {
      const claimAt = now();
      const leaseUntil = new Date(claimAt.getTime() + leaseMs);
      const leaseAvailable = { OR: [{ leaseUntil: null }, { leaseUntil: { lte: claimAt } }] };

      const candidates = await outbox.findMany({
        where: {
          status: 'PENDING',
          eventType: eventTypeWhere,
          retryCount: { lt: maxAttempts },
          ...leaseAvailable,
        },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
      });

      let claimed = 0;
      let published = 0;
      let retried = 0;
      let failed = 0;
      for (const candidate of candidates) {
        const token = newLeaseToken();
        const claim = await outbox.updateMany({
          where: {
            id: candidate.id,
            status: 'PENDING',
            retryCount: candidate.retryCount,
            ...leaseAvailable,
          },
          data: {
            leaseToken: token,
            leaseUntil,
            lastAttemptAt: claimAt,
          },
        });
        if (claim.count !== 1) continue;
        claimed += 1;

        const attempts = candidate.retryCount + 1;
        try {
          await deps.send(candidate);
        } catch (error) {
          const terminal = attempts >= maxAttempts;
          const lastError = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
          const result = await outbox.updateMany({
            where: { id: candidate.id, status: 'PENDING', leaseToken: token },
            data: {
              status: terminal ? 'FAILED' : 'PENDING',
              leaseToken: null,
              leaseUntil: null,
              retryCount: { increment: 1 },
              lastError,
            },
          });
          if (result.count === 1) {
            if (terminal) failed += 1;
            else retried += 1;
          }
          continue;
        }

        const result = await outbox.updateMany({
          where: { id: candidate.id, status: 'PENDING', leaseToken: token },
          data: {
            status: 'PUBLISHED',
            publishedAt: now(),
            leaseToken: null,
            leaseUntil: null,
            lastError: null,
          },
        });
        if (result.count === 1) published += 1;
      }
      return { claimed, published, retried, failed };
    },
  };
}
