/** Media registration core. Object I/O precedes the transaction; all durable writes share its commit. */
import { randomUUID } from 'node:crypto';
import type { DbClient, Prisma } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';
import { lockMediaDevice, lockMediaSession, lockMediaTrigger } from './registration-locks.js';
import { buildMediaObjectKey, parseMediaObjectKey, type MediaObjectStorage } from './storage.js';

export interface MediaUploadPolicyQuery {
  readonly getMediaTypes: () => readonly string[];
  readonly getMaxSizeKb: (mediaType: string) => number | undefined;
  readonly getDailyUploadQuotaPerDevice: () => number;
  readonly getUploadUrlTtlSeconds: () => number;
  readonly getDownloadUrlTtlSeconds: () => number;
}
export interface MediaMetadataDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
  readonly storage: MediaObjectStorage;
  readonly uploadPolicy: MediaUploadPolicyQuery;
  /** Trusted transport revalidates its principal after the device lock, before writing. */
  readonly validateAuthority?: (tx: DbClient) => Promise<void>;
}
export interface MediaMetadataMessage {
  readonly meta: { readonly id: string; readonly ts: string; readonly seq?: number };
  readonly data: Record<string, unknown>;
}
export interface MediaMetadataResult {
  readonly applied: boolean;
  readonly replayed?: boolean;
  readonly mediaId?: string;
  readonly reason?:
    | 'INVALID_MESSAGE'
    | 'DEVICE_NOT_FOUND'
    | 'FORBIDDEN_PATH'
    | 'UNKNOWN_SESSION'
    | 'SESSION_NOT_OPEN'
    | 'SESSION_EXPIRED'
    | 'METADATA_MISMATCH'
    | 'OBJECT_MISSING'
    | 'SIZE_MISMATCH'
    | 'HASH_MISMATCH'
    | 'REGISTRATION_INCOMPLETE';
}
type Session = Prisma.MediaUploadSessionGetPayload<object>;
type Media = Prisma.MediaObjectGetPayload<object>;
interface Declaration {
  readonly sourceMessageId: string;
  readonly mediaType: string;
  readonly captureTime: Date;
  readonly fileName: string;
  readonly objectPath: string;
  readonly sizeKb: number;
  readonly durationSec: number | null;
}
/** Internal, trusted preflight token; never accept this structure from a device/HTTP payload. */
export interface PreparedMediaMetadata {
  readonly deviceId: string;
  readonly customerId: string;
  readonly declaration: Declaration;
  readonly session: Session | null;
  readonly historicalMediaId?: string;
  readonly verifiedHash: string | null;
}
export type MediaMetadataPreparation =
  | { readonly ready: true; readonly prepared: PreparedMediaMetadata }
  | { readonly ready: false; readonly result: MediaMetadataResult };

export const MEDIA_EVIDENCE_REGISTERED = 'MEDIA_EVIDENCE_REGISTERED';
export const evidenceOutboxKey = (triggerId: string): string => `media-evidence:${triggerId}`;
const reject = (reason: NonNullable<MediaMetadataResult['reason']>): MediaMetadataResult => ({
  applied: false,
  reason,
});
const rejected = (reason: NonNullable<MediaMetadataResult['reason']>): MediaMetadataPreparation => ({
  ready: false,
  result: reject(reason),
});
function matchesMedia(row: Media, d: Declaration): boolean {
  return (
    row.mediaType === d.mediaType &&
    row.fileName === d.fileName &&
    row.objectPath === d.objectPath &&
    row.sizeKb === d.sizeKb &&
    row.captureTime.getTime() === d.captureTime.getTime() &&
    (row.durationSec ?? 0) === (d.durationSec ?? 0)
  );
}
function matchesSession(row: Session, d: Declaration): boolean {
  return (
    row.fileName === d.fileName &&
    row.mediaType === d.mediaType &&
    row.sizeKb === d.sizeKb &&
    d.objectPath ===
      buildMediaObjectKey({
        customerId: row.customerId,
        deviceId: row.deviceId,
        sessionId: row.id,
        fileName: row.fileName,
      }) &&
    (!row.triggerId || (d.durationSec ?? 0) === 0)
  );
}
function unchangedSession(a: Session, b: Session): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.customerId === b.customerId &&
    a.triggerId === b.triggerId &&
    a.sizeBytes === b.sizeBytes &&
    a.declaredSha256 === b.declaredSha256 &&
    a.presignedUrlExpiresAt.getTime() === b.presignedUrlExpiresAt.getTime() &&
    a.fileName === b.fileName &&
    a.mediaType === b.mediaType &&
    a.sizeKb === b.sizeKb
  );
}

