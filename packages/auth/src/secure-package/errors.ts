/**
 * SEC-01 证书包服务错误。错误码对齐 CT-05 目录（一致性由 contract-parity 测试覆盖）。
 */
import { AUTH_ERROR_DEFAULT_MESSAGE } from '../errors.js';

export type SecurePackageErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'CORRUPT_PACKAGE';

const HTTP_STATUS: Readonly<Record<SecurePackageErrorCode, number>> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  FORBIDDEN: 403,
  CORRUPT_PACKAGE: 500,
} as const;

const DEFAULT_MESSAGE: Readonly<Record<SecurePackageErrorCode, string>> = {
  NOT_FOUND: 'The requested resource was not found',
  CONFLICT: 'The request conflicts with the current state of the resource',
  FORBIDDEN: AUTH_ERROR_DEFAULT_MESSAGE.FORBIDDEN,
  // 完整性失败属服务端内部错误，对外不暴露细节
  CORRUPT_PACKAGE: 'Internal server error',
} as const;

export class SecurePackageError extends Error {
  override readonly name = 'SecurePackageError';
  readonly code: SecurePackageErrorCode;

  constructor(code: SecurePackageErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.code = code;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}
