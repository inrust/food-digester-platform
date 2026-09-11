/**
 * FE-14 Media API 装配（BE-MED-01）。
 *
 * - listMedia：deviceId/mediaType/status/customerId/时间范围筛选 + 键集游标分页；
 *   customerId 仅平台角色可跨 Customer 筛选（Customer 角色强制 actor.customerId，不一致 → 403）；
 * - createMediaDownloadUrl：签发 DEC-024 冻结的 15 分钟预签名下载 URL；
 *   DELETED（DEC-005 元数据保留）/跨 Customer → 404；每次查看/下载实时申请，不持久缓存。
 */
import type { ApiClient } from '../../api/http-client.js';
import type { MediaDownloadUrlView, MediaStatus, MediaType, MediaView } from './types.js';

export interface Page<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
}

export interface MediaListFilter {
  readonly deviceId?: string | null;
  readonly mediaType?: MediaType | null;
  readonly status?: MediaStatus | null;
  /** 仅平台角色可传；Customer 角色由服务端强制 actor.customerId。 */
  readonly customerId?: string | null;
  /** captureTime 起（UTC ISO）。 */
  readonly from?: string | null;
  /** captureTime 止（UTC ISO）。 */
  readonly to?: string | null;
}

function buildQuery(filter: MediaListFilter, cursor?: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  if (cursor !== undefined && cursor !== '') params.set('cursor', cursor);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export async function listMedia(
  api: ApiClient,
  filter: MediaListFilter,
  cursor?: string,
): Promise<Page<MediaView>> {
  const response = await api.request<{ data: MediaView[]; meta: { nextCursor: string | null } }>(
    `/admin/media${buildQuery(filter, cursor)}`,
  );
  return { rows: response.data, nextCursor: response.meta.nextCursor };
}

/** 签发 15 分钟预签名下载 URL（每次调用实时签发；调用方不得持久缓存）。 */
export async function createMediaDownloadUrl(
  api: ApiClient,
  mediaId: string,
): Promise<MediaDownloadUrlView> {
  const response = await api.request<{ data: MediaDownloadUrlView }>(
    `/admin/media/${encodeURIComponent(mediaId)}/download-url`,
  );
  return response.data;
}
