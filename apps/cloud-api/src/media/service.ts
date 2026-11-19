/**
 * BE-MED-01 Media 上传会话与元数据领域服务（框架无关）。
 *
 * 规则（事实源：实施方案 §11.9 + CT-03 media.schema.json + contracts/media/media-upload-policy）：
 * - 设备创建上传会话（mTLS 身份上下文）：校验 mediaType（策略=CT-03 枚举）、fileName
 *   （安全字符）、sizeKb（DEC-024 冻结的类型上限）、sizeBytes（精确长度）、sha256（hex64 申报）与
 *   每设备 UTC 自然日配额（DEC-024 冻结为 100）；设备须 Active/Maintenance 且已分配 Customer；
 *   objectPath 服务端生成（设备前缀，客户端不得指定 Bucket/Key）；签发 15 分钟预签名上传 URL；
 * - 上传后元数据（MQTT media 上行 → handleMediaMetadata）：objectPath 必须与有效会话的
 *   签发 Key 逐字符相等（跨设备/跨会话/任意 Key 拒绝）→ 申报一致性（fileName/mediaType/
 *   sizeKb）→ Object 存在 → 大小匹配（ceil KB）→ SHA-256 重算匹配 → 保存 MediaObject +
 *   会话 COMPLETED；幂等键 sourceMessageId = meta.id（重复上报回放）；
 * - 管理端：列表（筛选 + 键集游标分页）+ 15 分钟预签名下载 URL；Customer 角色强制
 *   租户隔离（跨 Customer → 404）；DELETED（DEC-005 文件到期删除）不提供下载；
 * - 审计（DOM-03）：media.upload_session.create / media.object.register；
 * - 功能边界：不采集/转码媒体；保留期处置属 DEC-005/BE-ARC-02；不提供实时流媒体会话（DEC-009）。
 */
import type { DbClient, Page } from '@fdp/database';
import { CursorInvalidError, Prisma, decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { handleMediaMetadata } from '@fdp/media';
import type { MediaUploadPolicyQuery } from '@fdp/media';
import { mediaForbidden, mediaNotFound, mediaValidationFailed } from './errors.js';
import type { MediaObjectStorage, MediaUrlSigner } from './storage.js';

// ---------- 策略查询门面（组合根经 contracts/media/media-upload-policy.ts 接线；禁止复制冻结值） ----------

export type { MediaMetadataMessage, MediaMetadataResult, MediaUploadPolicyQuery } from '@fdp/media';

export interface MediaDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
  readonly storage: MediaObjectStorage;
  readonly urlSigner: MediaUrlSigner;
  readonly uploadPolicy: MediaUploadPolicyQuery;
}

// ---------- DTO ----------

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

interface MediaListRow extends Omit<MediaView, 'mediaId' | 'captureTime' | 'durationSec'> {
  readonly id: string;
  readonly captureKey: string;
  readonly durationSec: number | null;
}

