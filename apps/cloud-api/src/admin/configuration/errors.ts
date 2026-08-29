/**
 * BE-CFG-01 Configuration 版本管理 API 错误。
 *
 * 错误码对齐 CT-05 稳定错误码目录（contracts/rest/error-codes.json），一致性由
 * test/admin-configuration.test.ts 的契约一致性用例强制；message 必须对客户端安全。
 */

export type AdminConfigurationErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT';

export const ADMIN_CONFIGURATION_ERROR_HTTP_STATUS: Readonly<Record<AdminConfigurationErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
} as const;

export class AdminConfigurationError extends Error {
  override readonly name = 'AdminConfigurationError';
  readonly code: AdminConfigurationErrorCode;

  constructor(code: AdminConfigurationErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_CONFIGURATION_ERROR_HTTP_STATUS[this.code];
  }
}

export function configurationValidationFailed(message: string): AdminConfigurationError {
  return new AdminConfigurationError('VALIDATION_FAILED', message);
}

export function configurationNotFound(): AdminConfigurationError {
  return new AdminConfigurationError('NOT_FOUND', 'The requested resource was not found');
}

/** 409：版本冲突（重复版本号 / 已发布不可覆盖 / 并发发布）。 */
export function configurationConflict(message: string): AdminConfigurationError {
  return new AdminConfigurationError('CONFLICT', message);
}
