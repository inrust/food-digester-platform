/**
 * FE-08 License 纯逻辑：状态→合法动作矩阵、权限门、Entitlement/状态文案。
 *
 * 事实源：admin-license-api.json（BE-LIC-01）状态机——
 * create(Draft) → issue(Issued) → activate(Active，要求已到 validFrom)
 * Active→ExpiringSoon/Expired、ExpiringSoon→Expired、Renewed→Active 为 SYSTEM 时间派生
 * （evaluate 接口是 SYSTEM/测试通道，不在管理页面暴露）；续期 ExpiringSoon→Renewed；
 * 吊销 Active/Expired→Revoked（强制原因）。Revoked 为终态。
 * 权限：license:write = PlatformSuperAdmin/PlatformOperator（AUTH-01）。
 */
import { hasPermission } from '@fdp/auth';
import type { Role } from '@fdp/auth';
import { LICENSE_FILTER_LABELS } from '../devices/device-state.js';
import type { EntitlementCode, LicenseStatus } from './types.js';

export type LicenseAction = 'issue' | 'activate' | 'renew' | 'revoke';

/** 状态 → 契约允许的管理员动作（时间派生迁移非管理员动作，不在矩阵内）。 */
export const LICENSE_ACTION_MATRIX: Readonly<Record<LicenseStatus, readonly LicenseAction[]>> = {
  Draft: ['issue'],
  Issued: ['activate'],
  Active: ['revoke'],
  ExpiringSoon: ['renew'],
  Renewed: [],
  Expired: ['revoke'],
  Revoked: [],
};

/** 非终态：设备存在任一此类 License 时创建新 Draft 会被 409 拒绝（BE-LIC-01）。 */
export const NON_TERMINAL_LICENSE_STATUSES: readonly LicenseStatus[] = [
  'Draft',
  'Issued',
  'Active',
  'ExpiringSoon',
  'Renewed',
];

export function actionsOfStatus(status: LicenseStatus): readonly LicenseAction[] {
  return LICENSE_ACTION_MATRIX[status];
}

export interface LicenseActionGate {
  readonly enabled: boolean;
  readonly reason: string | null;
}

/** 动作可用性 = 状态矩阵 ∩ license:write（前端体验层门控；后端仍强制）。 */
export function gateLicenseAction(action: LicenseAction, status: LicenseStatus, role: Role): LicenseActionGate {
  if (!actionsOfStatus(status).includes(action)) {
    return { enabled: false, reason: '当前授权状态不允许该操作' };
  }
  if (!hasPermission(role, 'license:write')) {
    return { enabled: false, reason: '需要授权写权限（license:write）' };
  }
  return { enabled: true, reason: null };
}

/** 创建 Draft 的权限门（设备归属/退役/重复 License 由后端校验并返回可读错误）。 */
export function canCreateLicense(role: Role): boolean {
  return hasPermission(role, 'license:write');
}

// ---------- 展示文案 ----------

/** 状态显示名：与 FE-06 筛选枚举文案同源（LICENSE_FILTER_LABELS），防止漂移。 */
export function licenseStatusLabel(status: LicenseStatus): string {
  return LICENSE_FILTER_LABELS[status] ?? status;
}

export const ENTITLEMENT_CODES: readonly EntitlementCode[] = ['REMOTE_CONTROL', 'OTA', 'ESG_REPORTING'];

export const ENTITLEMENT_LABELS: Readonly<Record<EntitlementCode, string>> = {
  REMOTE_CONTROL: '远程控制',
  OTA: 'OTA 升级',
  ESG_REPORTING: 'ESG 报表',
};

// ---------- 表单校验（服务端仍最终校验） ----------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isLicenseDate(value: string): boolean {
  return DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** 创建 Draft 校验：日期格式 + validFrom ≤ validTo + 至少一个 Entitlement。 */
export function validateLicenseDraft(input: {
  validFrom: string;
  validTo: string;
  entitlements: readonly EntitlementCode[];
}): string | null {
  if (!isLicenseDate(input.validFrom) || !isLicenseDate(input.validTo)) return '有效期格式须为 YYYY-MM-DD';
  if (input.validFrom > input.validTo) return '生效日期须不晚于到期日期';
  if (input.entitlements.length === 0) return '至少勾选一个 Entitlement';
  return null;
}

/** 续期校验：newValidTo 必须晚于当前 validTo（契约约束）。 */
export function validateRenew(validTo: string, newValidTo: string): string | null {
  if (!isLicenseDate(newValidTo)) return '新到期日期格式须为 YYYY-MM-DD';
  if (newValidTo <= validTo) return '新到期日期必须晚于当前到期日期';
  return null;
}

// ---------- CT-06 锚点（contract-detail 页 FE-08 自有元素；页面本体属 FE-17） ----------

export const LICENSE_COVERAGE: Readonly<Record<string, string>> = {
  'contract-detail.field.licenseSummary': 'license-summary',
};
