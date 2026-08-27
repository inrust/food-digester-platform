/**
 * BE-ONB-02 管理端审批错误。
 *
 * 错误码对齐 CT-05 稳定错误码目录（contracts/rest/error-codes.json），一致性由
 * test/admin-onboarding-parity.test.ts 强制；message 必须对客户端安全。
 */

export type AdminOnboardingErrorCode =
  'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'VERSION_CONFLICT' | 'INTERNAL_ERROR';

export const ADMIN_ONBOARDING_ERROR_HTTP_STATUS: Readonly<Record<AdminOnboardingErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  INTERNAL_ERROR: 500,
} as const;

export class AdminOnboardingError extends Error {
  override readonly name = 'AdminOnboardingError';
  readonly code: AdminOnboardingErrorCode;

  constructor(code: AdminOnboardingErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_ONBOARDING_ERROR_HTTP_STATUS[this.code];
  }
}

export function validationFailed(message: string): AdminOnboardingError {
  return new AdminOnboardingError('VALIDATION_FAILED', message);
}

export function requestNotFound(): AdminOnboardingError {
  return new AdminOnboardingError('NOT_FOUND', 'The requested resource was not found');
}

/** 409：申请已被审批（重复审批）。 */
export function alreadyReviewed(): AdminOnboardingError {
  return new AdminOnboardingError('CONFLICT', 'The onboarding request has already been reviewed');
}

/** 409：If-Match 版本与当前版本不一致。 */
export function versionConflict(): AdminOnboardingError {
  return new AdminOnboardingError('VERSION_CONFLICT', 'The resource was modified concurrently; refresh and retry');
}

/** 409：设备库存资料与申请内容不一致，或设备状态不允许审批。 */
export function deviceConflict(message: string): AdminOnboardingError {
  return new AdminOnboardingError('CONFLICT', message);
}
