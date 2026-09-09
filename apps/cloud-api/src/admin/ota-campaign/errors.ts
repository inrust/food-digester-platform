/**
 * BE-OTA-02 OTA Campaign API 错误。错误码对齐 CT-05（contracts/rest/error-codes.json）。
 */

export type AdminOtaCampaignErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT';

export const ADMIN_OTA_CAMPAIGN_ERROR_HTTP_STATUS: Readonly<Record<AdminOtaCampaignErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  CONFLICT: 409,
} as const;

export class AdminOtaCampaignError extends Error {
  override readonly name = 'AdminOtaCampaignError';
  readonly code: AdminOtaCampaignErrorCode;

  constructor(code: AdminOtaCampaignErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_OTA_CAMPAIGN_ERROR_HTTP_STATUS[this.code];
  }
}

export function otaCampaignValidationFailed(message: string): AdminOtaCampaignError {
  return new AdminOtaCampaignError('VALIDATION_FAILED', message);
}

export function otaCampaignNotFound(): AdminOtaCampaignError {
  return new AdminOtaCampaignError('NOT_FOUND', 'The requested resource was not found');
}

export function otaCampaignForbidden(message: string): AdminOtaCampaignError {
  return new AdminOtaCampaignError('FORBIDDEN', message);
}

/** 非法状态迁移 / 终态再操作（如非 RUNNING 扩大批次、COMPLETED 再取消）。 */
export function otaCampaignConflict(message: string): AdminOtaCampaignError {
  return new AdminOtaCampaignError('CONFLICT', message);
}
