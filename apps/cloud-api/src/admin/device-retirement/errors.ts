/**
 * BE-DEV-04 Device Retirement 工作流 API 错误。
 *
 * 错误码对齐 CT-05 稳定错误码目录（contracts/rest/error-codes.json），一致性由
 * test/admin-device-retirement.test.ts 的契约一致性用例强制；message 必须对客户端安全。
 */

export type AdminRetirementErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'DEVICE_STATE_NOT_ALLOWED';

export const ADMIN_RETIREMENT_ERROR_HTTP_STATUS: Readonly<Record<AdminRetirementErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DEVICE_STATE_NOT_ALLOWED: 409,
} as const;

export class AdminRetirementError extends Error {
  override readonly name = 'AdminRetirementError';
  readonly code: AdminRetirementErrorCode;

  constructor(code: AdminRetirementErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_RETIREMENT_ERROR_HTTP_STATUS[this.code];
  }
}

export function retirementValidationFailed(message: string): AdminRetirementError {
  return new AdminRetirementError('VALIDATION_FAILED', message);
}

export function retirementNotFound(): AdminRetirementError {
  return new AdminRetirementError('NOT_FOUND', 'The requested resource was not found');
}

/** 409：生命周期不允许（retire 仅 Active/Suspended；force-complete 仅 Retired 待确认）。 */
export function retirementStateNotAllowed(message: string): AdminRetirementError {
  return new AdminRetirementError('DEVICE_STATE_NOT_ALLOWED', message);
}

/** 409：并发冲突（状态/退役记录已被其他请求改变）。 */
export function retirementConflict(message: string): AdminRetirementError {
  return new AdminRetirementError('CONFLICT', message);
}
