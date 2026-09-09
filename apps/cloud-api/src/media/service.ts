/**
 * BE-MED-01 Media 上传会话与元数据领域服务（框架无关）。
 *
 * 规则（事实源：实施方案 §11.9 + CT-03 media.schema.json + contracts/media/media-upload-policy）：
 * - 设备创建上传会话（mTLS 身份上下文）：校验 mediaType（策略=CT-03 枚举）、fileName
 *   （安全字符）、sizeKb（类型上限，暂定值）、sizeBytes（精确长度）、sha256（hex64 申报）与每设备每日配额
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
import { handleMediaMetadata } from '@fdp/media';
import type { MediaUploadPolicyQuery } from '@fdp/media';
import { mediaConflict, mediaForbidden, mediaNotFound, mediaValidationFailed } from './errors.js';
import { buildMediaObjectKey } from './storage.js';
import type { MediaObjectStorage, MediaUrlSigner } from './storage.js';

// ---------- 策略查询门面（组合根经 contracts/media/media-upload-policy.ts 接线；禁止复制暂定值） ----------

export type { MediaMetadataMessage, MediaMetadataResult, MediaUploadPolicyQuery } from '@fdp/media';

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

// ---------- DTO ----------

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
  /** 精确字节数；用于把预签名 PUT 的 Content-Length 绑定到申报对象。 */
  readonly sizeBytes: number;
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
  if (
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    Math.ceil(input.sizeBytes / 1024) !== input.sizeKb
  ) {
    throw mediaValidationFailed('sizeBytes must be a positive integer consistent with sizeKb');
  }
  if (!SHA256_PATTERN.test(input.sha256)) {
    throw mediaValidationFailed('sha256 must be a 64-character hex string');
  }

  // 配额窗口：UTC 自然日。领取在下方事务中锁定 device 行后执行，避免 count → create 竞态。
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

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
    async (tx) => {
      await (
        tx as DbClient & {
          $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
        }
      ).$queryRawUnsafe('SELECT id FROM "devices" WHERE id = $1 FOR UPDATE', auth.deviceId);
      const todayCount = await sessions(tx).count({
        where: { deviceId: auth.deviceId, createdAt: { gte: dayStart } },
      });
      if (todayCount >= deps.uploadPolicy.getDailyUploadQuotaPerDevice()) {
        throw mediaConflict('The daily media upload quota for this device is exceeded');
      }
      return sessions(tx).create({
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
      });
    },
  );

  const uploadUrl = await deps.urlSigner.signUpload({
    key: objectPath,
    expiresAt: uploadUrlExpiresAt,
    contentLength: input.sizeBytes,
    checksumSha256: input.sha256,
  });
  return {
    sessionId: row.id,
    mediaType: row.mediaType,
    fileName: row.fileName,
    sizeKb: row.sizeKb,
    sizeBytes: input.sizeBytes,
    objectPath,
    uploadUrl,
    uploadUrlExpiresAt: uploadUrlExpiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export { handleMediaMetadata };

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
    downloadUrl: await deps.urlSigner.signDownload({ key: row.objectPath, expiresAt: downloadUrlExpiresAt }),
    downloadUrlExpiresAt: downloadUrlExpiresAt.toISOString(),
  };
}
