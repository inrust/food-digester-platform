/**
 * FE-04 Onboarding 审批纯逻辑：状态文案与审批门控。
 * 事实源：admin-onboarding-api.json（status 枚举）+ BE-ONB-02（仅 PlatformSuperAdmin 审批）。
 */

export const ONBOARDING_STATUS_LABELS: Readonly<Record<'PENDING' | 'APPROVED' | 'REJECTED', string>> = {
  PENDING: '待审批',
  APPROVED: '已通过',
  REJECTED: '已拒绝',
};

/** 仅 PENDING 可审批（APPROVED/REJECTED 为终态，重复审批由 If-Match 兜底）。 */
export function isReviewable(status: 'PENDING' | 'APPROVED' | 'REJECTED'): boolean {
  return status === 'PENDING';
}
