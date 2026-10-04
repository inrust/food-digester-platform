import { Button, Input } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
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
import { UnitValueText } from '../../components/LocaleValue.js';
import { useUserTimeZone } from '../../components/TimeText.js';
import { isUtcRangeOrdered } from '../../components/date-time.js';
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
  const { timeZone } = useUserTimeZone();
  // 仅平台角色可跨 Customer 筛选（Customer 角色由服务端强制 actor.customerId）
  const isPlatformRole = !role.startsWith('Customer');
  const fromUtc = draft.from === '' ? null : localDateTimeToUtcIso(draft.from, timeZone);
  const toUtc = draft.to === '' ? null : localDateTimeToUtcIso(draft.to, timeZone);
  const fromInvalid = draft.from !== '' && fromUtc === null;
  const toInvalid = draft.to !== '' && toUtc === null;
  const rangeInvalid = !fromInvalid && !toInvalid && !isUtcRangeOrdered(fromUtc, toUtc);
  const applyFilter = () => {
    if (fromInvalid || toInvalid || rangeInvalid) return;
    onApplyFilter({
      deviceId: draft.deviceId.trim() === '' ? null : draft.deviceId.trim(),
      mediaType: draft.mediaType === '' ? null : draft.mediaType,
      status: draft.status === '' ? null : draft.status,
      customerId: isPlatformRole && draft.customerId.trim() !== '' ? draft.customerId.trim() : null,
      from: fromUtc,
      to: toUtc,
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
        <h3>{translate('page.fd695a67e418')}</h3>
        <Button type="button" data-testid="media-refresh" onClick={onRefresh}>
          {translate('page.dcc4d58c807c')}
        </Button>
      </div>
      <p className="field-hint">{translate('page.2611c36de1a8')}</p>

      <section data-testid="media-filter" aria-label={translate('page.dcce9a144a40')}>
        <div className="filter-bar">
          <div className="filter-field">
            <label htmlFor="media-filter-type">{translate('page.e4e46c7235d1')}</label>
            <select
              id="media-filter-type"
              data-testid="media-filter-type"
              value={draft.mediaType}
              onChange={(event) =>
                setDraft({ ...draft, mediaType: event.target.value === '' ? '' : (event.target.value as MediaType) })
              }
            >
              <option value="">{translate('page.778fc8f99453')}</option>
              {MEDIA_TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>
                  {mediaTypeLabel(type)}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="media-filter-status">{translate('page.62e951a692ff')}</label>
            <select
              id="media-filter-status"
              data-testid="media-filter-status"
              value={draft.status}
              onChange={(event) =>
                setDraft({ ...draft, status: event.target.value === '' ? '' : (event.target.value as MediaStatus) })
              }
            >
              <option value="">{translate('page.778fc8f99453')}</option>
              {MEDIA_STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>
                  {MEDIA_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="media-filter-device">{translate('page.9a04e46a8d92')}</label>
            <Input
              id="media-filter-device"
              data-testid="media-filter-device"
              value={draft.deviceId}
              onChange={(event) => setDraft({ ...draft, deviceId: event.target.value })}
            />
          </div>
          {isPlatformRole ? (
            <>
              <label htmlFor="media-filter-customer">{translate('page.a20148b7e39a')}</label>
              <Input
                id="media-filter-customer"
                data-testid="media-filter-customer"
                value={draft.customerId}
                onChange={(event) => setDraft({ ...draft, customerId: event.target.value })}
              />
            </>
          ) : null}
          <div className="filter-field">
            <label htmlFor="media-filter-from">{translate('page.4b9915a00508')}</label>
            <Input
              id="media-filter-from"
              type="datetime-local"
              data-testid="media-filter-from"
              value={draft.from}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            />
          </div>
          <div className="filter-field">
            <label htmlFor="media-filter-to">{translate('page.9904cc627f05')}</label>
            <Input
              id="media-filter-to"
              type="datetime-local"
              data-testid="media-filter-to"
              value={draft.to}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            />
          </div>
          <Button
            type="button"
            className="primary-button"
            data-testid="media-filter-search"
            disabled={fromInvalid || toInvalid || rangeInvalid}
            onClick={applyFilter}
          >
            {translate('page.dcce9a144a40')}
          </Button>
        </div>
        {fromInvalid || toInvalid || rangeInvalid ? (
          <p className="field-hint" data-testid="media-filter-time-error">
            {rangeInvalid
              ? translate('page.1c35c2baf9f1')
              : translate('page.19cd7110c11d') + ' ' + timeZone + (' ' + translate('page.0d864b52e306'))}
          </p>
        ) : null}
      </section>

      <section data-testid="media-list-section" aria-label={translate('page.625ff012768a')}>
        <CursorTable
          ariaLabel={translate('page.625ff012768a')}
          columns={[
            { key: 'fileName', header: translate('page.1275f6feb703'), render: (m) => m.fileName },
            { key: 'mediaType', header: translate('page.e4e46c7235d1'), render: (m) => mediaTypeLabel(m.mediaType) },
            { key: 'deviceId', header: translate('page.01f2c16cda65'), render: (m) => m.deviceId },
            { key: 'customerId', header: translate('page.f20687060126'), render: (m) => m.customerId },
            {
              key: 'captureTime',
              header: translate('page.f9fb10d4a84e'),
              render: (m) => <TimeText iso={m.captureTime} />,
            },
            {
              key: 'sizeKb',
              header: translate('page.fd20702c73d1'),
              render: (m) => <UnitValueText value={m.sizeKb} unit="KB" />,
            },
            {
              key: 'durationSec',
              header: translate('page.29d0552d2e4c'),
              render: (m) => (m.mediaType === 'VIDEO' ? <UnitValueText value={m.durationSec} unit="s" /> : '—'),
            },
            { key: 'status', header: translate('page.62e951a692ff'), render: (m) => MEDIA_STATUS_LABELS[m.status] },
            {
              key: 'actions',
              header: translate('page.f3ea6d345e2a'),
              render: (m) =>
                m.status === 'AVAILABLE' ? (
                  <Button type="button" data-testid={`media-open-${m.mediaId}`} onClick={() => void requestUrl(m)}>
                    {translate('page.d668db53bc2a')}
                  </Button>
                ) : (
                  <span className="field-hint" data-testid={`media-deleted-${m.mediaId}`}>
                    {translate('page.41a4e70b235a')}
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
          emptyText={translate('page.1fb35289e967')}
        />
      </section>

      <Modal
        open={preview !== null}
        title={
          preview !== null ? translate('page.676b11f2e3bb') + preview.media.fileName : translate('page.e28fa8dafe21')
        }
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
