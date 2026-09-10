/**
 * FE-04 Onboarding 审批数据类型：镜像 contracts/rest/admin-onboarding-api.json（BE-ONB-02）。
 * DTO 不含 tokenId/privateKey 等敏感字段（契约显式排除）。
 */

export type OnboardingStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'TIMED_OUT';

export interface OnboardingRequestView {
  readonly requestId: string;
  readonly serialNumber: string;
  readonly submittedBy: string;
  readonly model: string;
  readonly hardwareVersion: string;
  readonly manufacturer: string;
  readonly manufactureDate: string;
  readonly status: OnboardingStatus;
  readonly rejectReason: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  /** 乐观锁版本（approve/reject 经 If-Match 携带）。 */
  readonly version: number;
  readonly createdAt: string;
  readonly certificateProvisioningStatus:
    'NOT_STARTED' | 'QUEUED' | 'PROCESSING' | 'RETRY' | 'COMPLETED' | 'FAILED' | 'NOT_APPLICABLE';
}
