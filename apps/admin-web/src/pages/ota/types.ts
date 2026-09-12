/**
 * FE-13 OTA 数据类型：镜像 admin-ota-package-api.json（BE-OTA-01）与
 * admin-ota-campaign-api.json（BE-OTA-02）。
 */

// ---------- Firmware Package（BE-OTA-01） ----------

export type FirmwarePackageType = 'APP' | 'FIRMWARE';

/** 包状态机：UPLOADED（会话已建，未完成校验）→ VERIFIED（可发布，不可变）；RETIRED 由 BE-OTA-02 管理。 */
export type FirmwarePackageStatus = 'UPLOADED' | 'VERIFIED' | 'RETIRED';

/** 创建上传会话请求（声明元数据 + 签名；同型号+版本+packageType 唯一，重复 409）。 */
export interface FirmwareUploadSessionCreate {
  readonly model: string;
  readonly version: string;
  readonly packageType: FirmwarePackageType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly signature: string;
}

/** 上传会话响应（含短期预签名上传 URL，900s 暂定；objectKey 服务端生成）。 */
export interface FirmwareUploadSessionView {
  readonly packageId: string;
  readonly status: 'UPLOADED';
  readonly model: string;
  readonly version: string;
  readonly packageType: FirmwarePackageType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly objectKey: string;
  readonly uploadUrl: string;
  readonly uploadUrlExpiresAt: string;
  readonly createdAt: string;
}

export interface FirmwarePackageView {
  readonly packageId: string;
  readonly model: string;
  readonly version: string;
  readonly packageType: FirmwarePackageType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly status: FirmwarePackageStatus;
  readonly objectKey: string;
  /** 身份上下文取得（不信任客户端声明）。 */
  readonly uploadedBy: string;
  readonly createdAt: string;
}

// ---------- OTA Campaign（BE-OTA-02） ----------

/** Campaign 状态机：创建即 RUNNING；最终全量已审批且全部 target SUCCEEDED 后才 COMPLETED。 */
export type OtaCampaignStatus = 'DRAFT' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

/** Target 状态机（DB-01 封闭集合）。 */
export type OtaTargetStatus =
  'PENDING' | 'NOTIFIED' | 'DOWNLOADING' | 'INSTALLING' | 'SUCCEEDED' | 'FAILED' | 'ROLLED_BACK' | 'CANCELLED';

export interface OtaCampaignView {
  readonly campaignId: string;
  readonly name: string;
  readonly packageId: string;
  readonly targetModel: string;
  /** 创建为 CANARY；通过最终全量审批后切换为 BATCH。 */
  readonly strategy: 'CANARY' | 'BATCH';
  readonly status: OtaCampaignStatus;
  readonly createdBy: string;
  readonly finalRolloutApprovedAt: string | null;
  readonly finalRolloutApprovedBy: string | null;
  readonly finalRolloutEligibleCount: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OtaTargetCounts {
  readonly total: number;
  readonly PENDING: number;
  readonly NOTIFIED: number;
  readonly DOWNLOADING: number;
  readonly INSTALLING: number;
  readonly SUCCEEDED: number;
  readonly FAILED: number;
  readonly ROLLED_BACK: number;
  readonly CANCELLED: number;
}

export interface OtaCampaignDetailView extends OtaCampaignView {
  readonly targetCounts: OtaTargetCounts;
}

export interface OtaTargetView {
  readonly targetId: string;
  readonly campaignId: string;
  readonly deviceId: string;
  /** 1 = 灰度批次。 */
  readonly batchNo: number;
  readonly status: OtaTargetStatus;
  /** 设备回报的结构化失败码；仅 FAILED 非空。 */
  readonly failureCode: string | null;
  /** 经服务端脱敏、最长 500 字符的失败原因；仅 FAILED 可能非空。 */
  readonly failureReason: string | null;
  readonly scheduledTime: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OtaBatchExpandResult {
  readonly campaignId: string;
  readonly batchNo: number;
  readonly addedCount: number;
  /** 已在 Campaign 中幂等跳过的设备数。 */
  readonly skippedExistingCount: number;
  readonly addedTargets: readonly OtaTargetView[];
  readonly finalRolloutApproved: boolean;
  readonly approvedBy: string | null;
}

export interface OtaRetryResult {
  readonly campaignId: string;
  readonly retriedCount: number;
  readonly retriedTargetIds: readonly string[];
}

// ---------- 页面通用 ----------

export interface OtaListState<T> {
  readonly rows: readonly T[] | null;
  readonly loading?: boolean;
  readonly error?: unknown;
  readonly nextCursor?: string | null;
}
