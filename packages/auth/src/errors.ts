/**
 * AUTH-01 认证/授权错误。
 *
 * 错误码对齐 CT-05 稳定错误码目录（contracts/rest/error-codes.json）：
 * - UNAUTHENTICATED → 401（缺少/过期/伪造凭证一律 401，不区分原因，避免探测）；
 * - FORBIDDEN → 403（身份有效但无权限，含跨 Customer 访问）。
 *
 * 一致性由 test/contract-parity.test.ts 强制；message 必须对客户端安全，不携带内部细节。
 */

export type AuthErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN';

export const AUTH_ERROR_HTTP_STATUS: Readonly<Record<AuthErrorCode, 401 | 403>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
} as const;

export const AUTH_ERROR_DEFAULT_MESSAGE: Readonly<Record<AuthErrorCode, string>> = {
  UNAUTHENTICATED: 'Authentication is required or the credential is invalid',
  FORBIDDEN: 'The caller is not allowed to perform this operation',
} as const;

export class AuthError extends Error {
  override readonly name = 'AuthError';
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message?: string) {
    super(message ?? AUTH_ERROR_DEFAULT_MESSAGE[code]);
    this.code = code;
  }

  get httpStatus(): 401 | 403 {
    return AUTH_ERROR_HTTP_STATUS[this.code];
  }
}

/** 401：凭证缺失/非法/过期（对外不区分具体原因）。 */
export function unauthenticated(message?: string): AuthError {
  return new AuthError('UNAUTHENTICATED', message);
}

/** 403：角色越权、Customer scope 不匹配、未知角色失败关闭。 */
export function forbidden(message?: string): AuthError {
  return new AuthError('FORBIDDEN', message);
}