function toMediaView(row: MediaListRow): MediaView {
  return {
    mediaId: row.id,
    deviceId: row.deviceId,
    customerId: row.customerId,
    mediaType: row.mediaType,
    captureTime: row.captureKey.slice(0, -4) + 'Z',
    fileName: row.fileName,
    sizeKb: row.sizeKb,
    durationSec: row.durationSec ?? 0,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export * from './upload-session.js';

export { handleMediaMetadata };

// ---------- 管理端：列表与下载 URL ----------

export interface ListMediaFilter {
  readonly deviceId?: string | undefined;
  readonly mediaType?: string | undefined;
  readonly status?: string | undefined;
  readonly customerId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly captureTimeOrder?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

function parseTime(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw mediaValidationFailed(`${field} must be a valid ISO 8601 timestamp`);
  return new Date(time);
}

type CaptureTimeOrder = 'asc' | 'desc';

interface CaptureTimeCursor {
  readonly v: 2;
  readonly direction: CaptureTimeOrder;
  readonly captureTime: string;
  readonly id: string;
}

const CAPTURE_CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function decodeCaptureCursor(cursor: string, direction: CaptureTimeOrder): CaptureTimeCursor {
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new CursorInvalidError();
    const payload = JSON.parse(bytes.toString('utf8')) as Partial<CaptureTimeCursor> | null;
    if (
      payload?.v !== 2 ||
      payload.direction !== direction ||
      typeof payload.id !== 'string' ||
      payload.id.length === 0 ||
      payload.id.includes('\0') ||
      typeof payload.captureTime !== 'string' ||
      !CAPTURE_CURSOR_TIME.test(payload.captureTime) ||
      payload.captureTime.startsWith('0000-')
    ) {
      throw new CursorInvalidError();
    }
    // Verify the calendar date without discarding the microseconds in the SQL cursor.
    const millisecondTime = payload.captureTime.slice(0, 23) + 'Z';
    if (new Date(millisecondTime).toISOString() !== millisecondTime) throw new CursorInvalidError();
    return { v: 2, direction, captureTime: payload.captureTime, id: payload.id };
  } catch {
    throw new CursorInvalidError();
  }
}
function encodeCaptureCursor(direction: CaptureTimeOrder, captureTime: string, id: string): string {
  const cursor: CaptureTimeCursor = { v: 2, direction, captureTime, id };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
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
  const direction = filter.captureTimeOrder;
  if (direction !== undefined && direction !== 'asc' && direction !== 'desc') {
    throw mediaValidationFailed('captureTimeOrder must be one of: asc, desc');
  }
  const limit = normalizeLimit(filter.limit ?? null);
  const where: Prisma.Sql[] = [];
  if (scopedCustomerId) where.push(Prisma.sql`customer_id = ${scopedCustomerId}`);
  if (filter.deviceId) where.push(Prisma.sql`device_id = ${filter.deviceId}`);
  if (filter.mediaType) where.push(Prisma.sql`media_type = ${filter.mediaType}`);
  if (filter.status) where.push(Prisma.sql`status = ${filter.status}`);
  const from = parseTime(filter.from, 'from');
  const to = parseTime(filter.to, 'to');
  if (from) where.push(Prisma.sql`capture_time >= ${from.toISOString()}::timestamptz`);
  if (to) where.push(Prisma.sql`capture_time <= ${to.toISOString()}::timestamptz`);

  if (direction === undefined) {
    const after = decodeKeysetCursor(filter.cursor);
    if (after) where.push(Prisma.sql`id > ${after}`);
  } else if (filter.cursor) {
    const after = decodeCaptureCursor(filter.cursor, direction);
    const comparison = direction === 'asc' ? Prisma.sql`>` : Prisma.sql`<`;
    where.push(Prisma.sql`(capture_time, id) ${comparison} (${after.captureTime}::timestamptz, ${after.id})`);
  }
  const orderBy =
    direction === undefined
      ? Prisma.sql`id ASC`
      : direction === 'asc'
        ? Prisma.sql`capture_time ASC, id ASC`
        : Prisma.sql`capture_time DESC, id DESC`;
  // Use explicit UTC text and keep the DB's full microsecond precision in the seek key.
  const rows = await deps.client.$queryRaw<MediaListRow[]>`
    SELECT id, device_id AS "deviceId", customer_id AS "customerId", media_type AS "mediaType",
           file_name AS "fileName", size_kb AS "sizeKb", duration_sec AS "durationSec", status,
           to_char(capture_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "captureKey",
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
    FROM "public"."media_objects"
    ${where.length > 0 ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty}
    ORDER BY ${orderBy}
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(toMediaView),
    nextCursor:
      rows.length <= limit || last === undefined
        ? null
        : direction === undefined
          ? encodeKeysetCursor(last.id)
          : encodeCaptureCursor(direction, last.captureKey, last.id),
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
  const row = await deps.client.mediaObject.findFirst({
    where: { id: mediaId },
  });
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
