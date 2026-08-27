/**
 * BE-ONB-01 业务错误。
 *
 * 错误码对齐 CT-05 稳定错误码目录（contracts/rest/error-codes.json），一致性由
 * test/onboarding-contract-parity.test.ts 强制；message 必须对客户端安全，
 * 不携带堆栈、SQL 或 AWS 内部细节（与 contracts/rest/http-contract.ts 约定一致）。
 */

export type OnboardingApiErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'DEVICE_STATE_NOT_ALLOWED' | 'INTERNAL_ERROR';

export const ONBOARDING_API_ERROR_HTTP_STATUS: Readonly<Record<OnboardingApiErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  DEVICE_STATE_NOT_ALLOWED: 409,
  INTERNAL_ERROR: 500,
} as const;

export const ONBOARDING_API_ERROR_DEFAULT_MESSAGE: Readonly<Record<OnboardingApiErrorCode, string>> = {
  VALIDATION_FAILED: 'The request failed validation',
  NOT_FOUND: 'The requested resource was not found',
  DEVICE_STATE_NOT_ALLOWED: 'The operation is not allowed in the current device state',
  INTERNAL_ERROR: 'Internal server error',
} as const;

export class OnboardingApiError extends Error {
  override readonly name = 'OnboardingApiError';
  readonly code: OnboardingApiErrorCode;

  constructor(code: OnboardingApiErrorCode, message?: string) {
    super(message ?? ONBOARDING_API_ERROR_DEFAULT_MESSAGE[code]);
    this.code = code;
  }

  get httpStatus(): number {
    return ONBOARDING_API_ERROR_HTTP_STATUS[this.code];
  }
}

/** 400：请求字段缺失/非法。 */
export function validationFailed(message: string): OnboardingApiError {
  return new OnboardingApiError('VALIDATION_FAILED', message);
}

/** 404：序列号不存在于设备库存（对调用方不可见等同不存在）。 */
export function serialNumberNotFound(): OnboardingApiError {
  return new OnboardingApiError('NOT_FOUND', 'The serial number does not exist in the device inventory');
}

/** 409：设备已离开 PendingOnboarding（含已 Onboarded），不允许再提交申请。 */
export function deviceStateNotAllowed(): OnboardingApiError {
  return new OnboardingApiError(
    'DEVICE_STATE_NOT_ALLOWED',
    'The device is not in a state that allows an onboarding request',
  );
}
