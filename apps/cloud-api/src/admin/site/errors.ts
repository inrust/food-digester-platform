/**
 * BE-CUS-02 Site 管理 API 错误。
 *
 * 错误码对齐 CT-05 稳定错误码目录（contracts/rest/error-codes.json），一致性由
 * test/admin-site.test.ts 的契约一致性用例强制；message 必须对客户端安全。
 */

export type AdminSiteErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'VERSION_CONFLICT';

export const ADMIN_SITE_ERROR_HTTP_STATUS: Readonly<Record<AdminSiteErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
} as const;

export class AdminSiteError extends Error {
  override readonly name = 'AdminSiteError';
  readonly code: AdminSiteErrorCode;

  constructor(code: AdminSiteErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ADMIN_SITE_ERROR_HTTP_STATUS[this.code];
  }
}

export function siteValidationFailed(message: string): AdminSiteError {
  return new AdminSiteError('VALIDATION_FAILED', message);
}

export function siteNotFound(): AdminSiteError {
  return new AdminSiteError('NOT_FOUND', 'The requested resource was not found');
}

/** 404：所属 Customer 不存在或已删除（错误 Customer 拒绝）。 */
export function siteCustomerNotFound(): AdminSiteError {
  return new AdminSiteError('NOT_FOUND', 'The referenced customer does not exist');
}

/** 409：If-Match 版本与当前版本不一致。 */
export function siteVersionConflict(): AdminSiteError {
  return new AdminSiteError('VERSION_CONFLICT', 'The resource was modified concurrently; refresh and retry');
}

/** 409：同 Customer 下 Site 名称重复（@@unique([customerId, name])）。 */
export function siteNameConflict(): AdminSiteError {
  return new AdminSiteError('CONFLICT', 'A site with the same name already exists in this customer');
}

/** 409：Site 已处于 SUSPENDED（重复停用）。 */
export function siteAlreadySuspended(): AdminSiteError {
  return new AdminSiteError('CONFLICT', 'The site is already suspended');
}

/** 409：存在关联设备，禁止删除（受约束删除的明确错误）。 */
export function siteDeleteConstrained(message: string): AdminSiteError {
  return new AdminSiteError('CONFLICT', message);
}
