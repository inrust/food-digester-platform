/**
 * FE-14 Media 数据类型：镜像 admin-media-api.json（BE-MED-01，DEC-005/DEC-009/DEC-024）。
 */

export type MediaType = 'IMAGE' | 'VIDEO';

/** DEC-005：文件到期删除后元数据保留（DELETED 不提供下载）。 */
export type MediaStatus = 'AVAILABLE' | 'DELETED';

/** Media 元数据（不含 objectPath/内部存储信息；下载经短期预签名 URL）。 */
export interface MediaView {
  readonly mediaId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly mediaType: MediaType;
  readonly captureTime: string;
  readonly fileName: string;
  readonly sizeKb: number;
  /** 视频时长（秒）；图片为 0。 */
  readonly durationSec: number;
  readonly status: MediaStatus;
  readonly createdAt: string;
}

/** DEC-024：15 分钟（900s）预签名下载 URL。 */
export interface MediaDownloadUrlView {
  readonly mediaId: string;
  readonly downloadUrl: string;
  readonly downloadUrlExpiresAt: string;
}

export interface MediaListState {
  readonly rows: readonly MediaView[] | null;
  readonly loading?: boolean;
  readonly error?: unknown;
  readonly nextCursor?: string | null;
}
