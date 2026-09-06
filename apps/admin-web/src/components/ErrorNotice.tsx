/**
 * FE-02 统一错误提示：解析 FE-01 API 客户端错误（CT-05 code/message/requestId）。
 *
 * - 403 → 无权界面文案（身份有效但无权限）；
 * - 409 VERSION_CONFLICT → If-Match 冲突：提示刷新并提供刷新按钮；
 * - 其余 → 通用错误 + code/requestId。
 */
import { ApiClientError, ForbiddenError } from '../api/errors.js';

export type ErrorNoticeVariant = 'forbidden' | 'version-conflict' | 'generic';

export interface ErrorNoticeModel {
  readonly variant: ErrorNoticeVariant;
  readonly title: string;
  readonly detail: string;
  readonly code: string | null;
  readonly requestId: string | null;
}

export function classifyError(error: unknown): ErrorNoticeModel {
  if (error instanceof ForbiddenError || (error instanceof ApiClientError && error.status === 403)) {
    return {
      variant: 'forbidden',
      title: '无权访问',
      detail: '当前角色无权查看或操作该数据。如认为有误，请联系管理员。',
      code: error instanceof ApiClientError ? error.code : 'FORBIDDEN',
      requestId: error instanceof ApiClientError ? error.requestId : null,
    };
  }
  if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') {
    return {
      variant: 'version-conflict',
      title: '数据已被他人修改',
      detail: '当前页面数据版本已过期，请刷新后重试。',
      code: error.code,
      requestId: error.requestId,
    };
  }
  if (error instanceof ApiClientError) {
    return {
      variant: 'generic',
      title: '操作失败',
      detail: error.message,
      code: error.code,
      requestId: error.requestId,
    };
  }
  return {
    variant: 'generic',
    title: '操作失败',
    detail: '网络或服务暂不可用，请稍后重试。',
    code: null,
    requestId: null,
  };
}

export interface ErrorNoticeProps {
  readonly error: unknown;
  /** VERSION_CONFLICT 时显示“刷新”按钮。 */
  readonly onRefresh?: () => void;
}

export function ErrorNotice({ error, onRefresh }: ErrorNoticeProps) {
  const model = classifyError(error);
  return (
    <div className={`error-notice ${model.variant}`} role="alert" data-testid={`error-${model.variant}`}>
      <strong>{model.title}</strong>
      <p>{model.detail}</p>
      {model.code !== null ? <span className="error-code">错误码：{model.code}</span> : null}
      {model.requestId !== null ? <span className="error-request-id">requestId：{model.requestId}</span> : null}
      {model.variant === 'version-conflict' && onRefresh !== undefined ? (
        <button type="button" onClick={onRefresh}>
          刷新
        </button>
      ) : null}
    </div>
  );
}
