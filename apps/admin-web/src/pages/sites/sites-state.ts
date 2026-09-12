import { translate } from '../../i18n/i18n.js';
/**
 * FE-05 Site 表单纯逻辑：客户端校验（IANA 时区、邮箱格式、长度上限），与契约约束一致。
 */
import type { SiteInput } from './types.js';
/** IANA 时区标识校验（Intl 运行时校验，拒绝 Mars/Olympus 等非法值）。 */
export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
export type SiteFieldErrors = Partial<Record<'name' | 'timezone' | 'contactEmail', string>>;
/** 返回空对象 = 校验通过；仅客户端预检，最终以后端 VALIDATION_FAILED 为准。 */
export function validateSiteInput(input: SiteInput): SiteFieldErrors {
  const errors: SiteFieldErrors = {};
  const name = input.name.trim();
  if (name.length === 0 || name.length > 200) errors.name = translate('ui.e8b3c29e2520');
  if (!isValidTimeZone(input.timezone)) errors.timezone = translate('ui.f52063bad7b6');
  if (
    input.contactEmail !== null &&
    input.contactEmail.trim() !== '' &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.contactEmail)
  ) {
    errors.contactEmail = translate('ui.4f0599f86e3f');
  }
  return errors;
}
