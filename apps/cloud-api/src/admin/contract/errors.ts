/**
 * BE-CON-01 Contract CRUD 与状态 API 错误。
 *
 * 错误码对齐 CT-05 稳定错误码目录（contracts/rest/error-codes.json），一致性由
 * test/admin-contract.test.ts 的契约一致性用例强制；message 必须对客户端安全。
 */

export type AdminContractErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'VERSION_CONFLICT';

export const ADMIN_CONTRACT_ERROR_HTTP_STATUS: Readonly<Record<AdminContractErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
} as const;

export class AdminContractError extends Error {
  override readonly name = 'AdminContractError';
  readonly code: AdminContractErrorCode;

  constructor(code: AdminContractErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_CONTRACT_ERROR_HTTP_STATUS[this.code];
  }
}

export function contractValidationFailed(message: string): AdminContractError {
  return new AdminContractError('VALIDATION_FAILED', message);
}

export function contractNotFound(): AdminContractError {
  return new AdminContractError('NOT_FOUND', 'The requested resource was not found');
}

/** 409：contractNumber 全局唯一冲突 / 非法状态迁移。 */
export function contractConflict(message: string): AdminContractError {
  return new AdminContractError('CONFLICT', message);
}

/** 409：If-Match 版本与当前版本不一致。 */
export function contractVersionConflict(): AdminContractError {
  return new AdminContractError('VERSION_CONFLICT', 'The resource was modified concurrently; refresh and retry');
}
