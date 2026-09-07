/**
 * BE-MED-01/BE-IOT-09 共用的 Media 元数据注册核心。
 * 可接收根 DbClient 或现有事务，因此 ingestion receipt、MediaObject、会话完成与审计
 * 能在同一事务提交。
 */
import { randomUUID } from 'node:crypto';
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';
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
    | 'HASH_MISMATCH';
}

interface MediaUploadSessionRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly mediaType: string;
  readonly fileName: string;
  readonly sizeKb: number;
  readonly declaredSha256: string | null;
  readonly status: string;
  readonly presignedUrlExpiresAt: Date;
}

interface MediaObjectRow {
  readonly id: string;
  readonly deviceId: string;
  readonly uploadSessionId: string | null;
}

interface TableDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<never>;
  create(args: { data: Record<string, unknown> }): Promise<never>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function table(client: DbClient, name: string): TableDelegate {
  return (client as unknown as Record<string, unknown>)[name] as TableDelegate;
}

const sessions = (client: DbClient) => table(client, 'mediaUploadSession');
const mediaObjects = (client: DbClient) => table(client, 'mediaObject');
const devices = (client: DbClient) => table(client, 'device');
const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function reject(reason: NonNullable<MediaMetadataResult['reason']>): MediaMetadataResult {
  return { applied: false, reason };
}

function isValidUtcDateTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

class SessionNoLongerOpenError extends Error {}

