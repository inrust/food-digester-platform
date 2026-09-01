/**
 * BE-ESG-02 ESG 查询与导出 API 错误。错误码对齐 CT-05（contracts/rest/error-codes.json）。
 */

export type AdminEsgErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT';

export const ADMIN_ESG_ERROR_HTTP_STATUS: Readonly<Record<AdminEsgErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
} as const;

export class AdminEsgError extends Error {
  override readonly name = 'AdminEsgError';
  readonly code: AdminEsgErrorCode;

  constructor(code: AdminEsgErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_ESG_ERROR_HTTP_STATUS[this.code];
  }
}

export function esgValidationFailed(message: string): AdminEsgError {
  return new AdminEsgError('VALIDATION_FAILED', message);
}

export function esgNotFound(): AdminEsgError {
  return new AdminEsgError('NOT_FOUND', 'The requested resource was not found');
}

/** 409：导出任务并发状态漂移等冲突。 */
export function esgConflict(message: string): AdminEsgError {
  return new AdminEsgError('CONFLICT', message);
}
