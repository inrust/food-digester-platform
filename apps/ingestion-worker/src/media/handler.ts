/** BE-IOT-09 Media Handler：复用 BE-MED-01 核心并纳入 BE-IOT-03 receipt 事务。 */
import type { DbClient } from '@fdp/database';
import { handleMediaMetadata } from '@fdp/media';
import type { MediaMetadataMessage, MediaObjectStorage, MediaUploadPolicyQuery } from '@fdp/media';
import { hashPayload, processWithReceipt } from '../ingest/receipt.js';
import { quarantineError } from '../ingest/errors.js';
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
    const seq = Number(meta.seq);
    await processWithReceipt(deps.client, {
      key: { deviceId: message.device.deviceId, topicType: 'media', seq },
      payloadHash: hashPayload(message.normalizedPayload),
      receivedAtMs: message.envelope.iotReceivedAt,
      ...(deps.now ? { now: deps.now } : {}),
      business: async (tx) => {
        const registered = await handleMediaMetadata(
          {
            client: tx,
            storage: deps.storage,
            uploadPolicy: deps.uploadPolicy,
            ...(deps.now ? { now: deps.now } : {}),
          },
          message.device.deviceId,
          message.envelope.payload as unknown as MediaMetadataMessage,
        );
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
    return { handled: true };
  };
}
