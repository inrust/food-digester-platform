import { translate } from '../../i18n/i18n.js';
/**
 * FE-14 Media 纯逻辑：枚举文案、过期判定、安全降级与 CT-06 锚点。
 *
 * - DEC-024：下载 URL 15 分钟（900s）有效；过期后重新申请（不持久缓存授权 URL）；
 * - DEC-005：DELETED = 文件到期删除、元数据保留，不提供下载；
 * - DEC-009：不提供实时流媒体会话（无实时播放/停止；视频仅录制文件的受控查看）；
 * - 未知媒体类型安全降级：仅展示元数据，不渲染 img/video、不提供下载入口。
 */
import type { MediaStatus, MediaType } from './types.js';
export { zonedDateTimeToUtcIso as localDateTimeToUtcIso } from '../../components/date-time.js';
export const MEDIA_TYPE_OPTIONS: readonly MediaType[] = ['IMAGE', 'VIDEO'];
export const MEDIA_TYPE_LABELS: Readonly<Record<MediaType, string>> = {
  get IMAGE() {
    return translate('ui.be8da62ea113');
  },
  get VIDEO() {
    return translate('ui.fa4e33b69853');
  },
};
export const MEDIA_STATUS_OPTIONS: readonly MediaStatus[] = ['AVAILABLE', 'DELETED'];
export const MEDIA_STATUS_LABELS: Readonly<Record<MediaStatus, string>> = {
  get AVAILABLE() {
    return translate('ui.269cd52eafed');
  },
  get DELETED() {
    return translate('ui.20cfca6c90b7');
  },
};
/** DEC-024 预签名下载 URL 有效期（秒，冻结值 900=15 分钟）。 */
export const DOWNLOAD_URL_TTL_SEC = 900;
/** 下载 URL 是否已过期（到期时刻 ≤ 当前时刻视为过期，需重新申请）。 */
export function isDownloadUrlExpired(expiresAt: string, now: Date): boolean {
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) return true;
  return expires <= now.getTime();
}
/** 运行时防御：媒体类型白名单（契约枚举外一律按未知类型安全降级）。 */
export function isKnownMediaType(mediaType: string): mediaType is MediaType {
  return mediaType === 'IMAGE' || mediaType === 'VIDEO';
}
/** 媒体类型显示文案（未知类型降级为“未知类型”，不抛出）。 */
export function mediaTypeLabel(mediaType: string): string {
  return isKnownMediaType(mediaType) ? MEDIA_TYPE_LABELS[mediaType] : translate('ui.e9649f84f93c');
}
// ---------- CT-06 锚点（FE-14 相关元素；双向锁定见 contract-parity.test.ts） ----------
export const MEDIA_COVERAGE: Readonly<Record<string, string>> = {
  // device-view “最新授权 Media 预览（替代实时画面）”：由可复用 MediaPreview 组件承载
  // （设备查看页当前展示元数据面板 console-media，可嵌入本组件升级为受控预览）
  'device-view.field.mediaPreview': 'media-preview',
};
