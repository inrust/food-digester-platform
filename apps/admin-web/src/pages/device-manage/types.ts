/**
 * FE-07 设备生命周期操作数据类型：镜像 admin-device-assignment-api.json（BE-DEV-02）、
 * admin-device-status-api.json（BE-DEV-03）、admin-device-retirement-api.json（BE-DEV-04）、
 * admin-device-api.json DeviceMetadataView（BE-DEV-06）与
 * admin-certificate-rotation-api.json（BE-CERT-03）。
 */

// ---------- Assignment（BE-DEV-02） ----------

export interface DeviceAssignmentView {
  readonly assignmentId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly siteId: string;
  readonly status: 'ACTIVE' | 'ENDED';
  readonly assignedBy: string;
  readonly reason: string | null;
  /** 授权窗口起点。 */
  readonly assignedAt: string;
  /** 授权窗口终点（ACTIVE 为 null）。 */
  readonly endedAt: string | null;
  readonly lifecycleStatus: 'Onboarded' | 'Assigned';
  readonly notification: 'ASSIGNMENT_CHANGED' | null;
  readonly replayed: boolean;
}

// ---------- Suspend/Reactivate（BE-DEV-03） ----------

export interface DeviceStatusResultView {
  readonly deviceId: string;
  readonly lifecycleStatus: 'Active' | 'Suspended';
  readonly operationalStatus: 'Active' | 'Maintenance' | 'Suspended' | 'Retired' | null;
  readonly notification: 'DEVICE_SUSPENDED' | 'STATUS_CHANGED' | null;
  readonly replayed: boolean;
}

// ---------- Retirement（BE-DEV-04，DEC-014 72 小时确认窗口） ----------

export type RetirementStatus = 'PENDING_CONFIRMATION' | 'CONFIRMED';

export type RetirementCompletionMethod = 'DEVICE_CONFIRM' | 'FORCE_COMPLETE' | 'UNCONFIRMED_TIMEOUT';

export interface RetirementRecordView {
  readonly retirementId: string;
  readonly status: RetirementStatus;
  readonly reason: string;
  readonly initiatedBy: string;
  readonly initiatedAt: string;
  readonly confirmedAt: string | null;
  readonly completionMethod: RetirementCompletionMethod | null;
  readonly certificateRevokedAt: string | null;
}

export interface RetirementResultView {
  readonly deviceId: string;
  readonly lifecycleStatus: 'Retired';
  readonly retirement: RetirementRecordView;
  readonly notification: 'DEVICE_RETIRED' | null;
  readonly replayed: boolean;
}

// ---------- 元数据（BE-DEV-06：V1 白名单仅 alias） ----------

export interface DeviceMetadataView {
  readonly deviceId: string;
  readonly alias: string | null;
  /** 更新后的台账时点（下次 If-Match 基准）。 */
  readonly updatedAt: string;
}

// ---------- 证书轮换（BE-CERT-03：响应绝不含 PEM/私钥） ----------

export interface RotationRequestView {
  readonly requestId: string;
  readonly deviceId: string;
  readonly certificateId: string;
  readonly certificateStatus: 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'REVOKED' | 'PENDING_CLAIM';
  /** 当前证书 UTC 到期日（YYYY-MM-DD）。 */
  readonly expiryDate: string;
  readonly requestStatus: 'PENDING' | 'COMPLETED' | 'SUPERSEDED';
  readonly requestedAt: string;
}
