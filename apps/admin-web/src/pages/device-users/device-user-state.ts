/**
 * FE-09 Device User 纯逻辑：状态文案、表单预校验（后端唯一可信）、CT-06 锚点。
 *
 * DEC-004/BE-DUSR-02：密码只进入一次受控提交，不回显、不持久化于前端状态之外；
 * 任何响应/DOM 不出现 passwordHash。
 */
import { hasPermission } from '@fdp/auth/browser';
import type { Role } from '@fdp/auth/browser';
import type { DeviceUserStatus } from './types.js';

export const DEVICE_USER_STATUS_LABELS: Readonly<Record<DeviceUserStatus, string>> = {
  ACTIVE: '正常',
  DISABLED: '已停用',
};

export const DEVICE_USER_STATUS_OPTIONS: readonly DeviceUserStatus[] = ['ACTIVE', 'DISABLED'];

export const DEVICE_USER_ASSIGNMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  ACTIVE: '生效中',
  REVOKED: '已撤销',
};

/** 创建校验：username 1..64；password 必填（仅长度边界，复杂度策略由服务端裁决）。 */
export function validateDeviceUserCreate(input: { username: string; password: string }): string | null {
  const username = input.username.trim();
  if (username === '' || username.length > 64) return '用户名必填且不超过 64 字符';
  if (input.password === '') return '设备本地密码必填';
  if (input.password.length > 1024) return '密码过长';
  return null;
}

/** 更新校验：reason 必填；displayName 与 password 至少一项。 */
export function validateDeviceUserUpdate(input: {
  displayName: string | null | undefined;
  password: string | undefined;
  reason: string;
}): string | null {
  if (input.displayName === undefined && (input.password === undefined || input.password === '')) {
    return '须至少修改一项（显示名或密码）';
  }
  if (input.reason.trim() === '') return '原因必填（写入审计）';
  return null;
}

/** 写操作（创建/资料/密码/停用）与分配/撤销统一由 device-user:write 门控（AUTH-01 无独立 assign 权限点）。 */
export function canWriteDeviceUser(role: Role): boolean {
  return hasPermission(role, 'device-user:write');
}

export function canAssignDeviceUser(role: Role): boolean {
  return hasPermission(role, 'device-user:write');
}

// ---------- CT-06 锚点（settings 页设备用户元素由本模块承载；平台用户元素属 FE-16） ----------

export const DEVICE_USER_COVERAGE: Readonly<Record<string, string>> = {
  'settings.button.addDeviceUser': 'device-user-create',
  'settings.button.deviceUserFilter': 'device-user-search',
  'settings.button.resetDeviceUserPassword': 'device-user-password-reset',
  'settings.button.deleteDeviceUser': 'device-user-disable',
};
