/**
 * BE-MED-01 Media 上传会话与元数据领域服务（框架无关）。
 *
 * 规则（事实源：实施方案 §11.9 + CT-03 media.schema.json + contracts/media/media-upload-policy）：
 * - 设备创建上传会话（mTLS 身份上下文）：校验 mediaType（策略=CT-03 枚举）、fileName
 *   （安全字符）、sizeKb（类型上限，暂定值）、sha256（hex64 申报）与每设备每日配额
 *   （暂定值）；设备须 Active/Maintenance 且已分配 Customer；objectPath 服务端生成
 *   （设备前缀，客户端不得指定 Bucket/Key）；签发 15 分钟预签名上传 URL（暂定值 900s）；
 * - 上传后元数据（MQTT media 上行 → handleMediaMetadata）：objectPath 必须与有效会话的
 *   签发 Key 逐字符相等（跨设备/跨会话/任意 Key 拒绝）→ 申报一致性（fileName/mediaType/
 *   sizeKb）→ Object 存在 → 大小匹配（ceil KB）→ SHA-256 重算匹配 → 保存 MediaObject +
 *   会话 COMPLETED；幂等键 sourceMessageId = meta.id（重复上报回放）；
 * - 管理端：列表（筛选 + 键集游标分页）+ 15 分钟预签名下载 URL；Customer 角色强制
 *   租户隔离（跨 Customer → 404）；DELETED（DEC-005 文件到期删除）不提供下载；
 * - 审计（DOM-03）：media.upload_session.create / media.object.register；
 * - 功能边界：不采集/转码媒体；保留期处置属 DEC-005/BE-ARC-02；不提供实时流媒体会话（DEC-009）。
 */
import { randomUUID } from 'node:crypto';
import type { DbClient, Page } from '@fdp/database';
import { audited, decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import type { DeviceAuthContext } from '@fdp/auth';
import { mediaConflict, mediaForbidden, mediaNotFound, mediaValidationFailed } from './errors.js';
import { buildMediaObjectKey, parseMediaObjectKey } from './storage.js';
import type { MediaObjectStorage, MediaUrlSigner } from './storage.js';

// ---------- 策略查询门面（组合根经 contracts/media/media-upload-policy.ts 接线；禁止复制暂定值） ----------

export interface MediaUploadPolicyQuery {
  readonly getMediaTypes: () => readonly string[];
  readonly getMaxSizeKb: (mediaType: string) => number | undefined;
  readonly getDailyUploadQuotaPerDevice: () => number;
  readonly getUploadUrlTtlSeconds: () => number;
  readonly getDownloadUrlTtlSeconds: () => number;
}

export interface MediaDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
  readonly storage: MediaObjectStorage;
  readonly urlSigner: MediaUrlSigner;
  readonly uploadPolicy: MediaUploadPolicyQuery;
}

/** 允许发起上传会话的生命周期（Suspended/Retired 拒绝；Retired 由 AUTH-03 先行拒绝）。 */
const UPLOAD_ALLOWED_LIFECYCLES = ['Active', 'Maintenance'] as const;

const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256_PATTERN = /^[0-9A-Fa-f]{64}$/;

// ---------- 行类型与数据访问 ----------

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
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

interface MediaObjectRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly uploadSessionId: string | null;
  readonly mediaType: string;
  readonly captureTime: Date;
  readonly fileName: string;
  readonly objectPath: string;
  readonly sizeKb: number;
  readonly durationSec: number | null;
  readonly sha256: string | null;
  readonly status: string;
  readonly sourceMessageId: string | null;
  readonly createdAt: Date;
}

interface TableDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<never>;
  findMany(args: Record<string, unknown>): Promise<never[]>;
  create(args: { data: Record<string, unknown> }): Promise<never>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

function table(client: DbClient, name: string): TableDelegate {
  return (client as unknown as Record<string, unknown>)[name] as TableDelegate;
}

const sessions = (c: DbClient) => table(c, 'mediaUploadSession');
const mediaObjects = (c: DbClient) => table(c, 'mediaObject');
const devicesOf = (c: DbClient) => table(c, 'device');

// ---------- DTO ----------

export interface MediaUploadSessionView {
  readonly sessionId: string;
  readonly mediaType: string;
  readonly fileName: string;
  readonly sizeKb: number;
  readonly objectPath: string;
  readonly uploadUrl: string;
  readonly uploadUrlExpiresAt: string;
  readonly createdAt: string;
}

