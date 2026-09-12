import { translate } from '../../i18n/i18n.js';
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
  get ACTIVE() {
    return translate('page.f78d037abccd');
  },
  get DISABLED() {
    return translate('page.6c7dcbb73a59');
  },
};
export const DEVICE_USER_STATUS_OPTIONS: readonly DeviceUserStatus[] = ['ACTIVE', 'DISABLED'];
export const DEVICE_USER_ASSIGNMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  get ACTIVE() {
    return translate('ui.4de07ee06570');
  },
  get REVOKED() {
    return translate('ui.61063ba81b3c');
  },
};
/** 创建校验：username 1..64；password 必填（仅长度边界，复杂度策略由服务端裁决）。 */
export function validateDeviceUserCreate(input: { username: string; password: string }): string | null {
  const username = input.username.trim();
  if (username === '' || username.length > 64) return translate('ui.6f7182d04f9b');
  if (input.password === '') return translate('ui.6855a4805bfd');
  if (input.password.length > 1024) return translate('ui.8bf86f6122e1');
  return null;
}
/** 更新校验：reason 必填；displayName 与 password 至少一项。 */
export function validateDeviceUserUpdate(input: {
  displayName: string | null | undefined;
  password: string | undefined;
  reason: string;
}): string | null {
  if (input.displayName === undefined && (input.password === undefined || input.password === '')) {
    return translate('ui.7a27b87e353d');
  }
  if (input.reason.trim() === '') return translate('ui.934df23ecff5');
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
