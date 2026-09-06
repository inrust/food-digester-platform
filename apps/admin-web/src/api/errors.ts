/**
 * FE-01 API 客户端错误类型（CT-05 错误包络 { error: { code, message, requestId } }）。
 */

export class ApiClientError extends Error {
  readonly status: number;

  readonly code: string;

  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null = null) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** 401（含刷新失败）：会话已清除，调用方路由回登录页。 */
export class UnauthenticatedError extends Error {
  constructor(message = 'The session is no longer valid') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/** 403：身份有效但无权限；会话保留，调用方显示无权界面。 */
export class ForbiddenError extends ApiClientError {
  constructor(code: string, message: string, requestId: string | null = null) {
    super(403, code, message, requestId);
    this.name = 'ForbiddenError';
  }
}
