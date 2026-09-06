/**
 * BE-DEV-05 设备控制台错误。错误码对齐 CT-05（contracts/rest/error-codes.json）。
 */

export type DeviceConsoleErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND';

export const DEVICE_CONSOLE_ERROR_HTTP_STATUS: Readonly<Record<DeviceConsoleErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
} as const;

export class DeviceConsoleError extends Error {
  override readonly name = 'DeviceConsoleError';
  readonly code: DeviceConsoleErrorCode;

  constructor(code: DeviceConsoleErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return DEVICE_CONSOLE_ERROR_HTTP_STATUS[this.code];
  }
}

export function consoleValidationFailed(message: string): DeviceConsoleError {
  return new DeviceConsoleError('VALIDATION_FAILED', message);
}

/** 设备/导出任务不存在或跨 Customer（不泄露存在性）。 */
export function consoleNotFound(): DeviceConsoleError {
  return new DeviceConsoleError('NOT_FOUND', 'The requested resource was not found');
}
