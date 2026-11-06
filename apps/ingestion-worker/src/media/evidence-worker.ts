/** Durable evidence Outbox route plus bounded keyset retry scan. No image/S3/IoT access is needed. */
import type { DbClient } from '@fdp/database';
import { evidenceOutboxKey, MEDIA_EVIDENCE_REGISTERED, resolveMediaEvidence } from '@fdp/media';
import type { EvidenceResolverDeps } from '@fdp/media';
import { createLeasedOutboxPublisher } from '../outbox/leased-publisher.js';
import type { OutboxRow } from '../outbox/leased-publisher.js';

export async function consumeMediaEvidenceOutbox(deps: EvidenceResolverDeps, event: OutboxRow): Promise<void> {
  // Read the durable event rather than accepting queue/body supplied scope or target IDs.
  const stored = await deps.client.outboxEvent.findUnique({ where: { id: event.id } });
  const payload = stored?.payload as { schemaVersion?: unknown; evidenceId?: unknown } | null;
  if (
    !stored ||
    stored.eventType !== MEDIA_EVIDENCE_REGISTERED ||
    stored.aggregateType !== 'media_evidence' ||
    payload?.schemaVersion !== 1 ||
    payload.evidenceId !== stored.aggregateId
  )
    throw new Error('INVALID_MEDIA_EVIDENCE_EVENT');
  const evidence = await deps.client.mediaEvidence.findUnique({ where: { id: stored.aggregateId } });
  if (!evidence || stored.idempotencyKey !== evidenceOutboxKey(evidence.triggerId))
    throw new Error('INVALID_MEDIA_EVIDENCE_EVENT');
  await resolveMediaEvidence(deps, evidence.id);
}

export interface EvidenceScanOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly shouldContinue?: () => boolean;
}
export interface EvidenceScanResult {
  pages: number;
  visited: number;
  linked: number;
  unmatched: number;
  pending: number;
  skipped: number;
  failed: number;
  stop: 'IDLE' | 'BUDGET';
}
export async function scanPendingMediaEvidence(
  deps: EvidenceResolverDeps,
  options: EvidenceScanOptions = {},
): Promise<EvidenceScanResult> {
  const pageSize = options.pageSize ?? 50,
    maxPages = options.maxPages ?? 5;
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100 ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 20
  )
    throw new Error('INVALID_MEDIA_EVIDENCE_SCAN_BUDGET');
  const cutoff = deps.now?.() ?? new Date();
  let cursor: { nextAttemptAt: Date; id: string } | undefined;
  const result: EvidenceScanResult = {
    pages: 0,
    visited: 0,
    linked: 0,
    unmatched: 0,
    pending: 0,
    skipped: 0,
    failed: 0,
    stop: 'BUDGET',
  };
  while (result.pages < maxPages && options.shouldContinue?.() !== false) {
    const rows = await deps.client.mediaEvidence.findMany({
      where: {
        status: 'PENDING',
        nextAttemptAt: { lte: cutoff },
        ...(cursor
          ? {
              OR: [
                { nextAttemptAt: { gt: cursor.nextAttemptAt } },
                { nextAttemptAt: cursor.nextAttemptAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
      select: { id: true, nextAttemptAt: true },
    });
    result.pages++;
    for (const row of rows) {
      if (options.shouldContinue?.() === false) return result;
      // Retain the original tuple: resolving advances nextAttemptAt or makes this row terminal.
      cursor = { id: row.id, nextAttemptAt: row.nextAttemptAt! };
      result.visited++;
      try {
        const outcome = await resolveMediaEvidence(deps, row.id);
        if (outcome === 'LINKED') result.linked++;
        else if (outcome === 'UNMATCHED') result.unmatched++;
        else if (outcome === 'PENDING') result.pending++;
        else result.skipped++;
      } catch {
        result.failed++;
      } // Other rows progress; runtime fails this invocation after its bounded scan.
    }
    if (rows.length < pageSize) {
      result.stop = 'IDLE';
      break;
    }
  }
  return result;
}

export interface EvidenceWorkerOptions extends EvidenceScanOptions {
  readonly clock?: () => number;
}
export async function runMediaEvidenceWorker(
  deps: EvidenceResolverDeps & { readonly client: DbClient },
  options: EvidenceWorkerOptions = {},
) {
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  // One time-bounded Outbox batch leaves a separate scan budget even under permanent publishing backlog.
  const outbox = await createLeasedOutboxPublisher({
    ...deps,
    batchSize: 50,
    eventTypes: [MEDIA_EVIDENCE_REGISTERED],
    send: (event) => consumeMediaEvidenceOutbox(deps, event),
    shouldContinue: () => options.shouldContinue?.() !== false && clock() - started < 15000,
  }).publishPendingBatch();
  const scan = await scanPendingMediaEvidence(deps, options);
  return { outbox, scan };
}
