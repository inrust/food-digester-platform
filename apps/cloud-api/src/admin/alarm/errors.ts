/**
 * BE-ALM-01 Alarm/Event/Tamper API 错误。错误码对齐 CT-05（contracts/rest/error-codes.json）。
 */

export type AdminAlarmErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT';

export const ADMIN_ALARM_ERROR_HTTP_STATUS: Readonly<Record<AdminAlarmErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
} as const;

export class AdminAlarmError extends Error {
  override readonly name = 'AdminAlarmError';
  readonly code: AdminAlarmErrorCode;

  constructor(code: AdminAlarmErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_ALARM_ERROR_HTTP_STATUS[this.code];
  }
}

export function alarmValidationFailed(message: string): AdminAlarmError {
  return new AdminAlarmError('VALIDATION_FAILED', message);
}

export function alarmNotFound(): AdminAlarmError {
  return new AdminAlarmError('NOT_FOUND', 'The requested resource was not found');
}

/** 409：非法状态迁移 / 并发状态漂移。 */
export function alarmConflict(message: string): AdminAlarmError {
  return new AdminAlarmError('CONFLICT', message);
}
