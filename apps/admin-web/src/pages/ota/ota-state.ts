import { translate } from '../../i18n/i18n.js';
/**
 * FE-13 OTA 纯逻辑：状态机矩阵、门控、校验、文案与 CT-06 锚点。
 *
 * - Campaign 状态机（BE-OTA-02）：创建即 RUNNING；RUNNING⇄PAUSED；RUNNING/PAUSED→CANCELLED；
 *   最终全量审批存在且全部 target SUCCEEDED → COMPLETED；DRAFT 枚举存在但本 API 不产出；
 * - 灰度纪律：创建首批强制恰好 1 台；普通扩批最多 500 台；最终全量须 SuperAdmin 显式审批；
 * - 包纪律（BE-OTA-01）：可发布 = status VERIFIED；UPLOADED（未完成校验）不可建 Campaign；
 * - 写操作门控 ota:write（PlatformSuperAdmin/PlatformOperator），后端 403 兜底。
 */
import { hasPermission } from '@fdp/auth/browser';
import type { Role } from '@fdp/auth/browser';
import type { FirmwarePackageStatus, FirmwarePackageType, OtaCampaignStatus, OtaTargetStatus } from './types.js';
// ---------- 包（BE-OTA-01） ----------
export const PACKAGE_TYPE_OPTIONS: readonly FirmwarePackageType[] = ['APP', 'FIRMWARE'];
export const PACKAGE_TYPE_LABELS: Readonly<Record<FirmwarePackageType, string>> = {
  get APP() {
    return translate('ui.f5e80b137b70');
  },
  get FIRMWARE() {
    return translate('ui.1622f71ea73b');
  },
};
export const PACKAGE_STATUS_OPTIONS: readonly FirmwarePackageStatus[] = ['UPLOADED', 'VERIFIED', 'RETIRED'];
export const PACKAGE_STATUS_LABELS: Readonly<Record<FirmwarePackageStatus, string>> = {
  get UPLOADED() {
    return translate('ui.88a87f25cc56');
  },
  get VERIFIED() {
    return translate('ui.2c1137108fa3');
  },
  get RETIRED() {
    return translate('ui.0c9e069eb0b6');
  },
};
// ---------- 上传元数据校验（契约字段约束镜像） ----------
export const MODEL_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const SHA256_PATTERN = /^[0-9A-Fa-f]{64}$/;
/** 包大小上限 512MiB（暂定值，与契约 maximum 一致）。 */
export const MAX_PACKAGE_SIZE_BYTES = 536870912;
export const MAX_SIGNATURE_LENGTH = 4096;
export const MAX_CAMPAIGN_NAME_LENGTH = 128;
export const MAX_BATCH_SIZE = 500;
export interface UploadMetadataDraft {
  readonly model: string;
  readonly version: string;
  readonly sizeBytes: string;
  readonly sha256: string;
  readonly signature: string;
}
export type UploadFieldErrors = Partial<Record<keyof UploadMetadataDraft, string>>;
/** 上传会话元数据字段级校验（与契约 pattern/minimum/maximum 一致；服务端 VALIDATION_FAILED 兜底）。 */
export function validateUploadMetadata(draft: UploadMetadataDraft): UploadFieldErrors {
  const errors: UploadFieldErrors = {};
  if (!MODEL_VERSION_PATTERN.test(draft.model.trim())) {
    errors.model = translate('ui.0fef9686408c');
  }
  if (!MODEL_VERSION_PATTERN.test(draft.version.trim())) {
    errors.version = translate('ui.6c97fd19f059');
  }
  const size = Number(draft.sizeBytes);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PACKAGE_SIZE_BYTES) {
    errors.sizeBytes = translate('ui.47ca0c558fa5') + MAX_PACKAGE_SIZE_BYTES + (' ' + translate('ui.6e6541e21b8e'));
  }
  if (!SHA256_PATTERN.test(draft.sha256.trim())) {
    errors.sha256 = translate('ui.8969dae61522');
  }
  const signature = draft.signature.trim();
  if (signature.length === 0 || signature.length > MAX_SIGNATURE_LENGTH) {
    errors.signature = translate('ui.47049bc2a705');
  }
  return errors;
}
export function hasUploadErrors(errors: UploadFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}
// ---------- Campaign 状态机与门控（BE-OTA-02） ----------
export const CAMPAIGN_STATUS_OPTIONS: readonly OtaCampaignStatus[] = [
  'DRAFT',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
];
export const CAMPAIGN_STATUS_LABELS: Readonly<Record<OtaCampaignStatus, string>> = {
  get DRAFT() {
    return translate('ui.0f436818c0b4');
  },
  get RUNNING() {
    return translate('ui.6f1972e48ec8');
  },
  get PAUSED() {
    return translate('ui.fcbae46bf890');
  },
  get COMPLETED() {
    return translate('page.e99b48a29bdf');
  },
  get CANCELLED() {
    return translate('page.a5ffdc95eeb0');
  },
};
export const TARGET_STATUS_OPTIONS: readonly OtaTargetStatus[] = [
  'PENDING',
  'NOTIFIED',
  'DOWNLOADING',
  'INSTALLING',
  'SUCCEEDED',
  'FAILED',
  'ROLLED_BACK',
  'CANCELLED',
];
export const TARGET_STATUS_LABELS: Readonly<Record<OtaTargetStatus, string>> = {
  get PENDING() {
    return translate('ui.b3708513d025');
  },
  get NOTIFIED() {
    return translate('ui.bf6f1f7ed2f5');
  },
  get DOWNLOADING() {
    return translate('ui.327d59b5bd11');
  },
  get INSTALLING() {
    return translate('ui.411642f1d064');
  },
  get SUCCEEDED() {
    return translate('page.51991a5d111a');
  },
  get FAILED() {
    return translate('ui.3e3c8068bb0e');
  },
  get ROLLED_BACK() {
    return translate('ui.c4ab8c16f827');
  },
  get CANCELLED() {
    return translate('page.a5ffdc95eeb0');
  },
};
export type CampaignAction = 'pause' | 'resume' | 'cancel' | 'expand' | 'retry';
export const CAMPAIGN_ACTION_LABELS: Readonly<Record<CampaignAction, string>> = {
  get pause() {
    return translate('ui.130448bce675');
  },
  get resume() {
    return translate('page.79748ca1c6e5');
  },
  get cancel() {
    return translate('page.4d0b4688c787');
  },
  get expand() {
    return translate('page.0d6084de32a0');
  },
  get retry() {
    return translate('page.794ff5f0462b');
  },
};
/**
 * Campaign 动作矩阵（与契约状态机一致）：
 * - RUNNING：暂停/扩大批次/失败重试/取消；PAUSED：恢复/取消；
 * - 终态（COMPLETED/CANCELLED）与 DRAFT（本 API 不产出）无动作。
 */
