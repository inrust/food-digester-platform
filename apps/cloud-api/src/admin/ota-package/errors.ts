/**
 * BE-OTA-01 Firmware Package API 错误。错误码对齐 CT-05（contracts/rest/error-codes.json）。
 */

export type AdminOtaPackageErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT';

export const ADMIN_OTA_PACKAGE_ERROR_HTTP_STATUS: Readonly<Record<AdminOtaPackageErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
} as const;

export class AdminOtaPackageError extends Error {
  override readonly name = 'AdminOtaPackageError';
  readonly code: AdminOtaPackageErrorCode;

  constructor(code: AdminOtaPackageErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_OTA_PACKAGE_ERROR_HTTP_STATUS[this.code];
  }
}

export function otaValidationFailed(message: string): AdminOtaPackageError {
  return new AdminOtaPackageError('VALIDATION_FAILED', message);
}

export function otaPackageNotFound(): AdminOtaPackageError {
  return new AdminOtaPackageError('NOT_FOUND', 'The requested resource was not found');
}

/** 业务冲突：同型号+版本+packageType 重复、VERIFIED 包重复完成（不可覆盖）等。 */
export function otaPackageConflict(message: string): AdminOtaPackageError {
  return new AdminOtaPackageError('CONFLICT', message);
}

/** 签名策略未冻结（provisional）：验签失败关闭，任何包不得进入 VERIFIED。 */
export function otaSignaturePolicyPending(): AdminOtaPackageError {
  return new AdminOtaPackageError(
    'CONFLICT',
    'The firmware signature policy is not frozen; signature verification is fail-closed',
  );
}
