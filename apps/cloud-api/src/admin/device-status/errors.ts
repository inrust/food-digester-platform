/**
 * BE-DEV-03 Device Suspend/Reactivate API 错误。
 *
 * 错误码对齐 CT-05 稳定错误码目录（contracts/rest/error-codes.json），一致性由
 * test/admin-device-status.test.ts 的契约一致性用例强制；message 必须对客户端安全。
 */

export type AdminDeviceStatusErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'DEVICE_STATE_NOT_ALLOWED';

export const ADMIN_DEVICE_STATUS_ERROR_HTTP_STATUS: Readonly<Record<AdminDeviceStatusErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DEVICE_STATE_NOT_ALLOWED: 409,
} as const;

export class AdminDeviceStatusError extends Error {
  override readonly name = 'AdminDeviceStatusError';
  readonly code: AdminDeviceStatusErrorCode;

  constructor(code: AdminDeviceStatusErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_DEVICE_STATUS_ERROR_HTTP_STATUS[this.code];
  }
}

export function deviceStatusValidationFailed(message: string): AdminDeviceStatusError {
  return new AdminDeviceStatusError('VALIDATION_FAILED', message);
}

export function deviceStatusNotFound(): AdminDeviceStatusError {
  return new AdminDeviceStatusError('NOT_FOUND', 'The requested resource was not found');
}

/** 409：生命周期不允许该转换（suspend 仅 Active；reactivate 仅 Suspended）。 */
export function deviceStatusTransitionNotAllowed(lifecycleStatus: string, action: string): AdminDeviceStatusError {
  return new AdminDeviceStatusError(
    'DEVICE_STATE_NOT_ALLOWED',
    `The device lifecycle status ${lifecycleStatus} does not allow ${action}`,
  );
}

/** 409：并发状态冲突（生命周期已被其他请求改变）。 */
export function deviceStatusConflict(): AdminDeviceStatusError {
  return new AdminDeviceStatusError('CONFLICT', 'The device state was changed concurrently; refresh and retry');
}
