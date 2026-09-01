/**
 * BE-CMD-01 Command 创建与授权 API 错误。错误码对齐 CT-05（contracts/rest/error-codes.json）。
 */

export type AdminCommandErrorCode =
  'VALIDATION_FAILED' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'DEVICE_STATE_NOT_ALLOWED';

export const ADMIN_COMMAND_ERROR_HTTP_STATUS: Readonly<Record<AdminCommandErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
  DEVICE_STATE_NOT_ALLOWED: 409,
} as const;

export class AdminCommandError extends Error {
  override readonly name = 'AdminCommandError';
  readonly code: AdminCommandErrorCode;

  constructor(code: AdminCommandErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_COMMAND_ERROR_HTTP_STATUS[this.code];
  }
}

export function commandValidationFailed(message: string): AdminCommandError {
  return new AdminCommandError('VALIDATION_FAILED', message);
}

export function commandNotFound(): AdminCommandError {
  return new AdminCommandError('NOT_FOUND', 'The requested resource was not found');
}

/** 无 REMOTE_CONTROL Entitlement（License 缺失/失效/未启用该能力）。 */
export function commandForbidden(message: string): AdminCommandError {
  return new AdminCommandError('FORBIDDEN', message);
}

export function commandConflict(message: string): AdminCommandError {
  return new AdminCommandError('CONFLICT', message);
}

export function commandStateNotAllowed(message: string): AdminCommandError {
  return new AdminCommandError('DEVICE_STATE_NOT_ALLOWED', message);
}
