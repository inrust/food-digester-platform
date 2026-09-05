/**
 * BE-RBAC-01 用户/角色/Scope 管理错误。错误码对齐 CT-05（contracts/rest/error-codes.json）。
 */

export type AdminUserErrorCode = 'VALIDATION_FAILED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT';

export const ADMIN_USER_ERROR_HTTP_STATUS: Readonly<Record<AdminUserErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
} as const;

export class AdminUserError extends Error {
  override readonly name = 'AdminUserError';
  readonly code: AdminUserErrorCode;

  constructor(code: AdminUserErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_USER_ERROR_HTTP_STATUS[this.code];
  }
}

export function userValidationFailed(message: string): AdminUserError {
  return new AdminUserError('VALIDATION_FAILED', message);
}

/** 越权：自我提权、Customer 角色提升平台角色、跨 Customer 授权、非 SuperAdmin 变更平台角色。 */
export function userForbidden(message: string): AdminUserError {
  return new AdminUserError('FORBIDDEN', message);
}

export function userNotFound(): AdminUserError {
  return new AdminUserError('NOT_FOUND', 'The requested resource was not found');
}

/** 业务冲突：email 已存在、最后一个 PlatformSuperAdmin 不可移除/停用等。 */
export function userConflict(message: string): AdminUserError {
  return new AdminUserError('CONFLICT', message);
}
