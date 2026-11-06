/** IMG-10: device -> immutable trigger -> sessions. Signing never changes stored expiry. */
import { randomUUID } from 'node:crypto';
import { lockMediaDevice, lockMediaTrigger } from '@fdp/media';
import { AuthError, verifyDeviceCertificate } from '@fdp/auth';
import type { ClientCertIdentity, DeviceAuthContext } from '@fdp/auth';
import { recordAudit, withTransaction } from '@fdp/database';
import type { DbClient, Prisma } from '@fdp/database';
import { createRedactingLogger } from '@fdp/observability';
import type { MediaDeps } from './service.js';
import { MediaError, mediaConflict, mediaForbidden, mediaValidationFailed } from './errors.js';
import { buildMediaObjectKey } from './storage.js';
import { parseStrictObject } from '../admin/shared/strict-object.js';

export interface MediaTriggerRef {
  readonly kind: 'EVENT' | 'ALARM';
  readonly messageId: string;
}
export interface CreateMediaUploadSessionInput {
  readonly mediaType: string;
  readonly fileName: string;
  readonly sizeKb: number;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly triggerRef?: MediaTriggerRef;
}
export interface MediaUploadSessionView {
  readonly sessionId: string;
  readonly mediaType: string;
  readonly fileName: string;
  readonly sizeKb: number;
  readonly sizeBytes: number;
  readonly objectPath: string;
  readonly uploadUrl: string;
  readonly uploadUrlExpiresAt: string;
  readonly createdAt: string;
  readonly triggerRef?: MediaTriggerRef;
}
export interface MediaUploadSessionOutcome {
  readonly status: 200 | 201;
  readonly view: MediaUploadSessionView;
}
type Session = Prisma.MediaUploadSessionGetPayload<object>;

export function parseMediaTriggerRef(value: unknown): MediaTriggerRef {
  const ref = parseStrictObject(value, ['kind', 'messageId'], mediaValidationFailed);
  if (
    (ref.kind !== 'EVENT' && ref.kind !== 'ALARM') ||
    typeof ref.messageId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(ref.messageId)
  ) {
    throw mediaValidationFailed('triggerRef must contain a valid kind and messageId');
  }
  return { kind: ref.kind, messageId: ref.messageId };
}
function eligible(auth: DeviceAuthContext): void {
  if (!auth.customerId || !['Active', 'Maintenance'].includes(auth.deviceLifecycleStatus))
    throw mediaForbidden('The device cannot upload media');
}
function validate(deps: MediaDeps, input: CreateMediaUploadSessionInput): MediaTriggerRef | undefined {
  if (!deps.uploadPolicy.getMediaTypes().includes(input.mediaType)) throw mediaValidationFailed('Invalid mediaType');
  if (typeof input.fileName !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(input.fileName))
    throw mediaValidationFailed('Invalid fileName');
  if (
    !Number.isInteger(input.sizeKb) ||
    input.sizeKb < 1 ||
    input.sizeKb > (deps.uploadPolicy.getMaxSizeKb(input.mediaType) ?? 0)
  )
    throw mediaValidationFailed('Invalid sizeKb');
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    Math.ceil(input.sizeBytes / 1024) !== input.sizeKb
  )
    throw mediaValidationFailed('Invalid sizeBytes');
  if (typeof input.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(input.sha256))
    throw mediaValidationFailed('Invalid sha256');
  if (!Object.hasOwn(input, 'triggerRef')) return undefined;
  const ref = parseMediaTriggerRef(input.triggerRef);
  if (input.mediaType !== 'IMAGE') throw mediaValidationFailed('triggerRef requires IMAGE');
  return ref;
}