export interface MediaView {
  readonly mediaId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly mediaType: string;
  readonly captureTime: string;
  readonly fileName: string;
  readonly sizeKb: number;
  readonly durationSec: number;
  readonly status: string;
  readonly createdAt: string;
}

function toMediaView(row: MediaObjectRow): MediaView {
  return {
    mediaId: row.id,
    deviceId: row.deviceId,
    customerId: row.customerId,
    mediaType: row.mediaType,
    captureTime: row.captureTime.toISOString(),
    fileName: row.fileName,
    sizeKb: row.sizeKb,
    durationSec: row.durationSec ?? 0,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------- 设备：创建上传会话 ----------

export interface CreateMediaUploadSessionInput {
  readonly mediaType: string;
  readonly fileName: string;
  readonly sizeKb: number;
  /** 设备申报的 SHA-256（hex64）；上传后服务端重算比对。 */
  readonly sha256: string;
}

export async function createMediaUploadSession(
  deps: MediaDeps,
  auth: DeviceAuthContext,
  input: CreateMediaUploadSessionInput,
): Promise<MediaUploadSessionView> {
  const now = deps.now?.() ?? new Date();
  // 设备权限：生命周期 + 已分配 Customer（配额与 Key 前缀都需要 Customer 归属）
  if (!(UPLOAD_ALLOWED_LIFECYCLES as readonly string[]).includes(auth.deviceLifecycleStatus)) {
    throw mediaForbidden('The device lifecycle does not allow media upload');
  }
  if (!auth.customerId) {
    throw mediaForbidden('The device is not assigned to a customer');
  }
  const customerId = auth.customerId;

  // 类型/文件名/大小/Hash 校验（策略驱动）
  if (!deps.uploadPolicy.getMediaTypes().includes(input.mediaType)) {
    throw mediaValidationFailed('mediaType must be one of: IMAGE, VIDEO');
  }
  if (!FILE_NAME_PATTERN.test(input.fileName)) {
    throw mediaValidationFailed('fileName must match ^[A-Za-z0-9._-]{1,128}$');
  }
  const maxSizeKb = deps.uploadPolicy.getMaxSizeKb(input.mediaType) ?? 0;
  if (!Number.isInteger(input.sizeKb) || input.sizeKb < 1 || input.sizeKb > maxSizeKb) {
    throw mediaValidationFailed(`sizeKb must be an integer between 1 and ${maxSizeKb}`);
  }
  if (!SHA256_PATTERN.test(input.sha256)) {
    throw mediaValidationFailed('sha256 must be a 64-character hex string');
  }

  // 配额：每设备每日上传会话数（UTC 自然日，暂定值）
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayCount = await sessions(deps.client).count({
    where: { deviceId: auth.deviceId, createdAt: { gte: dayStart } },
  });
  if (todayCount >= deps.uploadPolicy.getDailyUploadQuotaPerDevice()) {
    throw mediaConflict('The daily media upload quota for this device is exceeded');
  }

  const sessionId = randomUUID();
  const objectPath = buildMediaObjectKey({
    customerId,
    deviceId: auth.deviceId,
    sessionId,
    fileName: input.fileName,
  });
  const ttl = deps.uploadPolicy.getUploadUrlTtlSeconds();
  const uploadUrlExpiresAt = new Date(now.getTime() + ttl * 1000);

  const row = await audited<MediaUploadSessionRow>(
    deps.client,
    {
      objectType: 'media_upload_session',
      objectId: sessionId,
      action: 'media.upload_session.create',
      reason: `mediaType=${input.mediaType} sizeKb=${input.sizeKb}`,
      actorId: auth.deviceId,
      customerId,
      afterValue: () => ({
        sessionId,
        deviceId: auth.deviceId,
        mediaType: input.mediaType,
        fileName: input.fileName,
        sizeKb: input.sizeKb,
        status: 'ISSUED',
      }),
    },
    (tx) =>
      sessions(tx).create({
        data: {
          id: sessionId,
          deviceId: auth.deviceId,
          customerId,
          mediaType: input.mediaType,
          fileName: input.fileName,
          sizeKb: input.sizeKb,
          declaredSha256: input.sha256.toLowerCase(),
          status: 'ISSUED',
          presignedUrlExpiresAt: uploadUrlExpiresAt,
          createdAt: now,
        },
      }),
  );

  return {
    sessionId: row.id,
    mediaType: row.mediaType,
    fileName: row.fileName,
    sizeKb: row.sizeKb,
    objectPath,
    uploadUrl: deps.urlSigner.signUpload({ key: objectPath, expiresAt: uploadUrlExpiresAt }),
    uploadUrlExpiresAt: uploadUrlExpiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------- 设备：上传后元数据（MQTT media 上行） ----------

export interface MediaMetadataMessage {
  readonly meta: { readonly id: string; readonly ts: string };
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
    | 'METADATA_MISMATCH'
    | 'OBJECT_MISSING'
    | 'SIZE_MISMATCH'
    | 'HASH_MISMATCH';
}

function reject(reason: NonNullable<MediaMetadataResult['reason']>): MediaMetadataResult {
  return { applied: false, reason };
}

function isValidUtcDateTime(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * 处理 Media 元数据上行（bnx/device/{deviceId}/media；Envelope 已由 media.schema.json 校验）。
 * 所有业务拒绝以返回值表达（不抛出）；任何拒绝不产生写入。
 */
export async function handleMediaMetadata(
  deps: MediaDeps,
  deviceId: string,
  message: MediaMetadataMessage,
): Promise<MediaMetadataResult> {
  const now = deps.now?.() ?? new Date();
  const data = message?.data;
  if (!data || typeof data !== 'object') return reject('INVALID_MESSAGE');
  const { mediaType, captureTime, fileName, objectPath, sizeKb, durationSec } = data as Record<string, unknown>;
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

  // 幂等：sourceMessageId 唯一（重复上报回放，不重复写入）
  const existing = (await mediaObjects(deps.client).findFirst({
    where: { sourceMessageId },
  })) as unknown as MediaObjectRow | null;
  if (existing) {
    return existing.deviceId === deviceId
      ? { applied: true, replayed: true, mediaId: existing.id }
      : reject('FORBIDDEN_PATH');
  }

  const device = (await devicesOf(deps.client).findFirst({ where: { id: deviceId } })) as unknown as {
    id: string;
    customerId: string | null;
  } | null;
  if (!device) return reject('DEVICE_NOT_FOUND');

  // objectPath 必须指向本设备前缀的已签发会话（客户端不得指向任意 Bucket/Key）
  const parsed = parseMediaObjectKey(objectPath);
  if (!parsed || parsed.deviceId !== deviceId || parsed.customerId !== device.customerId) {
    return reject('FORBIDDEN_PATH');
  }
  const session = (await sessions(deps.client).findFirst({
    where: { id: parsed.sessionId },
  })) as unknown as MediaUploadSessionRow | null;
  if (!session || session.deviceId !== deviceId) return reject('UNKNOWN_SESSION');
  if (session.status === 'COMPLETED') {
    // 会话已完成但换了 messageId 重复上报：视为幂等回放
    const done = (await mediaObjects(deps.client).findFirst({
      where: { uploadSessionId: session.id },
    })) as unknown as MediaObjectRow | null;
    return done ? { applied: true, replayed: true, mediaId: done.id } : reject('SESSION_NOT_OPEN');
  }
  if (session.status !== 'ISSUED') return reject('SESSION_NOT_OPEN');

  // 申报一致性：objectPath 逐字符相等 + fileName/mediaType/sizeKb 与会话申报一致
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

  // Object 存在 + 大小匹配（ceil KB）
  const stat = await deps.storage.statObject(objectPath);
  if (!stat) return reject('OBJECT_MISSING');
  if (Math.ceil(stat.sizeBytes / 1024) !== session.sizeKb) return reject('SIZE_MISMATCH');

  // Hash 重算比对（会话创建时申报）
  const actualSha256 = await deps.storage.computeSha256(objectPath);
  const declaredSha256 = session.declaredSha256?.toLowerCase();
  if (!declaredSha256 || !actualSha256 || actualSha256.toLowerCase() !== declaredSha256) {
    return reject('HASH_MISMATCH');
  }

  // 保存元数据 + 会话 COMPLETED（同事务 + 审计；并发/重复由 sourceMessageId 唯一约束兜底）
  const mediaId = randomUUID();
  try {
    return await audited<MediaMetadataResult>(
      deps.client,
      {
        objectType: 'media_object',
        objectId: mediaId,
        action: 'media.object.register',
        reason: `session=${session.id} mediaType=${session.mediaType}`,
        actorId: deviceId,
        customerId: session.customerId,
        afterValue: (r: unknown) => {
          const result = r as MediaMetadataResult;
          return { mediaId: result.mediaId, deviceId, mediaType: session.mediaType, sizeKb: session.sizeKb };
        },
      },
      async (tx) => {
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
            createdAt: now,
          },
        });
        const completed = await sessions(tx).updateMany({
          where: { id: session.id, status: 'ISSUED' },
          data: { status: 'COMPLETED', completedAt: now },
        });
        if (completed.count !== 1) return reject('SESSION_NOT_OPEN');
        return { applied: true, replayed: false, mediaId };
      },
    );
  } catch (err) {
    // 并发重复上报：sourceMessageId/uploadSessionId 唯一约束 → 幂等回放
    if ((err as { code?: string } | null)?.code === 'P2002') {
      const dup = (await mediaObjects(deps.client).findFirst({
        where: { sourceMessageId },
      })) as unknown as MediaObjectRow | null;
      if (dup) return { applied: true, replayed: true, mediaId: dup.id };
    }
    throw err;
  }
}

// ---------- 管理端：列表与下载 URL ----------

export interface ListMediaFilter {
  readonly deviceId?: string | undefined;
  readonly mediaType?: string | undefined;
  readonly status?: string | undefined;
  readonly customerId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

function parseTime(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw mediaValidationFailed(`${field} must be a valid ISO 8601 timestamp`);
  return new Date(time);
}

export async function listMedia(
  deps: MediaDeps,
  actor: ActorContext,
  filter: ListMediaFilter = {},
): Promise<Page<MediaView>> {
  if (filter.mediaType !== undefined && !deps.uploadPolicy.getMediaTypes().includes(filter.mediaType)) {
    throw mediaValidationFailed('mediaType must be one of: IMAGE, VIDEO');
  }
  if (filter.status !== undefined && !['AVAILABLE', 'DELETED'].includes(filter.status)) {
    throw mediaValidationFailed('status must be one of: AVAILABLE, DELETED');
  }
  // Customer 角色强制租户隔离；平台角色可按 customerId 筛选
  const scopedCustomerId = actor.actorType === 'customer' ? (actor.customerId ?? '__none__') : filter.customerId;
  if (actor.actorType === 'customer' && filter.customerId !== undefined && filter.customerId !== actor.customerId) {
    throw mediaForbidden('Customer roles can only query their own customer scope');
  }
  const limit = normalizeLimit(filter.limit ?? null);
  const where: Record<string, unknown> = {};
  if (scopedCustomerId) where.customerId = scopedCustomerId;
  if (filter.deviceId) where.deviceId = filter.deviceId;
  if (filter.mediaType) where.mediaType = filter.mediaType;
  if (filter.status) where.status = filter.status;
  const from = parseTime(filter.from, 'from');
  const to = parseTime(filter.to, 'to');
  if (from || to) {
    where.captureTime = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = (await mediaObjects(deps.client).findMany({
    where,
    orderBy: { id: 'asc' },
    take: limit + 1,
  })) as unknown as MediaObjectRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toMediaView),
    nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null,
  };
}

export interface MediaDownloadUrlView {
  readonly mediaId: string;
  readonly downloadUrl: string;
  readonly downloadUrlExpiresAt: string;
}

/** 签发短期下载 URL（media:read；跨 Customer → 404；DELETED 不提供下载）。 */
export async function createMediaDownloadUrl(
  deps: MediaDeps,
  actor: ActorContext,
  mediaId: string,
): Promise<MediaDownloadUrlView> {
  const now = deps.now?.() ?? new Date();
  const row = (await mediaObjects(deps.client).findFirst({
    where: { id: mediaId },
  })) as unknown as MediaObjectRow | null;
  if (!row) throw mediaNotFound();
  if (actor.actorType === 'customer' && row.customerId !== actor.customerId) throw mediaNotFound();
  if (row.status !== 'AVAILABLE') throw mediaNotFound();
  const ttl = deps.uploadPolicy.getDownloadUrlTtlSeconds();
  const downloadUrlExpiresAt = new Date(now.getTime() + ttl * 1000);
  return {
    mediaId: row.id,
    downloadUrl: deps.urlSigner.signDownload({ key: row.objectPath, expiresAt: downloadUrlExpiresAt }),
    downloadUrlExpiresAt: downloadUrlExpiresAt.toISOString(),
  };
}