export const CAMPAIGN_ACTION_MATRIX: Readonly<Record<OtaCampaignStatus, readonly CampaignAction[]>> = {
  DRAFT: [],
  RUNNING: ['pause', 'expand', 'retry', 'cancel'],
  PAUSED: ['resume', 'cancel'],
  COMPLETED: [],
  CANCELLED: [],
};
export interface CampaignActionGate {
  readonly allowed: boolean;
  readonly reason: string | null;
}
/** 动作可用性 = ota:write ∩ 状态机矩阵（后端 CONFLICT 兜底；pause/resume/cancel 幂等回放）。 */
export function gateCampaignAction(action: CampaignAction, status: OtaCampaignStatus, role: Role): CampaignActionGate {
  if (!hasPermission(role, 'ota:write')) {
    return { allowed: false, reason: translate('page.89dc6cfd462e') };
  }
  if (!CAMPAIGN_ACTION_MATRIX[status].includes(action)) {
    return {
      allowed: false,
      reason: translate('ui.1f88feb4504d') + CAMPAIGN_STATUS_LABELS[status] + translate('ui.932489b26741'),
    };
  }
  return { allowed: true, reason: null };
}
// ---------- 创建 / 扩大批次校验 ----------
export interface CampaignCreateDraft {
  readonly name: string;
  readonly packageId: string;
  readonly deviceIds: readonly string[];
}
/**
 * 创建校验：name 1~128；packageId 必须在 VERIFIED 可发布集合内（坏包/未校验包不可建 Campaign）；
 * 首批强制恰好 1 台（灰度）。
 */
export function validateCampaignCreate(
  draft: CampaignCreateDraft,
  verifiedPackageIds: readonly string[],
): string | null {
  const name = draft.name.trim();
  if (name.length === 0 || name.length > MAX_CAMPAIGN_NAME_LENGTH) {
    return translate('ui.7fe1dcdca8fd');
  }
  if (draft.packageId === '') {
    return translate('ui.4cb9407eab6e');
  }
  if (!verifiedPackageIds.includes(draft.packageId)) {
    return translate('ui.985e67a2d4dc');
  }
  if (draft.deviceIds.length !== 1) {
    return translate('ui.c61000f95a51');
  }
  return null;
}
/**
 * 扩大批次通用校验：1~500 台。最终全量所需的角色、既有 target 成功状态与确认文本由页面和服务端另行校验。
 */
export function validateBatchExpand(deviceIds: readonly string[]): string | null {
  if (deviceIds.length < 1 || deviceIds.length > MAX_BATCH_SIZE) {
    return translate('ui.9528087d5380') + MAX_BATCH_SIZE + (' ' + translate('page.dda4f85fa0dc'));
  }
  return null;
}
// ---------- CT-06 锚点（OTA 相关元素；双向锁定见 contract-parity.test.ts） ----------
export const OTA_COVERAGE: Readonly<Record<string, string>> = {
  // dashboard 设备卡片“升级”：跳转 /ota/campaigns（FE-03 预埋入口，testid 动态含 deviceId）
  'dashboard.button.upgrade': 'action-upgrade-<deviceId>',
  // 设备管理“选择固件文件”：跳转固件包页上传（预签名 URL + Hash/签名校验）
  'device-manage.button.selectFirmware': 'goto-ota-packages',
  // 设备管理“同步更新”：跳转创建受控 Campaign（禁止直接推送单设备）
  'device-manage.button.syncUpdate': 'goto-ota-campaigns',
};
