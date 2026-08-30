/**
 * BE-DUSR-01 Device User 管理 API 错误。错误码对齐 CT-05（contracts/rest/error-codes.json）。
 */

export type AdminDeviceUserErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'VERSION_CONFLICT';

export const ADMIN_DEVICE_USER_ERROR_HTTP_STATUS: Readonly<Record<AdminDeviceUserErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
} as const;

export class AdminDeviceUserError extends Error {
  override readonly name = 'AdminDeviceUserError';
  readonly code: AdminDeviceUserErrorCode;

  constructor(code: AdminDeviceUserErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_DEVICE_USER_ERROR_HTTP_STATUS[this.code];
  }
}

export function deviceUserValidationFailed(message: string): AdminDeviceUserError {
  return new AdminDeviceUserError('VALIDATION_FAILED', message);
}

/** 404（跨 Customer 访问同 404，不泄露存在性）。 */
export function deviceUserNotFound(): AdminDeviceUserError {
  return new AdminDeviceUserError('NOT_FOUND', 'The requested resource was not found');
}

/** 409：用户名冲突 / 跨 Customer 分配 / 停用用户新分配 / 重复状态操作。 */
export function deviceUserConflict(message: string): AdminDeviceUserError {
  return new AdminDeviceUserError('CONFLICT', message);
}

/** 409：If-Match 版本与当前版本不一致。 */
export function deviceUserVersionConflict(): AdminDeviceUserError {
  return new AdminDeviceUserError('VERSION_CONFLICT', 'The resource was modified concurrently; refresh and retry');
}
