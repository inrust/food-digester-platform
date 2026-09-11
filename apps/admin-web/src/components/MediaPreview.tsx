/**
 * FE-14 可复用媒体预览组件（Media 页与设备查看/操作页共用）。
 *
 * - 只使用短期预签名 URL（DEC-024：15 分钟）：URL 仅由父级内存持有，本组件不缓存、
 *   不持久化；过期显示“重新申请”，由父级实时重签；
 * - DEC-005：DELETED（文件到期删除、元数据保留）不提供下载/预览；
 * - DEC-009：不提供实时流媒体；视频仅为录制文件的受控查看（无实时播放/停止语义）；
 * - 未知媒体类型安全降级：仅展示元数据，不渲染 img/video、不提供下载入口。
 */
import { ErrorNotice } from './ErrorNotice.js';
import { TimeText } from './TimeText.js';
import { isDownloadUrlExpired, isKnownMediaType, mediaTypeLabel } from '../pages/media/media-state.js';

export interface MediaPreviewMedia {
  readonly mediaId: string;
  /** string（运行时可能越出契约枚举，组件内安全降级）。 */
  readonly mediaType: string;
  readonly fileName: string;
  readonly status: string;
  readonly captureTime: string;
}

export interface MediaPreviewProps {
  readonly media: MediaPreviewMedia;
  /** 已签发的短期下载 URL；null = 尚未申请。 */
  readonly download: { readonly url: string; readonly expiresAt: string } | null;
  readonly loading?: boolean;
  readonly error?: unknown;
  /** 申请/重新申请下载 URL（过期重签同一回调）。 */
  readonly onRequestUrl: () => void;
  /** 可注入时钟（过期判定；缺省实时时钟）。 */
  readonly now?: () => Date;
}

export function MediaPreview({
  media,
  download,
  loading = false,
  error,
  onRequestUrl,
  now = () => new Date(),
}: MediaPreviewProps) {
  const expired = download !== null && isDownloadUrlExpired(download.expiresAt, now());
  const usable = download !== null && !expired;

  return (
    <div className="media-preview" data-testid="media-preview">
      <div className="media-meta">
        <span data-testid="media-preview-name">{media.fileName}</span>
        <span data-testid="media-preview-type">{mediaTypeLabel(media.mediaType)}</span>
        <span>
          采集于 <TimeText iso={media.captureTime} />
        </span>
      </div>

      {media.status === 'DELETED' ? (
        <p className="empty-state" data-testid="media-deleted">
          文件已删除（元数据保留），不提供下载
        </p>
      ) : !isKnownMediaType(media.mediaType) ? (
        <p className="empty-state" data-testid="media-type-fallback">
          不支持的媒体类型（{media.mediaType}），仅展示元数据
        </p>
      ) : loading ? (
        <p role="status" data-testid="media-url-loading">
          正在申请下载链接…
        </p>
      ) : error !== undefined && error !== null ? (
        <div data-testid="media-url-error">
          <ErrorNotice error={error} />
          <button type="button" className="primary-button" data-testid="media-url-request" onClick={onRequestUrl}>
            重新申请
          </button>
        </div>
      ) : download === null ? (
        <button type="button" className="primary-button" data-testid="media-url-request" onClick={onRequestUrl}>
          申请查看（签发 15 分钟短期链接）
        </button>
      ) : expired ? (
        <div data-testid="media-url-expired">
          <p className="field-hint">下载链接已过期（15 分钟有效）。</p>
          <button type="button" className="primary-button" data-testid="media-url-renew" onClick={onRequestUrl}>
            重新申请
          </button>
        </div>
      ) : usable ? (
        <div data-testid="media-content">
          {media.mediaType === 'IMAGE' ? (
            <img data-testid="media-preview-image" src={download.url} alt={media.fileName} />
          ) : (
            // 录制文件的受控查看（非实时流）
            <video data-testid="media-preview-video" controls src={download.url} />
          )}
          <p className="field-hint">
            链接有效期至 <TimeText iso={download.expiresAt} />（短期授权，过期需重新申请）
          </p>
          <a data-testid="media-download-link" href={download.url} download={media.fileName}>
            下载 {media.fileName}
          </a>
        </div>
      ) : null}
    </div>
  );
}
