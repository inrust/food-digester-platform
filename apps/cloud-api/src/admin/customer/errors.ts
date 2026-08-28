/**
 * BE-CUS-01 Customer 管理 API 错误。
 *
 * 错误码对齐 CT-05 稳定错误码目录（contracts/rest/error-codes.json），一致性由
 * test/admin-customer.test.ts 的契约一致性用例强制；message 必须对客户端安全。
 */

export type AdminCustomerErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'VERSION_CONFLICT';

export const ADMIN_CUSTOMER_ERROR_HTTP_STATUS: Readonly<Record<AdminCustomerErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
} as const;

export class AdminCustomerError extends Error {
  override readonly name = 'AdminCustomerError';
  readonly code: AdminCustomerErrorCode;

  constructor(code: AdminCustomerErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_CUSTOMER_ERROR_HTTP_STATUS[this.code];
  }
}

export function validationFailed(message: string): AdminCustomerError {
  return new AdminCustomerError('VALIDATION_FAILED', message);
}

export function customerNotFound(): AdminCustomerError {
  return new AdminCustomerError('NOT_FOUND', 'The requested resource was not found');
}

/** 409：If-Match 版本与当前版本不一致。 */
export function versionConflict(): AdminCustomerError {
  return new AdminCustomerError('VERSION_CONFLICT', 'The resource was modified concurrently; refresh and retry');
}

/** 409：Customer 已处于 SUSPENDED（重复停用）。 */
export function alreadySuspended(): AdminCustomerError {
  return new AdminCustomerError('CONFLICT', 'The customer is already suspended');
}

/** 409：存在关联有效设备/License，禁止删除（受约束删除的明确错误）。 */
export function deleteConstrained(message: string): AdminCustomerError {
  return new AdminCustomerError('CONFLICT', message);
}
