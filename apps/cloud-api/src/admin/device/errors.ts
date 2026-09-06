/**
 * BE-DEV-01 Device 台账查询 API 错误。
 *
 * 错误码对齐 CT-05 稳定错误码目录（contracts/rest/error-codes.json），一致性由
 * test/admin-device.test.ts 的契约一致性用例强制；message 必须对客户端安全。
 */

export type AdminDeviceErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'VERSION_CONFLICT';

export const ADMIN_DEVICE_ERROR_HTTP_STATUS: Readonly<Record<AdminDeviceErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
} as const;

export class AdminDeviceError extends Error {
  override readonly name = 'AdminDeviceError';
  readonly code: AdminDeviceErrorCode;

  constructor(code: AdminDeviceErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_DEVICE_ERROR_HTTP_STATUS[this.code];
  }
}

export function deviceValidationFailed(message: string): AdminDeviceError {
  return new AdminDeviceError('VALIDATION_FAILED', message);
}

export function deviceNotFound(): AdminDeviceError {
  return new AdminDeviceError('NOT_FOUND', 'The requested resource was not found');
}

/** alias 在同一 Customer 内冲突（暂定唯一性规则，见 BE-DEV-06 文档）。 */
export function deviceAliasConflict(): AdminDeviceError {
  return new AdminDeviceError('CONFLICT', 'The alias is already used by another device in the same customer');
}

/** If-Match 过期/并发漂移（BE-DEV-06 乐观锁）。 */
export function deviceVersionConflict(): AdminDeviceError {
  return new AdminDeviceError('VERSION_CONFLICT', 'The resource was modified concurrently; refresh and retry');
}