/** S3 HEAD + streamed SHA-256 happen without SQL row locks in the production ingestion path. */
export async function prepareMediaMetadata(
  deps: MediaMetadataDeps,
  deviceId: string,
  message: MediaMetadataMessage,
): Promise<MediaMetadataPreparation> {
  const at = deps.now?.() ?? new Date();
  const data = message?.data;
  if (!data || typeof data !== 'object') return rejected('INVALID_MESSAGE');
  const { mediaType, captureTime, fileName, objectPath, sizeKb, durationSec } = data;
  const sourceMessageId = message.meta?.id;
  if (
    typeof sourceMessageId !== 'string' ||
    !sourceMessageId ||
    typeof mediaType !== 'string' ||
    !deps.uploadPolicy.getMediaTypes().includes(mediaType) ||
    typeof captureTime !== 'string' ||
    !Number.isFinite(Date.parse(captureTime)) ||
    typeof fileName !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(fileName) ||
    typeof objectPath !== 'string' ||
    !objectPath ||
    !Number.isInteger(sizeKb) ||
    Number(sizeKb) < 0 ||
    (durationSec !== undefined && (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec < 0))
  )
    return rejected('INVALID_MESSAGE');
  const declaration: Declaration = {
    sourceMessageId,
    mediaType,
    captureTime: new Date(captureTime),
    fileName,
    objectPath,
    sizeKb: sizeKb as number,
    durationSec: typeof durationSec === 'number' ? Math.floor(durationSec) : null,
  };
  const device = await deps.client.device.findUnique({ where: { id: deviceId } });
  if (!device) return rejected('DEVICE_NOT_FOUND');
  const parsed = parseMediaObjectKey(objectPath);
  if (!device.customerId || !parsed || parsed.deviceId !== deviceId || parsed.customerId !== device.customerId)
    return rejected('FORBIDDEN_PATH');
  const existing = await deps.client.mediaObject.findUnique({ where: { sourceMessageId } });
  if (existing && (existing.deviceId !== deviceId || existing.customerId !== device.customerId))
    return rejected('FORBIDDEN_PATH');
  if (existing && !matchesMedia(existing, declaration)) return rejected('METADATA_MISMATCH');
  // Pre-session legacy media remain readable/idempotent; do not synthesize a trigger or deadline.
  if (existing && !existing.uploadSessionId)
    return {
      ready: true,
      prepared: {
        deviceId,
        customerId: device.customerId,
        declaration,
        session: null,
        historicalMediaId: existing.id,
        verifiedHash: null,
      },
    };
  const session = await deps.client.mediaUploadSession.findUnique({ where: { id: parsed.sessionId } });
  if (!session || session.deviceId !== deviceId) return rejected('UNKNOWN_SESSION');
  if (session.customerId !== device.customerId) return rejected('FORBIDDEN_PATH');
  if (!matchesSession(session, declaration)) return rejected('METADATA_MISMATCH');
  const prepared: PreparedMediaMetadata = {
    deviceId,
    customerId: device.customerId,
    declaration,
    session,
    verifiedHash: null,
  };
  // Completed replay still gets full locked metadata/scope checks, but never needs the object again.
  if (session.status === 'COMPLETED') return { ready: true, prepared };
  if (session.status !== 'ISSUED') return rejected('SESSION_NOT_OPEN');
  if (session.presignedUrlExpiresAt <= at) return rejected('SESSION_EXPIRED');
  const stat = await deps.storage.statObject(objectPath);
  if (!stat) return rejected('OBJECT_MISSING');
  if (
    !Number.isSafeInteger(stat.sizeBytes) ||
    stat.sizeBytes < 1 ||
    (session.sizeBytes !== null
      ? stat.sizeBytes !== session.sizeBytes
      : Math.ceil(stat.sizeBytes / 1024) !== session.sizeKb)
  )
    return rejected('SIZE_MISMATCH');
  const hash = (await deps.storage.computeSha256(objectPath))?.toLowerCase();
  if (!hash || !/^[a-f0-9]{64}$/.test(hash) || hash !== session.declaredSha256?.toLowerCase())
    return rejected('HASH_MISMATCH');
  return { ready: true, prepared: { ...prepared, verifiedHash: hash } };
}

