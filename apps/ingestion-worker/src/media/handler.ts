/** BE-IOT-09: preflight outside SQL; receipt + registration + evidence/outbox commit together. */
import { createRedactingLogger } from '@fdp/observability';
import type { DbClient } from '@fdp/database';
import { commitPreparedMediaMetadata, prepareMediaMetadata, resolveMediaEvidence } from '@fdp/media';
import type { MediaMetadataMessage, MediaObjectStorage, MediaUploadPolicyQuery } from '@fdp/media';
import { hashPayload, idempotencyKeyOf, processWithReceipt } from '../ingest/receipt.js';
import { quarantineError } from '../ingest/errors.js';
import { resolveDeviceContext } from '../ingest/identity.js';
import type { ValidatedMessage } from '../ingest/pipeline.js';

export interface MediaHandlerDeps {
  readonly client: DbClient;
  readonly storage: MediaObjectStorage;
  readonly uploadPolicy: MediaUploadPolicyQuery;
  readonly now?: () => Date;
}

export function createMediaHandler(deps: MediaHandlerDeps) {
  return async (message: ValidatedMessage): Promise<{ readonly handled: boolean }> => {
    if (message.envelope.iotType !== 'media') return { handled: false };
    const meta = message.envelope.payload.meta as Record<string, unknown>;
    const key = { deviceId: message.device.deviceId, topicType: 'media', seq: Number(meta.seq) };
    const metadata = message.normalizedPayload as unknown as MediaMetadataMessage;
    // A known receipt is resolved by processWithReceipt, without requiring S3 to remain available.
    // This read is an optimization only; the receipt unique key/advisory lock remains authoritative.
    for (let attempt = 0; ; attempt++) {
      const known = await deps.client.ingestionReceipt.findUnique({ where: { idempotencyKey: idempotencyKeyOf(key) } });
      const preparation = known ? null : await prepareMediaMetadata(deps, key.deviceId, metadata);
      try {
        const processed = await processWithReceipt(deps.client, {
          key,
          payloadHash: hashPayload(message.normalizedPayload),
          receivedAtMs: message.envelope.iotReceivedAt,
          occurredAt: new Date(message.occurredAt),
          customerId: message.device.customerId,
          siteId: message.device.siteId ?? null,
          ...(deps.now ? { now: deps.now } : {}),
          business: async (tx, attribution) => {
            if (!preparation) throw new Error('MEDIA_RECEIPT_CHANGED');
            const registered = preparation.ready
              ? await commitPreparedMediaMetadata(
                  {
                    ...deps,
                    client: tx,
                    validateAuthority: async (lockedTx) => {
                      const fresh = await resolveDeviceContext(lockedTx, message.envelope, deps.now?.() ?? new Date());
                      if (fresh.customerId !== message.device.customerId || attribution.customerId !== fresh.customerId)
                        throw quarantineError('MEDIA_METADATA_REJECTED', 'data.objectPath', 'media ownership changed');
                    },
                  },
                  preparation.prepared,
                )
              : preparation.result;
            if (!registered.applied) {
              const reason = registered.reason ?? 'INVALID_MESSAGE';
              throw quarantineError(
                reason === 'SESSION_EXPIRED' ? 'MEDIA_SESSION_EXPIRED' : 'MEDIA_METADATA_REJECTED',
                'data.objectPath',
                `media metadata rejected: ${reason}`,
              );
            }
            return registered;
          },
        });
        // Only the owner of a committed root transaction may start the immediate first attempt.
        // Failure here cannot roll back registration; the durable Outbox/minute scan remains authoritative recovery.
        if (
          processed.result?.applied &&
          !processed.result.replayed &&
          processed.result.mediaId &&
          typeof (deps.client as { $connect?: unknown }).$connect === 'function'
        ) {
          try {
            const evidence = await deps.client.mediaEvidence.findUnique({
              where: { mediaId: processed.result.mediaId },
            });
            if (evidence) await resolveMediaEvidence(deps, evidence.id);
          } catch {
            createRedactingLogger(console).warn(JSON.stringify({ event: 'media.evidence.immediate_retry_pending' }));
          }
        }
        return { handled: true };
      } catch (error) {
        // Cross-device sourceMessageId collision may lose a unique insert. Recheck only after
        // the outer transaction rolls back; never query inside an aborted transaction.
        if (
          attempt ||
          typeof (deps.client as { $connect?: unknown }).$connect !== 'function' ||
          (error as { code?: string })?.code !== 'P2002'
        )
          throw error;
      }
    }
  };
}
