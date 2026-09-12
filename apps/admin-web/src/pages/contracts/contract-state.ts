import { translate } from '../../i18n/i18n.js';
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
import { hasPermission } from '@fdp/auth/browser';
import type { Role } from '@fdp/auth/browser';
import type { ContractStatus } from './types.js';
export const CONTRACT_STATUS_OPTIONS: readonly ContractStatus[] = [
  'DRAFT',
  'EFFECTIVE',
  'EXPIRING_SOON',
  'EXPIRED',
  'TERMINATED',
];
export const CONTRACT_STATUS_LABELS: Readonly<Record<ContractStatus, string>> = {
  get DRAFT() {
    return translate('ui.0f436818c0b4');
  },
  get EFFECTIVE() {
    return translate('ui.4de07ee06570');
  },
  get EXPIRING_SOON() {
    return translate('ui.810ab25a9cc8');
  },
  get EXPIRED() {
    return translate('ui.75e6c9fb6feb');
  },
  get TERMINATED() {
    return translate('ui.b084203e8f6f');
  },
};
export type ContractAction = 'edit' | 'activate' | 'renew' | 'terminate' | 'bind' | 'unbind';
export const CONTRACT_ACTION_LABELS: Readonly<Record<ContractAction, string>> = {
  get edit() {
    return translate('page.a7f814c0a40d');
  },
  get activate() {
    return translate('page.4c25820818d6');
  },
  get renew() {
    return translate('page.f7d3735c18eb');
  },
  get terminate() {
    return translate('page.2eee5759c39c');
  },
  get bind() {
    return translate('page.b113e4704c10');
  },
  get unbind() {
    return translate('ui.921226d71f62');
  },
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
    return (
      translate('page.62e951a692ff') +
      ' ' +
      CONTRACT_STATUS_LABELS[status] +
      (' ' + translate('page.41cd13289ce7')) +
      CONTRACT_ACTION_LABELS[action]
    );
  }
  if (!canWriteContracts(role)) return translate('page.bb48fc12271b');
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
  if (number.length === 0 || number.length > 100) errors['contractNumber'] = translate('ui.867431bded5c');
  const name = draft.name.trim();
  if (name.length === 0 || name.length > 200) errors['name'] = translate('ui.044052bf73b1');
  if (draft.customerId.trim() === '') errors['customerId'] = translate('ui.e10e42f6ba65');
  if (draft.contact.trim().length > 200) errors['contact'] = translate('ui.4edb15bc2697');
  const start = Date.parse(draft.startAt);
  const end = Date.parse(draft.endAt);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    errors['period'] = translate('ui.bdfc888c87f4');
  } else if (start >= end) {
    errors['period'] = translate('ui.baaf9dd038d2');
  }
  return Object.keys(errors).length === 0 ? null : errors;
}
/** 续约校验：newEndAt 必须晚于当前 endAt。 */
export function validateRenew(newEndAt: string, currentEndAt: string): string | null {
  const next = Date.parse(newEndAt);
  const current = Date.parse(currentEndAt);
  if (Number.isNaN(next)) return translate('ui.fb6ff1e4ae39');
  if (!Number.isNaN(current) && next <= current) return translate('ui.b8b4a49a4d64');
  return null;
}
/** 服务期限展示（UTC 日期段）。 */
export function formatServicePeriod(startAt: string, endAt: string): string {
  return `${startAt.slice(0, 10)} ~ ${endAt.slice(0, 10)}`;
}
export const ASSOCIATION_STATUS_LABELS: Readonly<Record<string, string>> = {
  get ACTIVE() {
    return translate('ui.239b3a4cb372');
  },
  get ENDED() {
    return translate('page.5a10408b3625');
  },
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
