/**
 * FE-14 Media 页（/media）：Media 元数据列表、类型/设备/时间筛选、受控图片/视频查看、
 * 下载链接过期处理（DEC-024 15 分钟短期 URL，过期重新申请，不持久缓存授权 URL）。
 *
 * - Customer 角色强制租户隔离由服务端执行（跨 Customer 详情/下载 → 404，越权筛选 → 403），
 *   前端仅平台角色暴露 customerId 筛选；
 * - DEC-005：DELETED 元数据保留但不提供下载；DEC-009：不提供实时流媒体会话；
 * - 未知媒体类型安全降级（仅元数据）；功能边界：不上传/不转码/不管保留期。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import { CursorTable } from '../../components/CursorTable.js';
import { MediaPreview } from '../../components/MediaPreview.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import type { MediaListFilter } from './media-api.js';
import {
  MEDIA_STATUS_LABELS,
  MEDIA_STATUS_OPTIONS,
  MEDIA_TYPE_OPTIONS,
  localDateTimeToUtcIso,
  mediaTypeLabel,
} from './media-state.js';
import type { MediaListState, MediaStatus, MediaType, MediaView } from './types.js';
import type { MediaDownloadUrlView } from './types.js';

export interface MediaPageProps {
  readonly role: Role;
  readonly media: MediaListState;
  readonly filter: MediaListFilter;
  readonly onApplyFilter: (filter: MediaListFilter) => void;
  readonly onLoadMore: (cursor: string) => void;
  /** 手动刷新回源（获取最新设备媒体）。 */
  readonly onRefresh: () => void;
  /** 实时签发 15 分钟短期下载 URL（每次查看/续期均调用；不持久缓存）。 */
  readonly onRequestDownloadUrl: (mediaId: string) => Promise<MediaDownloadUrlView>;
  /** 可注入时钟（过期判定；缺省实时时钟）。 */
  readonly now?: () => Date;
}

interface PreviewState {
  readonly media: MediaView;
  readonly download: MediaDownloadUrlView | null;
  readonly loading: boolean;
  readonly error?: unknown;
}

interface DraftFilter {
  readonly deviceId: string;
  readonly mediaType: MediaType | '';
  readonly status: MediaStatus | '';
  readonly customerId: string;
  readonly from: string;
  readonly to: string;
}

const EMPTY_DRAFT: DraftFilter = {
  deviceId: '',
  mediaType: '',
  status: '',
  customerId: '',
  from: '',
  to: '',
};

