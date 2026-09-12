import { translate } from '../i18n/i18n.js';
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
  readonly download: {
    readonly url: string;
    readonly expiresAt: string;
  } | null;
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
          {translate('page.ebd616a91fdc') + ' '}
          <TimeText iso={media.captureTime} />
        </span>
      </div>

      {media.status === 'DELETED' ? (
        <p className="empty-state" data-testid="media-deleted">
          {translate('ui.2f5857635390')}
        </p>
      ) : !isKnownMediaType(media.mediaType) ? (
        <p className="empty-state" data-testid="media-type-fallback">
          {translate('ui.fa71ddaf4ce1')}
          {media.mediaType}
          {translate('ui.dbb08f293404')}
        </p>
      ) : loading ? (
        <p role="status" data-testid="media-url-loading">
          {translate('ui.5d7af997b52a')}
        </p>
      ) : error !== undefined && error !== null ? (
        <div data-testid="media-url-error">
          <ErrorNotice error={error} />
          <button type="button" className="primary-button" data-testid="media-url-request" onClick={onRequestUrl}>
            {translate('ui.dfae99182d6c')}
          </button>
        </div>
      ) : download === null ? (
        <button type="button" className="primary-button" data-testid="media-url-request" onClick={onRequestUrl}>
          {translate('ui.e8e63786d256')}
        </button>
      ) : expired ? (
        <div data-testid="media-url-expired">
          <p className="field-hint">{translate('ui.7edf60045f5b')}</p>
          <button type="button" className="primary-button" data-testid="media-url-renew" onClick={onRequestUrl}>
            {translate('ui.dfae99182d6c')}
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
            {translate('ui.5e9154826b14') + ' '}
            <TimeText iso={download.expiresAt} />
            {translate('ui.f60e11b770dd')}
          </p>
          <a data-testid="media-download-link" href={download.url} download={media.fileName}>
            {translate('ui.2b9d013177da') + ' '}
            {media.fileName}
          </a>
        </div>
      ) : null}
    </div>
  );
}
