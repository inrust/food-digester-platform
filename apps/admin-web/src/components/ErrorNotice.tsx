import { Button } from './ui.js';
/**
 * FE-02 统一错误提示：解析 FE-01 API 客户端错误（CT-05 code/message/requestId）。
 * FE-19：全部文案经 i18n 资源（错误码统一映射表，两种语言）；requestId 原文保留。
 *
 * - 403 → 无权界面文案（身份有效但无权限）；
 * - 409 VERSION_CONFLICT → If-Match 冲突：提示刷新并提供刷新按钮；
 * - 其余 → 通用错误 + code/requestId（服务端 message 为后端数据，原文展示不翻译）。
 */
import { ApiClientError, ForbiddenError } from '../api/errors.js';
import { useI18n } from '../i18n/i18n.js';

export type ErrorNoticeVariant = 'forbidden' | 'version-conflict' | 'generic';

export interface ErrorNoticeModel {
  readonly variant: ErrorNoticeVariant;
  readonly code: string | null;
  readonly requestId: string | null;
  /** 服务端错误消息（后端数据，原文展示；非 API 错误为 null）。 */
  readonly serverMessage: string | null;
}

export function classifyError(error: unknown): ErrorNoticeModel {
  if (error instanceof ForbiddenError || (error instanceof ApiClientError && error.status === 403)) {
    return {
      variant: 'forbidden',
      code: error instanceof ApiClientError ? error.code : 'FORBIDDEN',
      requestId: error instanceof ApiClientError ? error.requestId : null,
      serverMessage: null,
    };
  }
  if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') {
    return { variant: 'version-conflict', code: error.code, requestId: error.requestId, serverMessage: null };
  }
  if (error instanceof ApiClientError) {
    return { variant: 'generic', code: error.code, requestId: error.requestId, serverMessage: error.message };
  }
  return { variant: 'generic', code: null, requestId: null, serverMessage: null };
}

export interface ErrorNoticeProps {
  readonly error: unknown;
  /** VERSION_CONFLICT 时显示“刷新”按钮。 */
  readonly onRefresh?: () => void;
}

export function ErrorNotice({ error, onRefresh }: ErrorNoticeProps) {
  const { t } = useI18n();
  const model = classifyError(error);
  const title =
    model.variant === 'forbidden'
      ? t('error.forbidden.title')
      : model.variant === 'version-conflict'
        ? t('error.versionConflict.title')
        : t('error.generic.title');
  const detail =
    model.variant === 'forbidden'
      ? t('error.forbidden.detail')
      : model.variant === 'version-conflict'
        ? t('error.versionConflict.detail')
        : (model.serverMessage ?? t('error.generic.detail'));
  return (
    <div className={`error-notice ${model.variant}`} role="alert" data-testid={`error-${model.variant}`}>
      <strong>{title}</strong>
      <p>{detail}</p>
      {model.code !== null ? (
        <span className="error-code">
          {t('error.codeLabel')}
          {model.code}
        </span>
      ) : null}
      {model.requestId !== null ? <span className="error-request-id">requestId：{model.requestId}</span> : null}
      {model.variant === 'version-conflict' && onRefresh !== undefined ? (
        <Button type="button" onClick={onRefresh}>
          {t('common.refresh')}
        </Button>
      ) : null}
    </div>
  );
}