export function MediaPage({
  role,
  media,
  filter,
  onApplyFilter,
  onLoadMore,
  onRefresh,
  onRequestDownloadUrl,
  now,
}: MediaPageProps) {
  const [draft, setDraft] = useState<DraftFilter>({
    ...EMPTY_DRAFT,
    deviceId: filter.deviceId ?? '',
    mediaType: filter.mediaType ?? '',
    status: filter.status ?? '',
    customerId: filter.customerId ?? '',
  });
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const inFlight = useRef(false);

  // 仅平台角色可跨 Customer 筛选（Customer 角色由服务端强制 actor.customerId）
  const isPlatformRole = !role.startsWith('Customer');

  const fromInvalid = draft.from !== '' && localDateTimeToUtcIso(draft.from) === null;
  const toInvalid = draft.to !== '' && localDateTimeToUtcIso(draft.to) === null;

  const applyFilter = () => {
    if (fromInvalid || toInvalid) return;
    onApplyFilter({
      deviceId: draft.deviceId.trim() === '' ? null : draft.deviceId.trim(),
      mediaType: draft.mediaType === '' ? null : draft.mediaType,
      status: draft.status === '' ? null : draft.status,
      customerId: isPlatformRole && draft.customerId.trim() !== '' ? draft.customerId.trim() : null,
      from: localDateTimeToUtcIso(draft.from),
      to: localDateTimeToUtcIso(draft.to),
    });
  };

  const requestUrl = async (target: MediaView) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPreview((prev) =>
      prev !== null && prev.media.mediaId === target.mediaId
        ? { ...prev, loading: true, error: undefined }
        : { media: target, download: null, loading: true },
    );
    try {
      const download = await onRequestDownloadUrl(target.mediaId);
      setPreview({ media: target, download, loading: false });
    } catch (err) {
      setPreview({ media: target, download: null, loading: false, error: err });
    } finally {
      inFlight.current = false;
    }
  };

  const closePreview = () => {
    // 短期授权 URL 随关闭即弃（不持久缓存）
    setPreview(null);
  };

  return (
    <div className="media-page" data-testid="media-page">
      <div className="page-header">
        <h3>媒体管理</h3>
        <button type="button" data-testid="media-refresh" onClick={onRefresh}>
          刷新最新媒体
        </button>
      </div>
      <p className="field-hint">仅元数据 + 15 分钟短期下载 URL（每次查看实时签发，不持久缓存）；不提供实时流媒体。</p>

      <section data-testid="media-filter" aria-label="筛选">
        <div className="filter-bar">
          <label htmlFor="media-filter-type">类型</label>
          <select
            id="media-filter-type"
            data-testid="media-filter-type"
            value={draft.mediaType}
            onChange={(event) =>
              setDraft({ ...draft, mediaType: event.target.value === '' ? '' : (event.target.value as MediaType) })
            }
          >
            <option value="">全部</option>
            {MEDIA_TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>
                {mediaTypeLabel(type)}
              </option>
            ))}
          </select>
          <label htmlFor="media-filter-status">状态</label>
          <select
            id="media-filter-status"
            data-testid="media-filter-status"
            value={draft.status}
            onChange={(event) =>
              setDraft({ ...draft, status: event.target.value === '' ? '' : (event.target.value as MediaStatus) })
            }
          >
            <option value="">全部</option>
            {MEDIA_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {MEDIA_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          <label htmlFor="media-filter-device">设备 ID</label>
          <input
            id="media-filter-device"
            data-testid="media-filter-device"
            value={draft.deviceId}
            onChange={(event) => setDraft({ ...draft, deviceId: event.target.value })}
          />
          {isPlatformRole ? (
            <>
              <label htmlFor="media-filter-customer">客户 ID</label>
              <input
                id="media-filter-customer"
                data-testid="media-filter-customer"
                value={draft.customerId}
                onChange={(event) => setDraft({ ...draft, customerId: event.target.value })}
              />
            </>
          ) : null}
          <label htmlFor="media-filter-from">采集时间起</label>
          <input
            id="media-filter-from"
            type="datetime-local"
            data-testid="media-filter-from"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
          <label htmlFor="media-filter-to">采集时间止</label>
          <input
            id="media-filter-to"
            type="datetime-local"
            data-testid="media-filter-to"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
          <button
            type="button"
            className="primary-button"
            data-testid="media-filter-search"
            disabled={fromInvalid || toInvalid}
            onClick={applyFilter}
          >
            筛选
          </button>
        </div>
        {fromInvalid || toInvalid ? (
          <p className="field-hint" data-testid="media-filter-time-error">
            时间格式非法
          </p>
        ) : null}
      </section>

      <section data-testid="media-list-section" aria-label="媒体列表">
        <CursorTable
          ariaLabel="媒体列表"
          columns={[
            { key: 'fileName', header: '文件名', render: (m) => m.fileName },
            { key: 'mediaType', header: '类型', render: (m) => mediaTypeLabel(m.mediaType) },
            { key: 'deviceId', header: '设备', render: (m) => m.deviceId },
            { key: 'customerId', header: '客户', render: (m) => m.customerId },
            { key: 'captureTime', header: '采集时间', render: (m) => <TimeText iso={m.captureTime} /> },
            { key: 'sizeKb', header: '大小', render: (m) => `${m.sizeKb} KB` },
            {
              key: 'durationSec',
              header: '时长',
              render: (m) => (m.mediaType === 'VIDEO' ? `${m.durationSec}s` : '—'),
            },
            { key: 'status', header: '状态', render: (m) => MEDIA_STATUS_LABELS[m.status] },
            {
              key: 'actions',
              header: '操作',
              render: (m) =>
                m.status === 'AVAILABLE' ? (
                  <button type="button" data-testid={`media-open-${m.mediaId}`} onClick={() => void requestUrl(m)}>
                    查看/下载
                  </button>
                ) : (
                  <span className="field-hint" data-testid={`media-deleted-${m.mediaId}`}>
                    元数据保留
                  </span>
                ),
            },
          ]}
          rows={media.rows === null ? null : [...media.rows]}
          rowKey={(m) => m.mediaId}
          {...(media.loading !== undefined ? { loading: media.loading } : {})}
          {...(media.error !== undefined ? { error: media.error } : {})}
          {...(media.nextCursor !== undefined ? { nextCursor: media.nextCursor } : {})}
          onNextPage={onLoadMore}
          onRefresh={onRefresh}
          emptyText="暂无媒体"
        />
      </section>

      <Modal
        open={preview !== null}
        title={preview !== null ? `媒体预览：${preview.media.fileName}` : '媒体预览'}
        testid="media-preview-modal"
        onClose={closePreview}
      >
        {preview !== null ? (
          <MediaPreview
            media={preview.media}
            download={
              preview.download !== null
                ? { url: preview.download.downloadUrl, expiresAt: preview.download.downloadUrlExpiresAt }
                : null
            }
            loading={preview.loading}
            {...(preview.error !== undefined ? { error: preview.error } : {})}
            onRequestUrl={() => void requestUrl(preview.media)}
            {...(now !== undefined ? { now } : {})}
          />
        ) : null}
      </Modal>
    </div>
  );
}