async function lockAndRefresh(
  tx: DbClient,
  auth: DeviceAuthContext,
  now: () => Date,
  identity?: ClientCertIdentity,
): Promise<DeviceAuthContext> {
  await lockMediaDevice(tx, auth.deviceId);
  let fresh: DeviceAuthContext;
  if (identity) {
    fresh = await verifyDeviceCertificate(tx, identity, { requestedDeviceId: auth.deviceId, now: now() });
  } else {
    // Existing trusted service callers may supply their AUTH-03 context. HTTP always supplies identity.
    const device = await tx.device.findUnique({ where: { id: auth.deviceId } });
    if (!device) throw new AuthError('UNAUTHENTICATED');
    fresh = {
      ...auth,
      customerId: device.customerId,
      siteId: device.siteId,
      deviceLifecycleStatus: device.lifecycleStatus,
    };
  }
  eligible(fresh);
  if (fresh.customerId !== auth.customerId) throw mediaForbidden('Device assignment changed');
  return fresh;
}

/** Backward-compatible service view; transport uses the explicit outcome to select 200/201. */
export async function createMediaUploadSession(
  deps: MediaDeps,
  auth: DeviceAuthContext,
  input: CreateMediaUploadSessionInput,
  identity?: ClientCertIdentity,
): Promise<MediaUploadSessionView> {
  return (await createMediaUploadSessionOutcome(deps, auth, input, identity)).view;
}

