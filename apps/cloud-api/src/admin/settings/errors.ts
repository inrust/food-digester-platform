/**
 * BE-SET-01 业务设置错误。错误码对齐 CT-05（contracts/rest/error-codes.json）。
 */

export type AdminSettingsErrorCode = 'VALIDATION_FAILED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VERSION_CONFLICT';

export const ADMIN_SETTINGS_ERROR_HTTP_STATUS: Readonly<Record<AdminSettingsErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
} as const;

export class AdminSettingsError extends Error {
  override readonly name = 'AdminSettingsError';
  readonly code: AdminSettingsErrorCode;

  constructor(code: AdminSettingsErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_SETTINGS_ERROR_HTTP_STATUS[this.code];
  }
}

/** 非法配置：值 Schema 不符、触碰固定协议枚举（未知 command/topic/notification code）。 */
export function settingsValidationFailed(message: string): AdminSettingsError {
  return new AdminSettingsError('VALIDATION_FAILED', message);
}

/** 未知设置 key（封闭集之外不可创建/读取）。 */
export function settingsNotFound(): AdminSettingsError {
  return new AdminSettingsError('NOT_FOUND', 'The requested resource was not found');
}

/** 并发修改冲突：携带的 version 已过期。 */
export function settingsVersionConflict(): AdminSettingsError {
  return new AdminSettingsError('VERSION_CONFLICT', 'The resource was modified concurrently; refresh and retry');
}
