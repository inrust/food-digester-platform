export const ONBOARDING_TIMEOUT_POLICY = {
  policyVersion: '1.0.0',
  status: 'frozen',
  deadline: { startsAt: 'CERTIFICATE_PACKAGE_STORED', seconds: 86_400, boundary: 'INCLUSIVE' },
  timeoutDisposition: {
    internalRequestStatus: 'TIMED_OUT',
    externalStatus: 'REJECTED',
    externalReason: 'ONBOARDING_TIMEOUT',
    deviceLifecycle: 'PendingOnboarding',
    certificateStatus: 'REVOKED',
    destroyCertificatePackage: true,
    beforeDeadlinePackageExpiry: 'REVOKE_AND_RESIGN',
    afterDeadlineAutomaticResign: false,
  },
  lateHeartbeat: 'REJECT',
  retry: { requiresNewToken: true, requiresNewRequest: true },
  consumers: ['BE-ONB-03', 'BE-ONB-04', 'QA-02', 'QA-04'],
} as const;

export function onboardingDeadlineFrom(packageStoredAt: Date): Date {
  return new Date(packageStoredAt.getTime() + ONBOARDING_TIMEOUT_POLICY.deadline.seconds * 1000);
}

export function isOnboardingDeadlineReached(deadlineAt: Date, at: Date): boolean {
  return deadlineAt.getTime() <= at.getTime();
}
