/**
 * Media API 错误：基础码对齐 CT-05，触发引用错误为 createMediaUploadSession 的局部契约扩展。
 */

export type MediaErrorCode =
  'VALIDATION_FAILED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'MEDIA_TRIGGER_CONFLICT' | 'MEDIA_ALREADY_REGISTERED';

export const MEDIA_ERROR_HTTP_STATUS: Readonly<Record<MediaErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  MEDIA_TRIGGER_CONFLICT: 409,
  MEDIA_ALREADY_REGISTERED: 409,
} as const;

export class MediaError extends Error {
  override readonly name = 'MediaError';
  readonly code: MediaErrorCode;

  constructor(
    code: MediaErrorCode,
    message?: string,
    readonly details?: { readonly mediaId: string },
  ) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return MEDIA_ERROR_HTTP_STATUS[this.code];
  }
}

export function mediaValidationFailed(message: string): MediaError {
  return new MediaError('VALIDATION_FAILED', message);
}

export function mediaForbidden(message: string): MediaError {
  return new MediaError('FORBIDDEN', message);
}

export function mediaNotFound(): MediaError {
  return new MediaError('NOT_FOUND', 'The requested resource was not found');
}

/** 业务冲突：每设备每日上传配额超限等。 */
export function mediaConflict(message: string): MediaError {
  return new MediaError('CONFLICT', message);
}
