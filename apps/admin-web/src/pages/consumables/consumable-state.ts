/**
 * FE-18 耗材纯逻辑：封闭类型集、申请状态机矩阵、阈值分级与 CT-06 锚点。
 *
 * - DEC-008：耗材类型封闭集合（CARBON_FILTER/BIO_ADDITIVE），标准名称冻结；
 *   unknown 不得画成正常进度条（remainingPercent=null/remainingDisplay='unknown' → 仅文本）；
 * - 展示阈值（<10% / 10~30% / >30%）为暂定值，由字典/配置驱动（页面 prop 注入）；
 * - 申请状态机：PENDING→PROCESSING→COMPLETED/CANCELLED（跳级/重复处理/终态迁移 → 服务端 409）；
 *   状态迁移携带 version（If-Match）+ 处理备注（complete/cancel 强制）；
 * - 写操作 device:write（SuperAdmin/Operator）；协议未定义设备申请前不显示“来自设备”入口
 *   （source 恒为 ADMIN）。
 */
import { hasPermission } from '@fdp/auth';
import type { Role } from '@fdp/auth';
import type { ConsumableRequestStatus, ConsumableType } from './types.js';

export const CONSUMABLE_TYPES: readonly ConsumableType[] = ['CARBON_FILTER', 'BIO_ADDITIVE'];

/** DEC-008 标准耗材名称（冻结）。 */
export const CONSUMABLE_TYPE_LABELS: Readonly<Record<ConsumableType, string>> = {
  CARBON_FILTER: '碳包',
  BIO_ADDITIVE: '活性菌',
};

export const REQUEST_STATUS_OPTIONS: readonly ConsumableRequestStatus[] = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'CANCELLED',
];

export const REQUEST_STATUS_LABELS: Readonly<Record<ConsumableRequestStatus, string>> = {
  PENDING: '待处理',
  PROCESSING: '处理中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

export type RequestAction = 'process' | 'complete' | 'cancel';

export const REQUEST_ACTION_LABELS: Readonly<Record<RequestAction, string>> = {
  process: '处理',
  complete: '完成',
  cancel: '取消',
};

/** 申请状态机矩阵（PENDING→PROCESSING→COMPLETED/CANCELLED；终态无动作）。 */
export const REQUEST_ACTION_MATRIX: Readonly<Record<ConsumableRequestStatus, readonly RequestAction[]>> = {
  PENDING: ['process', 'cancel'],
  PROCESSING: ['complete', 'cancel'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canWriteDevices(role: Role): boolean {
  return hasPermission(role, 'device:write');
}

/** 动作门控：状态机矩阵 ∩ device:write（SuperAdmin/Operator）。 */
export function gateRequestAction(
  action: RequestAction,
  status: ConsumableRequestStatus,
  role: Role,
): string | null {
  if (!REQUEST_ACTION_MATRIX[status].includes(action)) {
    return `状态 ${REQUEST_STATUS_LABELS[status]} 不允许${REQUEST_ACTION_LABELS[action]}（跳级/重复处理被拒绝）`;
  }
  if (!canWriteDevices(role)) return '需要设备写权限（device:write）';
  return null;
}

// ---------- 展示阈值（暂定，字典/配置驱动） ----------

export interface ConsumableThresholds {
  /** 低于该值为低量（暂定 10%）。 */
  readonly low: number;
  /** 低于该值为中量（暂定 30%）。 */
  readonly mid: number;
}

/** 暂定展示阈值（DEC-008/配置驱动前的缺省；由页面 prop 可覆盖）。 */
export const DEFAULT_THRESHOLDS: ConsumableThresholds = { low: 10, mid: 30 };

/** 阈值分级：unknown/null → null（不渲染进度条）。 */
export function thresholdLevel(
  remainingPercent: number | null,
  thresholds: ConsumableThresholds = DEFAULT_THRESHOLDS,
): 'low' | 'mid' | 'ok' | null {
  if (remainingPercent === null) return null;
  if (remainingPercent < thresholds.low) return 'low';
  if (remainingPercent <= thresholds.mid) return 'mid';
  return 'ok';
}

/** 处理备注校验：complete/cancel 强制（1~500）；process 可选（≤500）。 */
export function validateRequestNote(note: string, required: boolean): string | null {
  const trimmed = note.trim();
  if (required && trimmed.length === 0) return '处理备注/原因必填';
  if (trimmed.length > 500) return '处理备注不超过 500 字符';
  return null;
}

// ---------- CT-06 锚点（device-consumable 页全部 Adopt/Adapt 元素） ----------

export const CONSUMABLE_COVERAGE: Readonly<Record<string, string>> = {
  'device-consumable.button.search': 'consumable-search',
  'device-consumable.button.reset': 'consumable-reset',
  'device-consumable.column.region': 'consumable-table',
  'device-consumable.column.subregion': 'consumable-table',
  'device-consumable.column.deviceId': 'consumable-table',
  'device-consumable.column.alias': 'consumable-table',
  'device-consumable.column.carbonFilterPct': 'consumable-carbon-<deviceId>',
  'device-consumable.column.bioAdditivePct': 'consumable-bio-<deviceId>',
  'device-consumable.button.contact': 'consumable-contact-<deviceId>',
  'device-consumable.req.column.requestTime': 'consumable-requests-table',
  'device-consumable.req.column.status': 'consumable-requests-table',
  'device-consumable.req.button.process': 'consumable-process-<requestId>',
  'device-consumable.req.button.complete': 'consumable-complete-<requestId>',
};
