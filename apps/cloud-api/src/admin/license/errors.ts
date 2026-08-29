/**
 * BE-LIC-01 License/Entitlement API 错误。
 *
 * 错误码对齐 CT-05 稳定错误码目录（contracts/rest/error-codes.json），一致性由
 * test/admin-license.test.ts 的契约一致性用例强制；message 必须对客户端安全。
 */

export type AdminLicenseErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'DEVICE_STATE_NOT_ALLOWED';

export const ADMIN_LICENSE_ERROR_HTTP_STATUS: Readonly<Record<AdminLicenseErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DEVICE_STATE_NOT_ALLOWED: 409,
} as const;

export class AdminLicenseError extends Error {
  override readonly name = 'AdminLicenseError';
  readonly code: AdminLicenseErrorCode;

  constructor(code: AdminLicenseErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_LICENSE_ERROR_HTTP_STATUS[this.code];
  }
}

export function licenseValidationFailed(message: string): AdminLicenseError {
  return new AdminLicenseError('VALIDATION_FAILED', message);
}

export function licenseNotFound(): AdminLicenseError {
  return new AdminLicenseError('NOT_FOUND', 'The requested resource was not found');
}

/** 409：一个设备不能出现两个有效 License（DB 部分唯一索引兜底）。 */
export function licenseConflict(message: string): AdminLicenseError {
  return new AdminLicenseError('CONFLICT', message);
}

/** 409：设备/License 状态不允许该操作。 */
export function licenseStateNotAllowed(message: string): AdminLicenseError {
  return new AdminLicenseError('DEVICE_STATE_NOT_ALLOWED', message);
}
