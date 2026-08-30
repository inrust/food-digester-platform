/**
 * BE-CNS-01 耗材 API 错误。错误码对齐 CT-05（contracts/rest/error-codes.json）。
 */

export type AdminConsumableErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'VERSION_CONFLICT';

export const ADMIN_CONSUMABLE_ERROR_HTTP_STATUS: Readonly<Record<AdminConsumableErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
} as const;

export class AdminConsumableError extends Error {
  override readonly name = 'AdminConsumableError';
  readonly code: AdminConsumableErrorCode;

  constructor(code: AdminConsumableErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_CONSUMABLE_ERROR_HTTP_STATUS[this.code];
  }
}

export function consumableValidationFailed(message: string): AdminConsumableError {
  return new AdminConsumableError('VALIDATION_FAILED', message);
}

export function consumableNotFound(): AdminConsumableError {
  return new AdminConsumableError('NOT_FOUND', 'The requested resource was not found');
}

/** 409：非法状态迁移 / 设备未分配 Customer 等冲突。 */
export function consumableConflict(message: string): AdminConsumableError {
  return new AdminConsumableError('CONFLICT', message);
}

/** 409：If-Match 版本与当前版本不一致。 */
export function consumableVersionConflict(): AdminConsumableError {
  return new AdminConsumableError('VERSION_CONFLICT', 'The resource was modified concurrently; refresh and retry');
}
