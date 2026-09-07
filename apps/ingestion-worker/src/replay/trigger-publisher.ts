import type { JsonMessageSender } from '@fdp/aws-clients';
import type { DbClient } from '@fdp/database';

export const REPLAY_JOB_REQUESTED = 'REPLAY_JOB_REQUESTED';

export interface ReplayTriggerPublishResult {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  readonly failed: number;
}

interface ReplayOutboxRow {
  readonly id: string;
  readonly aggregateId: string;
  readonly retryCount: number;
}

interface ReplayOutboxDelegate {
  findMany(args: Record<string, unknown>): Promise<ReplayOutboxRow[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

/** 将 replay job 的事务 Outbox 可靠发布到专用队列；发送后中断允许重复，Worker 按状态幂等。 */
export function createReplayTriggerPublisher(deps: {
  readonly client: DbClient;
  readonly sender: JsonMessageSender;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly now?: () => Date;
}): { publishPendingBatch(): Promise<ReplayTriggerPublishResult> } {
  const outbox = (deps.client as unknown as Record<string, unknown>).outboxEvent as ReplayOutboxDelegate;
  const batchSize = deps.batchSize ?? 50;
  const maxAttempts = deps.maxAttempts ?? 8;
  const now = deps.now ?? (() => new Date());

  return {
    async publishPendingBatch() {
      const batch = await outbox.findMany({
        where: { status: 'PENDING', eventType: REPLAY_JOB_REQUESTED },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
      });
      let published = 0;
      let retried = 0;
      let failed = 0;
      for (const row of batch) {
        try {
          await deps.sender.send({ jobId: row.aggregateId });
          const result = await outbox.updateMany({
            where: { id: row.id, status: 'PENDING' },
            data: { status: 'PUBLISHED', publishedAt: now(), lastError: null },
          });
          if (result.count === 1) published += 1;
        } catch (error) {
          const attempts = row.retryCount + 1;
          const terminal = attempts >= maxAttempts;
          await outbox.updateMany({
            where: { id: row.id, status: 'PENDING' },
            data: {
              status: terminal ? 'FAILED' : 'PENDING',
              retryCount: attempts,
              lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            },
          });
          if (terminal) failed += 1;
          else retried += 1;
        }
      }
      return { claimed: batch.length, published, retried, failed };
    },
  };
}
