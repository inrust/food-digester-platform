/**
 * BE-AUD-01 审计日志查询错误。错误码对齐 CT-05（contracts/rest/error-codes.json）。
 */

export type AdminAuditErrorCode = 'VALIDATION_FAILED' | 'FORBIDDEN' | 'NOT_FOUND';

export const ADMIN_AUDIT_ERROR_HTTP_STATUS: Readonly<Record<AdminAuditErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
} as const;

export class AdminAuditError extends Error {
  override readonly name = 'AdminAuditError';
  readonly code: AdminAuditErrorCode;

  constructor(code: AdminAuditErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_AUDIT_ERROR_HTTP_STATUS[this.code];
  }
}

export function auditValidationFailed(message: string): AdminAuditError {
  return new AdminAuditError('VALIDATION_FAILED', message);
}

/** Customer actor 越权筛选（查询他人 Customer 审计）。 */
export function auditForbidden(message: string): AdminAuditError {
  return new AdminAuditError('FORBIDDEN', message);
}

export function auditNotFound(): AdminAuditError {
  return new AdminAuditError('NOT_FOUND', 'The requested resource was not found');
}