export async function handleMediaMetadata(
  deps: MediaMetadataDeps,
  deviceId: string,
  message: MediaMetadataMessage,
): Promise<MediaMetadataResult> {
  const validationNow = deps.now?.() ?? new Date();
  const data = message?.data;
  if (!data || typeof data !== 'object') return reject('INVALID_MESSAGE');
  const { mediaType, captureTime, fileName, objectPath, sizeKb, durationSec } = data;
  if (typeof mediaType !== 'string' || !deps.uploadPolicy.getMediaTypes().includes(mediaType)) {
    return reject('INVALID_MESSAGE');
  }
  if (!isValidUtcDateTime(captureTime)) return reject('INVALID_MESSAGE');
  if (typeof fileName !== 'string' || !FILE_NAME_PATTERN.test(fileName)) return reject('INVALID_MESSAGE');
  if (typeof objectPath !== 'string' || objectPath.length === 0) return reject('INVALID_MESSAGE');
  if (typeof sizeKb !== 'number' || !Number.isFinite(sizeKb) || sizeKb < 0) return reject('INVALID_MESSAGE');
  if (durationSec !== undefined && (typeof durationSec !== 'number' || durationSec < 0)) {
    return reject('INVALID_MESSAGE');
  }
  const sourceMessageId = message.meta?.id;
  if (typeof sourceMessageId !== 'string' || sourceMessageId.length === 0) return reject('INVALID_MESSAGE');

  const existing = (await mediaObjects(deps.client).findFirst({
    where: { sourceMessageId },
  })) as unknown as MediaObjectRow | null;
  if (existing) {
    return existing.deviceId === deviceId
      ? { applied: true, replayed: true, mediaId: existing.id }
      : reject('FORBIDDEN_PATH');
  }

  const device = (await devices(deps.client).findFirst({ where: { id: deviceId } })) as unknown as {
    id: string;
    customerId: string | null;
  } | null;
  if (!device) return reject('DEVICE_NOT_FOUND');

  const parsed = parseMediaObjectKey(objectPath);
  if (!parsed || parsed.deviceId !== deviceId || parsed.customerId !== device.customerId) {
    return reject('FORBIDDEN_PATH');
  }
  const session = (await sessions(deps.client).findFirst({
    where: { id: parsed.sessionId },
  })) as unknown as MediaUploadSessionRow | null;
  if (!session || session.deviceId !== deviceId) return reject('UNKNOWN_SESSION');
  if (session.status === 'COMPLETED') {
    const done = (await mediaObjects(deps.client).findFirst({
      where: { uploadSessionId: session.id },
    })) as unknown as MediaObjectRow | null;
    return done ? { applied: true, replayed: true, mediaId: done.id } : reject('SESSION_NOT_OPEN');
  }
  if (session.status !== 'ISSUED') return reject('SESSION_NOT_OPEN');
  if (session.presignedUrlExpiresAt.getTime() <= validationNow.getTime()) return reject('SESSION_EXPIRED');

  const expectedKey = buildMediaObjectKey({
    customerId: session.customerId,
    deviceId: session.deviceId,
    sessionId: session.id,
    fileName: session.fileName,
  });
  if (
    objectPath !== expectedKey ||
    session.fileName !== fileName ||
    session.mediaType !== mediaType ||
    session.sizeKb !== sizeKb
  ) {
    return reject('METADATA_MISMATCH');
  }

  const stat = await deps.storage.statObject(objectPath);
  if (!stat) return reject('OBJECT_MISSING');
  if (Math.ceil(stat.sizeBytes / 1024) !== session.sizeKb) return reject('SIZE_MISMATCH');
  const actualSha256 = await deps.storage.computeSha256(objectPath);
  const declaredSha256 = session.declaredSha256?.toLowerCase();
  if (!declaredSha256 || !actualSha256 || actualSha256.toLowerCase() !== declaredSha256) {
    return reject('HASH_MISMATCH');
  }

  const mediaId = randomUUID();
  const completionNow = deps.now?.() ?? new Date();
  try {
    return await withTransaction(deps.client, async (tx) => {
      // 先抢占仍有效的 ISSUED 会话；后续任一写入失败会回滚该状态更新。
      const completed = await sessions(tx).updateMany({
        where: {
          id: session.id,
          status: 'ISSUED',
          presignedUrlExpiresAt: { gt: completionNow },
        },
        data: { status: 'COMPLETED', completedAt: completionNow },
      });
      if (completed.count !== 1) throw new SessionNoLongerOpenError();
      await mediaObjects(tx).create({
        data: {
          id: mediaId,
          deviceId,
          customerId: session.customerId,
          uploadSessionId: session.id,
          mediaType: session.mediaType,
          captureTime: new Date(captureTime),
          fileName: session.fileName,
          objectPath,
          sizeKb: session.sizeKb,
          durationSec: typeof durationSec === 'number' ? Math.floor(durationSec) : null,
          sha256: declaredSha256,
          status: 'AVAILABLE',
          sourceMessageId,
          createdAt: completionNow,
        },
      });
      await recordAudit(tx, {
        objectType: 'media_object',
        objectId: mediaId,
        action: 'media.object.register',
        reason: `session=${session.id} mediaType=${session.mediaType}`,
        actorId: deviceId,
        customerId: session.customerId,
        afterValue: { mediaId, deviceId, mediaType: session.mediaType, sizeKb: session.sizeKb },
        result: 'SUCCESS',
      });
      return { applied: true, replayed: false, mediaId };
    });
  } catch (err) {
    if (err instanceof SessionNoLongerOpenError) {
      const current = (await sessions(deps.client).findFirst({
        where: { id: session.id },
      })) as unknown as MediaUploadSessionRow | null;
      return current?.status === 'ISSUED' && current.presignedUrlExpiresAt.getTime() <= completionNow.getTime()
        ? reject('SESSION_EXPIRED')
        : reject('SESSION_NOT_OPEN');
    }
    if ((err as { code?: string } | null)?.code === 'P2002') {
      const duplicate = (await mediaObjects(deps.client).findFirst({
        where: { sourceMessageId },
      })) as unknown as MediaObjectRow | null;
      if (duplicate) return { applied: true, replayed: true, mediaId: duplicate.id };
      const bySession = (await mediaObjects(deps.client).findFirst({
        where: { uploadSessionId: session.id },
      })) as unknown as MediaObjectRow | null;
      if (bySession) return { applied: true, replayed: true, mediaId: bySession.id };
    }
    throw err;
  }
}
