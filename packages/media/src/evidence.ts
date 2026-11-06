/** IMG-12: resolve immutable evidence against the original source, independently of current device ownership. */
import type { DbClient } from '@fdp/database';
import { withTransaction } from '@fdp/database';

export interface EvidenceResolverDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}
export type EvidenceResolution = 'LINKED' | 'UNMATCHED' | 'PENDING' | 'NOT_DUE' | 'TERMINAL' | 'NOT_FOUND';
export const EVIDENCE_RETRY_MS = 60_000;

export async function resolveMediaEvidence(
  deps: EvidenceResolverDeps,
  evidenceId: string,
): Promise<EvidenceResolution> {
  const now = deps.now ?? (() => new Date());
  return withTransaction(deps.client, async (tx) => {
    // Registration never locks Evidence after locking a source. All resolvers use Evidence -> source KEY SHARE.
    await tx.$queryRawUnsafe('SELECT id FROM media_evidence WHERE id = $1 FOR UPDATE', evidenceId);
    const evidence = await tx.mediaEvidence.findUnique({ where: { id: evidenceId } });
    if (!evidence) return 'NOT_FOUND';
    if (evidence.status !== 'PENDING') return 'TERMINAL';
    const at = now();
    if (evidence.deadlineAt > at && evidence.nextAttemptAt && evidence.nextAttemptAt > at) return 'NOT_DUE';
    let targetId: string | null = null;
    let failureReason: string | null = null;
    if (evidence.deadlineAt <= at) failureReason = 'SOURCE_TIMEOUT';
    else {
      // Static SQL identifiers, parameterized messageId. KEY SHARE keeps the composite scope key stable until commit.
      const rows =
        evidence.kind === 'ALARM'
          ? await tx.$queryRawUnsafe<Array<{ id: string; customer_id: string; device_id: string }>>(
              'SELECT id, customer_id, device_id FROM alarms WHERE source_message_id = $1 FOR KEY SHARE',
              evidence.messageId,
            )
          : await tx.$queryRawUnsafe<Array<{ id: string; customer_id: string; device_id: string }>>(
              'SELECT id, customer_id, device_id FROM device_events WHERE source_message_id = $1 FOR KEY SHARE',
              evidence.messageId,
            );
      const target = rows[0];
      if (target) {
        if (target.customer_id !== evidence.customerId || target.device_id !== evidence.deviceId)
          failureReason = 'SOURCE_SCOPE_MISMATCH';
        else targetId = target.id; // An alarm now CLEARED still retains its original ACTIVE sourceMessageId.
      } else if (evidence.kind === 'ALARM') {
        // CLEARED creates no Alarm row. Its committed ARCHIVE mapped columns retain the original message disposition.
        // The partial expression index covers this lookup; do not scan arbitrary raw MQTT payloads.
        const clears = await tx.$queryRawUnsafe<Array<{ customer_id: string; device_id: string }>>(
          `
          SELECT payload->>'customerId' AS customer_id, aggregate_id AS device_id FROM outbox_events
          WHERE event_type = 'ARCHIVE' AND payload->>'topicType' = 'alarm'
            AND payload->'columns'->>'status' = 'CLEARED' AND payload->>'messageId' = $1
          ORDER BY CASE WHEN aggregate_id = $2 AND payload->>'customerId' = $3 THEN 0 ELSE 1 END, id LIMIT 1`,
          evidence.messageId,
          evidence.deviceId,
          evidence.customerId,
        );
        if (clears[0])
          failureReason =
            clears[0].customer_id === evidence.customerId && clears[0].device_id === evidence.deviceId
              ? 'CLEARED_MESSAGE_REFERENCE'
              : 'SOURCE_SCOPE_MISMATCH';
      }
    }
    const completedAt = now(); // Deadline wins, including lock waits and reads crossing the boundary.
    if (evidence.deadlineAt <= completedAt) {
      failureReason = 'SOURCE_TIMEOUT';
      targetId = null;
    }
    const status = failureReason ? 'UNMATCHED' : targetId ? 'LINKED' : 'PENDING';
    const nextAttemptAt =
      status === 'PENDING'
        ? new Date(Math.min(completedAt.getTime() + EVIDENCE_RETRY_MS, evidence.deadlineAt.getTime()))
        : null;
    const updated = await tx.mediaEvidence.updateMany({
      where: { id: evidence.id, status: 'PENDING', attemptCount: evidence.attemptCount },
      data: {
        status,
        failureReason,
        nextAttemptAt,
        attemptCount: { increment: 1 },
        updatedAt: completedAt,
        alarmId: targetId && evidence.kind === 'ALARM' ? targetId : null,
        eventId: targetId && evidence.kind === 'EVENT' ? targetId : null,
      },
    });
    if (updated.count !== 1) throw new Error('MEDIA_EVIDENCE_CONCURRENT_UPDATE');
    return status;
  });
}