/** Caller must throw on !applied if this participates in a receipt transaction. */
export async function commitPreparedMediaMetadata(
  deps: MediaMetadataDeps,
  prepared: PreparedMediaMetadata,
): Promise<MediaMetadataResult> {
  return withTransaction(deps.client, async (tx) => {
    const { deviceId, customerId, declaration: d } = prepared;
    await lockMediaDevice(tx, deviceId);
    await deps.validateAuthority?.(tx);
    const device = await tx.device.findUnique({ where: { id: deviceId } });
    if (!device) return reject('DEVICE_NOT_FOUND');
    if (device.customerId !== customerId || !['Active', 'Maintenance'].includes(device.lifecycleStatus))
      return reject('FORBIDDEN_PATH');
    if (!prepared.session) {
      const historical = await tx.mediaObject.findUnique({ where: { id: prepared.historicalMediaId! } });
      return historical &&
        !historical.uploadSessionId &&
        historical.deviceId === deviceId &&
        historical.customerId === customerId &&
        historical.sourceMessageId === d.sourceMessageId &&
        matchesMedia(historical, d)
        ? { applied: true, replayed: true, mediaId: historical.id }
        : reject('METADATA_MISMATCH');
    }
    if (prepared.session.triggerId) await lockMediaTrigger(tx, prepared.session.triggerId);
    await lockMediaSession(tx, prepared.session.id);
    const session = await tx.mediaUploadSession.findUnique({ where: { id: prepared.session.id } });
    if (!session || !unchangedSession(session, prepared.session) || !matchesSession(session, d))
      return reject('METADATA_MISMATCH');
    const trigger = session.triggerId ? await tx.mediaTrigger.findUnique({ where: { id: session.triggerId } }) : null;
    if (
      session.triggerId &&
      (!trigger ||
        trigger.customerId !== customerId ||
        trigger.deviceId !== deviceId ||
        trigger.mediaType !== 'IMAGE' ||
        trigger.fileName !== session.fileName ||
        trigger.sizeBytes !== session.sizeBytes ||
        trigger.sizeKb !== session.sizeKb ||
        trigger.sha256Normalized !== session.declaredSha256?.toLowerCase())
    )
      return reject('METADATA_MISMATCH');
    const bySource = await tx.mediaObject.findUnique({ where: { sourceMessageId: d.sourceMessageId } });
    if (bySource && (bySource.deviceId !== deviceId || bySource.customerId !== customerId))
      return reject('FORBIDDEN_PATH');
    if (bySource && (bySource.uploadSessionId !== session.id || !matchesMedia(bySource, d)))
      return reject('METADATA_MISMATCH');
    const bySession = await tx.mediaObject.findUnique({ where: { uploadSessionId: session.id } });
    if (session.status === 'COMPLETED') {
      if (!bySession || !matchesMedia(bySession, d)) return reject('METADATA_MISMATCH');
      if (trigger) {
        const evidence = await tx.mediaEvidence.findUnique({ where: { triggerId: trigger.id } });
        const outbox = await tx.outboxEvent.findUnique({ where: { idempotencyKey: evidenceOutboxKey(trigger.id) } });
        if (
          !evidence ||
          evidence.mediaId !== bySession.id ||
          !outbox ||
          outbox.aggregateId !== evidence.id ||
          outbox.eventType !== MEDIA_EVIDENCE_REGISTERED
        )
          return reject('REGISTRATION_INCOMPLETE');
      }
      return { applied: true, replayed: true, mediaId: bySession.id };
    }
    const at = deps.now?.() ?? new Date(); // freshness after all lock waits and external I/O
    if (session.status !== 'ISSUED') return reject('SESSION_NOT_OPEN');
    if (session.presignedUrlExpiresAt <= at) return reject('SESSION_EXPIRED');
    if (bySession || (trigger && (await tx.mediaEvidence.findUnique({ where: { triggerId: trigger.id } }))))
      return reject('SESSION_NOT_OPEN');
    if (!prepared.verifiedHash || prepared.verifiedHash !== session.declaredSha256?.toLowerCase())
      return reject('HASH_MISMATCH');
    await tx.mediaUploadSession.update({ where: { id: session.id }, data: { status: 'COMPLETED', completedAt: at } });
    const mediaId = randomUUID();
    await tx.mediaObject.create({
      data: {
        id: mediaId,
        deviceId,
        customerId,
        uploadSessionId: session.id,
        mediaType: session.mediaType,
        captureTime: d.captureTime,
        fileName: session.fileName,
        objectPath: d.objectPath,
        sizeKb: session.sizeKb,
        durationSec: d.durationSec,
        sha256: prepared.verifiedHash,
        status: 'AVAILABLE',
        sourceMessageId: d.sourceMessageId,
        createdAt: at,
      },
    });
    if (trigger) {
      const deadlineAt = new Date(at.getTime() + 86_400_000);
      const evidence = await tx.mediaEvidence.create({
        data: {
          id: randomUUID(),
          triggerId: trigger.id,
          mediaId,
          customerId,
          deviceId,
          kind: trigger.kind,
          messageId: trigger.messageId,
          status: 'PENDING',
          registeredAt: at,
          deadlineAt,
          nextAttemptAt: at,
          attemptCount: 0,
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventType: MEDIA_EVIDENCE_REGISTERED,
          aggregateType: 'media_evidence',
          aggregateId: evidence.id,
          idempotencyKey: evidenceOutboxKey(trigger.id),
          payload: {
            schemaVersion: 1,
            evidenceId: evidence.id,
            triggerId: trigger.id,
            mediaId,
            customerId,
            deviceId,
            triggerRef: { kind: trigger.kind, messageId: trigger.messageId },
            registeredAt: at.toISOString(),
            deadlineAt: deadlineAt.toISOString(),
          },
          createdAt: at,
        },
      });
    }
    await recordAudit(tx, {
      objectType: 'media_object',
      objectId: mediaId,
      action: 'media.object.register',
      reason: `session=${session.id} mediaType=${session.mediaType}`,
      actorId: deviceId,
      customerId,
      afterValue: { mediaId, deviceId, mediaType: session.mediaType, sizeKb: session.sizeKb },
      result: 'SUCCESS',
    });
    return { applied: true, replayed: false, mediaId };
  });
}

/** Compatibility entry for trusted service callers; transport owns the receipt transaction. */
export async function handleMediaMetadata(
  deps: MediaMetadataDeps,
  deviceId: string,
  message: MediaMetadataMessage,
): Promise<MediaMetadataResult> {
  for (let attempt = 0; ; attempt++) {
    const preparation = await prepareMediaMetadata(deps, deviceId, message);
    if (!preparation.ready) return preparation.result;
    try {
      return await commitPreparedMediaMetadata(deps, preparation.prepared);
    } catch (error) {
      // Never recover inside an aborted caller-owned PostgreSQL transaction.
      if (
        attempt ||
        typeof (deps.client as { $connect?: unknown }).$connect !== 'function' ||
        (error as { code?: string })?.code !== 'P2002'
      )
        throw error;
    }
  }
}
