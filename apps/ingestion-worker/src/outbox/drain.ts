import type { PublishBatchResult } from './leased-publisher.js';

/** Bound sequential batches to one pool and stop on retry, idle, or invocation deadline. */
export async function drainArchiveBatches(
  publish: () => Promise<PublishBatchResult>,
  options: { maxBatches?: number; maxElapsedMs?: number; remainingMs?: () => number; clock?: () => number } = {},
): Promise<PublishBatchResult & { batches: number; stop: 'IDLE' | 'RETRY' | 'BUDGET' }> {
  const {
    maxBatches = 8,
    maxElapsedMs = 45000,
    remainingMs = () => Infinity,
    clock = () => performance.now(),
  } = options;
  if (
    !Number.isInteger(maxBatches) ||
    maxBatches < 1 ||
    maxBatches > 20 ||
    !Number.isFinite(maxElapsedMs) ||
    maxElapsedMs < 1 ||
    maxElapsedMs > 50000
  )
    throw Error('INVALID_ARCHIVE_DRAIN_BUDGET');
  const started = clock();
  const total = {
    claimed: 0,
    published: 0,
    retried: 0,
    failed: 0,
    batches: 0,
    stop: 'BUDGET' as 'IDLE' | 'RETRY' | 'BUDGET',
  };
  while (total.batches < maxBatches && clock() - started < maxElapsedMs && remainingMs() > 10000) {
    const batch = await publish();
    total.batches++;
    for (const key of ['claimed', 'published', 'retried', 'failed'] as const) total[key] += batch[key];
    if (batch.retried || batch.failed) {
      total.stop = 'RETRY';
      break;
    }
    if (!batch.claimed) {
      total.stop = 'IDLE';
      break;
    }
  }
  return total;
}
