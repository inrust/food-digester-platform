/**
 * FE-17 Contract 纯逻辑：状态机矩阵、表单校验、服务期格式化与 CT-06 锚点。
 *
 * - 状态机：DRAFT →activate→ EFFECTIVE →时间派生→ EXPIRING_SOON（DEC-021 30 天窗口）→ EXPIRED；
 *   任意非终态 →terminate（强制原因）→ TERMINATED；续约仅 EFFECTIVE/EXPIRING_SOON/EXPIRED；
 * - DEC-007：Contract 状态与 License 状态并列展示且标签不同；创建不自动激活 License；
 *   解绑不撤销 License（前端不得擅自变更 License 状态展示）；
 * - 写操作全部 If-Match（version）+ 强制原因；contract:write 仅 PlatformSuperAdmin；
 * - 校验前置：contractNumber 1~100、name 1~200、startAt<endAt、renew newEndAt>当前 endAt、
 *   绑定至少 1 台设备（重叠租期/跨 Customer/重复编号 → 服务端 409 字段级呈现）。
 */
import { hasPermission } from '@fdp/auth';
import type { Role } from '@fdp/auth';
import type { ContractStatus } from './types.js';

export const CONTRACT_STATUS_OPTIONS: readonly ContractStatus[] = [
  'DRAFT',
  'EFFECTIVE',
  'EXPIRING_SOON',
  'EXPIRED',
  'TERMINATED',
];

export const CONTRACT_STATUS_LABELS: Readonly<Record<ContractStatus, string>> = {
  DRAFT: '草稿',
  EFFECTIVE: '生效中',
  EXPIRING_SOON: '即将到期',
  EXPIRED: '已到期',
  TERMINATED: '已终止',
};

export type ContractAction = 'edit' | 'activate' | 'renew' | 'terminate' | 'bind' | 'unbind';

export const CONTRACT_ACTION_LABELS: Readonly<Record<ContractAction, string>> = {
  edit: '编辑',
  activate: '激活',
  renew: '续约',
  terminate: '终止',
  bind: '关联设备',
  unbind: '解绑设备',
};

/**
 * 状态机矩阵（派生状态为准；列表筛选与展示均用 derivedStatus）：
 * - DRAFT：编辑/激活/终止（startAt/endAt 仅 DRAFT 可改）；
 * - EFFECTIVE/EXPIRING_SOON：编辑（名称/联系方式）/续约/终止/关联/解绑；
 * - EXPIRED：编辑（名称/联系方式）/续约/终止（绑定 → 服务端 409）；
 * - TERMINATED：终态，无动作。
 */
export const CONTRACT_ACTION_MATRIX: Readonly<Record<ContractStatus, readonly ContractAction[]>> = {
  DRAFT: ['edit', 'activate', 'terminate'],
  EFFECTIVE: ['edit', 'renew', 'terminate', 'bind', 'unbind'],
  EXPIRING_SOON: ['edit', 'renew', 'terminate', 'bind', 'unbind'],
  EXPIRED: ['edit', 'renew', 'terminate'],
  TERMINATED: [],
};

export function canWriteContracts(role: Role): boolean {
  return hasPermission(role, 'contract:write');
}

/** 动作门控：状态机矩阵 ∩ contract:write（仅 PlatformSuperAdmin）。 */
export function gateContractAction(action: ContractAction, status: ContractStatus, role: Role): string | null {
  if (!CONTRACT_ACTION_MATRIX[status].includes(action)) {
    return `状态 ${CONTRACT_STATUS_LABELS[status]} 不允许${CONTRACT_ACTION_LABELS[action]}`;
  }
  if (!canWriteContracts(role)) return '需要合约写权限（contract:write：仅平台管理员）';
  return null;
}

// ---------- 表单校验 ----------

export interface ContractFormDraft {
  readonly contractNumber: string;
  readonly name: string;
  readonly customerId: string;
  readonly contact: string;
  readonly startAt: string;
  readonly endAt: string;
}

/** 创建/编辑校验：返回字段级错误（全部通过 → null）。 */
export function validateContractForm(draft: ContractFormDraft): Record<string, string> | null {
  const errors: Record<string, string> = {};
  const number = draft.contractNumber.trim();
  if (number.length === 0 || number.length > 100) errors['contractNumber'] = '合约编号必填且不超过 100 字符';
  const name = draft.name.trim();
  if (name.length === 0 || name.length > 200) errors['name'] = '合约名称必填且不超过 200 字符';
  if (draft.customerId.trim() === '') errors['customerId'] = '必须从客户目录选择 Customer';
  if (draft.contact.trim().length > 200) errors['contact'] = '联系方式不超过 200 字符';
  const start = Date.parse(draft.startAt);
  const end = Date.parse(draft.endAt);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    errors['period'] = '有效期必填（UTC）';
  } else if (start >= end) {
    errors['period'] = '结束时间必须晚于开始时间';
  }
  return Object.keys(errors).length === 0 ? null : errors;
}

/** 续约校验：newEndAt 必须晚于当前 endAt。 */
export function validateRenew(newEndAt: string, currentEndAt: string): string | null {
  const next = Date.parse(newEndAt);
  const current = Date.parse(currentEndAt);
  if (Number.isNaN(next)) return '新到期时间必填（UTC）';
  if (!Number.isNaN(current) && next <= current) return '新到期时间必须晚于当前到期时间';
  return null;
}

/** 服务期限展示（UTC 日期段）。 */
export function formatServicePeriod(startAt: string, endAt: string): string {
  return `${startAt.slice(0, 10)} ~ ${endAt.slice(0, 10)}`;
}

export const ASSOCIATION_STATUS_LABELS: Readonly<Record<string, string>> = {
  ACTIVE: '关联中',
  ENDED: '已解绑',
};

// ---------- CT-06 锚点（contract-modify/contract-new/contract-detail 全部 Adopt/Adapt 元素；Reject 不入表） ----------

export const CONTRACT_COVERAGE: Readonly<Record<string, string>> = {
  'contract-modify.button.new': 'contract-new-open',
  'contract-modify.column.contractNumber': 'contract-list',
  'contract-modify.column.customer': 'contract-list',
  'contract-modify.column.deviceCount': 'contract-device-count-<contractId>',
  'contract-modify.column.servicePeriod': 'contract-list',
  'contract-modify.column.status': 'contract-list',
  'contract-modify.button.edit': 'contract-edit-open',
  'contract-modify.button.renewOrUnbind': 'contract-renew-open',
  'contract-modify.button.queryDevices': 'contract-open-<contractId>',
  'contract-new.field.number': 'contract-number-input',
  'contract-new.field.name': 'contract-name-input',
  'contract-new.field.customer': 'contract-customer-select',
  'contract-new.field.period': 'contract-start-input',
  'contract-new.field.devices': 'contract-new-devices',
  'contract-new.button.submit': 'contract-create-submit',
  'contract-new.button.cancel': 'contract-create-cancel',
  'contract-detail.button.back': 'contract-detail-back',
  'contract-detail.column.region': 'contract-devices-table',
  'contract-detail.column.subregion': 'contract-devices-table',
  'contract-detail.column.deviceId': 'contract-devices-table',
  'contract-detail.column.alias': 'contract-devices-table',
  'contract-detail.field.fourAxisStatus': 'contract-device-axes-<deviceId>',
  'contract-detail.column.firmware': 'contract-devices-table',
  'contract-detail.field.licenseSummary': 'license-summary',
};
