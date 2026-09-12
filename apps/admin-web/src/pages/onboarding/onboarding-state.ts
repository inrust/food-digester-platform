import { translate } from '../../i18n/i18n.js';
/**
 * FE-04 Onboarding 审批纯逻辑：状态文案与审批门控。
 * 事实源：admin-onboarding-api.json（status 枚举）+ BE-ONB-02（仅 PlatformSuperAdmin 审批）。
 */
import type { OnboardingStatus } from './types.js';
export const ONBOARDING_STATUS_LABELS: Readonly<Record<OnboardingStatus, string>> = {
  get PENDING() {
    return translate('ui.57fce0c46d1f');
  },
  get APPROVED() {
    return translate('ui.4b3c9650f8e7');
  },
  get REJECTED() {
    return translate('ui.4c7c52c70655');
  },
  get TIMED_OUT() {
    return translate('ui.411ebfdad774');
  },
};
/** 仅 PENDING 可审批（APPROVED/REJECTED/TIMED_OUT 为终态，重复审批由 If-Match 兜底）。 */
export function isReviewable(status: OnboardingStatus): boolean {
  return status === 'PENDING';
}
