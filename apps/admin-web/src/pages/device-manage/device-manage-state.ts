/**
 * FE-07 设备生命周期操作纯逻辑：状态→合法动作矩阵、角色权限门、展示文案、CT-06 锚点。
 *
 * 事实源：
 * - 转换条件：admin-device-assignment-api.json（仅 Onboarded/Assigned 可分配）、
 *   admin-device-status-api.json（Active→Suspended→Active）、
 *   admin-device-retirement-api.json（Active/Suspended→Retired；force-complete 仅 Retired+PENDING_CONFIRMATION）、
 *   admin-certificate-rotation-api.json（Retired/Onboarding 中拒绝，需 ACTIVE 证书）；
 * - 权限：AUTH-01 权限矩阵 + DOM-01（退役与首次分配仅 PlatformSuperAdmin）；
 * - 前端矩阵只决定按钮可用性，授权唯一可信来源是后端（AUTH-01）。
 */
import { hasPermission } from '@fdp/auth';
import type { Role } from '@fdp/auth';
import type { LIFECYCLE_FILTER_OPTIONS } from '../devices/device-state.js';
import type { DeviceView } from '../devices/types.js';
import type { RetirementRecordView } from './types.js';

export type LifecycleStatus = (typeof LIFECYCLE_FILTER_OPTIONS)[number];

/** 页面动作键（不含 forceCompleteRetire——它依赖退役记录状态，见 canForceComplete）。 */
export type DeviceAction = 'assign' | 'suspend' | 'reactivate' | 'retire' | 'editAlias' | 'requestRotation';

/**
 * 生命周期状态 → 契约允许的转换动作矩阵。
 * editAlias（BE-DEV-06）无生命周期限制；assign 仅 Onboarded/Assigned；
 * suspend 仅 Active；reactivate 仅 Suspended；retire 仅 Active/Suspended；
 * requestRotation 拒绝 Retired 与 Onboarding 中（PendingOnboarding/OnboardingApproved/Rejected）。
 */
export const LIFECYCLE_ACTION_MATRIX: Readonly<Record<LifecycleStatus, readonly DeviceAction[]>> = {
  PendingOnboarding: ['editAlias'],
  Rejected: ['editAlias'],
  OnboardingApproved: ['editAlias'],
  Onboarded: ['assign', 'editAlias', 'requestRotation'],
  Assigned: ['assign', 'editAlias', 'requestRotation'],
  Licensed: ['editAlias', 'requestRotation'],
  Active: ['suspend', 'retire', 'editAlias', 'requestRotation'],
  Suspended: ['reactivate', 'retire', 'editAlias', 'requestRotation'],
  Retired: ['editAlias'],
};

/** 生命周期状态是否在矩阵内（防御未知值，后端新增状态时一律不允许操作）。 */
export function isKnownLifecycle(status: string): status is LifecycleStatus {
  return status in LIFECYCLE_ACTION_MATRIX;
}

/** 状态允许的转换动作；未知状态返回空集。 */
export function actionsOfLifecycle(status: string): readonly DeviceAction[] {
  return isKnownLifecycle(status) ? LIFECYCLE_ACTION_MATRIX[status] : [];
}

/**
 * 角色是否可执行动作（体验层门控；后端仍强制）。
 * - retire：DOM-01 生命周期退役迁移仅 PlatformSuperAdmin（device:write 不足以退役）；
 * - assign 首次分配（Onboarded→Assigned）同样仅 PlatformSuperAdmin（见 assignEnabledReason）；
 * - requestRotation：certificate:rotate（矩阵唯一持有者 PlatformSuperAdmin，BE-CERT-03）。
 */
export function actionAllowedByRole(action: DeviceAction, role: Role): boolean {
  switch (action) {
    case 'assign':
      return hasPermission(role, 'device:assign');
    case 'suspend':
    case 'reactivate':
    case 'editAlias':
      return hasPermission(role, 'device:write');
    case 'retire':
      return role === 'PlatformSuperAdmin';
    case 'requestRotation':
      return hasPermission(role, 'certificate:rotate');
  }
}

export interface ActionGate {
  readonly enabled: boolean;
  /** 禁用原因（按钮 title/辅助说明）；启用时为 null。 */
  readonly reason: string | null;
}

const ROLE_REASONS: Readonly<Record<DeviceAction, string>> = {
  assign: '需要设备分配权限（device:assign）',
  suspend: '需要设备写权限（device:write）',
  reactivate: '需要设备写权限（device:write）',
  retire: '退役为不可恢复操作，仅平台超级管理员可执行',
  editAlias: '需要设备写权限（device:write）',
  requestRotation: '证书轮换仅平台超级管理员可发起（certificate:rotate）',
};

/**
 * 动作可用性 = 生命周期矩阵 ∩ 角色权限。
 * 特例：Onboarded 首次分配仅 PlatformSuperAdmin（DOM-01）；Assigned 再分配允许 device:assign。
 */
export function gateAction(action: DeviceAction, device: DeviceView, role: Role): ActionGate {
  if (!actionsOfLifecycle(device.lifecycleStatus).includes(action)) {
    return { enabled: false, reason: '当前生命周期状态不允许该操作' };
  }
  if (!actionAllowedByRole(action, role)) {
    return { enabled: false, reason: ROLE_REASONS[action] };
  }
  if (action === 'assign' && device.lifecycleStatus === 'Onboarded' && role !== 'PlatformSuperAdmin') {
    return { enabled: false, reason: '首次分配（Onboarded→Assigned）仅平台超级管理员可执行' };
  }
  if (action === 'requestRotation' && device.certificate?.status !== 'ACTIVE') {
    return { enabled: false, reason: '当前无有效（ACTIVE）证书，无法发起轮换' };
  }
  return { enabled: true, reason: null };
}

/** 强制完成退役：仅 Retired 且退役记录 PENDING_CONFIRMATION，且仅 PlatformSuperAdmin。 */
export function canForceComplete(device: DeviceView, retirement: RetirementRecordView | null, role: Role): ActionGate {
  if (device.lifecycleStatus !== 'Retired' || retirement === null || retirement.status !== 'PENDING_CONFIRMATION') {
    return { enabled: false, reason: '仅退役且等待设备确认时可强制完成' };
  }
  if (role !== 'PlatformSuperAdmin') {
    return { enabled: false, reason: '仅平台超级管理员可强制完成退役' };
  }
  return { enabled: true, reason: null };
}

// ---------- 展示文案 ----------

export const CERTIFICATE_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING_CLAIM: '待领取',
  ACTIVE: '有效',
  REVOKED: '已吊销',
  EXPIRED: '已过期',
};

export const ASSIGNMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  ACTIVE: '生效中',
  ENDED: '已结束',
};

export const RETIREMENT_STATUS_LABELS: Readonly<Record<RetirementRecordView['status'], string>> = {
  PENDING_CONFIRMATION: '等待设备确认',
  CONFIRMED: '已确认',
};

export const COMPLETION_METHOD_LABELS: Readonly<Record<string, string>> = {
  DEVICE_CONFIRM: '设备确认',
  FORCE_COMPLETE: '管理员强制完成',
  UNCONFIRMED_TIMEOUT: '超时未确认',
};

export const ROTATION_REQUEST_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: '等待设备领取',
  COMPLETED: '已完成',
  SUPERSEDED: '已被取代',
};

// ---------- CT-06 锚点（device-manage 页 FE-07 自有元素；其余元素属 FE-08/09/13） ----------

export const DEVICE_MANAGE_COVERAGE: Readonly<Record<string, string>> = {
  'device-manage.button.back': 'manage-back',
};
