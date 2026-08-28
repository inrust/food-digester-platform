/**
 * BE-DEV-02 Device Assignment API 错误。
 *
 * 错误码对齐 CT-05 稳定错误码目录（contracts/rest/error-codes.json），一致性由
 * test/admin-device-assignment.test.ts 的契约一致性用例强制；message 必须对客户端安全。
 */

export type AdminAssignmentErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'DEVICE_STATE_NOT_ALLOWED';

export const ADMIN_ASSIGNMENT_ERROR_HTTP_STATUS: Readonly<Record<AdminAssignmentErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DEVICE_STATE_NOT_ALLOWED: 409,
} as const;

export class AdminAssignmentError extends Error {
  override readonly name = 'AdminAssignmentError';
  readonly code: AdminAssignmentErrorCode;

  constructor(code: AdminAssignmentErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_ASSIGNMENT_ERROR_HTTP_STATUS[this.code];
  }
}

export function assignmentValidationFailed(message: string): AdminAssignmentError {
  return new AdminAssignmentError('VALIDATION_FAILED', message);
}

export function assignmentNotFound(message = 'The requested resource was not found'): AdminAssignmentError {
  return new AdminAssignmentError('NOT_FOUND', message);
}

/** 409：设备生命周期不允许分配（仅 Onboarded/Assigned 合法）。 */
export function assignmentStateNotAllowed(lifecycleStatus: string): AdminAssignmentError {
  return new AdminAssignmentError(
    'DEVICE_STATE_NOT_ALLOWED',
    `The device lifecycle status does not allow assignment: ${lifecycleStatus}`,
  );
}

/** 409：并发分配冲突（状态已被其他请求改变）。 */
export function assignmentConflict(message: string): AdminAssignmentError {
  return new AdminAssignmentError('CONFLICT', message);
}