export async function createMediaUploadSessionOutcome(
  deps: MediaDeps,
  auth: DeviceAuthContext,
  input: CreateMediaUploadSessionInput,
  identity?: ClientCertIdentity,
): Promise<MediaUploadSessionOutcome> {
  if (typeof (deps.client as { readonly $connect?: unknown }).$connect !== 'function')
    throw new Error('MEDIA_SESSION_REQUIRES_ROOT_CLIENT');
  eligible(auth);
  const ref = validate(deps, input);
  if (ref && !identity) throw new AuthError('UNAUTHENTICATED');
  const now = deps.now ?? (() => new Date());
  const candidateId = randomUUID();
  const normalizedHash = input.sha256.toLowerCase();
  let signing = false;
  try {
    const selected = await withTransaction(deps.client, async (tx): Promise<{ status: 200 | 201; row: Session }> => {
      const fresh = await lockAndRefresh(tx, auth, now, identity);
      const customerId = fresh.customerId!;
      let triggerId: string | null = null;
      if (ref) {
        let trigger = await tx.mediaTrigger.findUnique({
          where: {
            customerId_deviceId_kind_messageId: {
              customerId,
              deviceId: auth.deviceId,
              kind: ref.kind,
              messageId: ref.messageId,
            },
          },
        });
        if (!trigger)
          trigger = await tx.mediaTrigger.create({
            data: {
              customerId,
              deviceId: auth.deviceId,
              kind: ref.kind,
              messageId: ref.messageId,
              mediaType: input.mediaType,
              fileName: input.fileName,
              sizeBytes: input.sizeBytes,
              sizeKb: input.sizeKb,
              sha256Normalized: normalizedHash,
              createdAt: now(),
            },
          });
        // Serialize request writers, while permitting metadata's FK/declaration KEY SHARE read.
        await lockMediaTrigger(tx, trigger.id);
        triggerId = trigger.id;
        if (
          trigger.mediaType !== input.mediaType ||
          trigger.fileName !== input.fileName ||
          trigger.sizeBytes !== input.sizeBytes ||
          trigger.sizeKb !== input.sizeKb ||
          trigger.sha256Normalized !== normalizedHash
        )
          throw new MediaError('MEDIA_TRIGGER_CONFLICT', 'The trigger declaration differs');
        await tx.$queryRawUnsafe(
          'SELECT id FROM media_upload_sessions WHERE trigger_id = $1 ORDER BY created_at, id FOR UPDATE',
          trigger.id,
        );
        // MediaObject is the registration fact; it remains authoritative before IMG-11 adds Evidence.
        const registered = await tx.mediaObject.findFirst({
          where: { customerId, deviceId: auth.deviceId, uploadSession: { triggerId: trigger.id } },
          select: { id: true },
        });
        if (registered)
          throw new MediaError('MEDIA_ALREADY_REGISTERED', 'The trigger image is already registered', {
            mediaId: registered.id,
          });
        const completed = await tx.mediaUploadSession.findFirst({
          where: { triggerId: trigger.id, status: 'COMPLETED' },
          select: { id: true },
        });
        if (completed) throw new Error('MEDIA_REGISTRATION_INCOMPLETE');
        const current = await tx.mediaUploadSession.findFirst({ where: { triggerId: trigger.id, status: 'ISSUED' } });
        if (current && current.presignedUrlExpiresAt.getTime() > now().getTime()) {
          await recordAudit(tx, {
            objectType: 'media_upload_session',
            objectId: current.id,
            action: 'media.upload_session.reuse',
            actorId: auth.deviceId,
            customerId,
            afterValue: { triggerRef: ref },
            result: 'SUCCESS',
          });
          return { status: 200, row: current };
        }
        if (current) await tx.mediaUploadSession.update({ where: { id: current.id }, data: { status: 'EXPIRED' } });
      }
      // UTC quota counts every newly issued attempt (legacy/trigger, any customer/status).
      // Capture the timestamp after lock waits; reuse and registered replies never consume quota.
      const at = now();
      const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
      const end = new Date(start.getTime() + 86400000);
      const count = await tx.mediaUploadSession.count({
        where: { deviceId: auth.deviceId, createdAt: { gte: start, lt: end } },
      });
      if (count >= deps.uploadPolicy.getDailyUploadQuotaPerDevice())
        throw mediaConflict('The daily media upload quota for this device is exceeded');
      const row = await tx.mediaUploadSession.create({
        data: {
          id: candidateId,
          deviceId: auth.deviceId,
          customerId,
          mediaType: input.mediaType,
          fileName: input.fileName,
          sizeKb: input.sizeKb,
          sizeBytes: input.sizeBytes,
          declaredSha256: normalizedHash,
          triggerId,
          status: 'ISSUED',
          presignedUrlExpiresAt: new Date(at.getTime() + deps.uploadPolicy.getUploadUrlTtlSeconds() * 1000),
          createdAt: at,
        },
      });
      await recordAudit(tx, {
        objectType: 'media_upload_session',
        objectId: row.id,
        action: 'media.upload_session.create',
        actorId: auth.deviceId,
        customerId,
        reason: `mediaType=${input.mediaType} sizeKb=${input.sizeKb}`,
        afterValue: {
          sessionId: row.id,
          deviceId: auth.deviceId,
          mediaType: row.mediaType,
          fileName: row.fileName,
          sizeKb: row.sizeKb,
          status: row.status,
          ...(ref ? { triggerRef: ref } : {}),
        },
        result: 'SUCCESS',
      });
      return { status: 201, row };
    });
    const { row } = selected;
    if (row.sizeBytes === null || !row.declaredSha256 || row.presignedUrlExpiresAt.getTime() <= now().getTime())
      throw new Error('MEDIA_SESSION_UNUSABLE');
    const objectPath = buildMediaObjectKey({
      customerId: row.customerId,
      deviceId: row.deviceId,
      sessionId: row.id,
      fileName: row.fileName,
    });
    signing = true;
    const uploadUrl = await deps.urlSigner.signUpload({
      key: objectPath,
      expiresAt: row.presignedUrlExpiresAt,
      contentLength: row.sizeBytes,
      checksumSha256: row.declaredSha256,
    });
    if (row.presignedUrlExpiresAt.getTime() <= now().getTime()) throw new Error('MEDIA_SESSION_EXPIRED_DURING_SIGNING');
    return {
      status: selected.status,
      view: {
        sessionId: row.id,
        mediaType: row.mediaType,
        fileName: row.fileName,
        sizeKb: row.sizeKb,
        sizeBytes: row.sizeBytes,
        objectPath,
        uploadUrl,
        uploadUrlExpiresAt: row.presignedUrlExpiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        ...(ref ? { triggerRef: ref } : {}),
      },
    };
  } catch (error) {
    try {
      await recordAudit(deps.client, {
        objectType: 'media_upload_session',
        objectId: candidateId,
        action: signing ? 'media.upload_session.sign' : 'media.upload_session.create',
        actorId: auth.deviceId,
        customerId: auth.customerId,
        reason: error instanceof MediaError || error instanceof AuthError ? error.code : 'INTERNAL_ERROR',
        result: 'FAILURE',
      });
    } catch {
      createRedactingLogger(console).error('media.upload_session.failure-audit-unavailable');
    }
    throw error;
  }
}
