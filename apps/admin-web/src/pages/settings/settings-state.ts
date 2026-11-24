import { translate } from '../../i18n/i18n.js';
/**
 * FE-16 用户/角色与业务设置纯逻辑：封闭角色集、邀请校验、设置 key 目录、CT-06 锚点。
 *
 * - 平台用户管理按 R18 展示双角色候选，从 AUTH-01 共享权限读取只读矩阵。
 * - 存量平台角色只读保留，客户账号仍使用所属类型的角色集。
 * - 业务设置封闭 key 集四项；command.confirmation 的确认方式由 DEC-023 固定——UI 只读展示；
 * - 高风险权限变更（角色/停用/重置）必须明确确认。
 */
import { PLATFORM_ROLES, hasPermission, isPlatformDeliveryRole } from '@fdp/auth/browser';
import type { Role } from '@fdp/auth/browser';
import { validateBusinessSettingValue } from '@fdp/contracts/settings/business-settings-v1.js';
import { roleDisplayName as sessionRoleDisplayName } from '../../menu/menu.js';
import type { SettingKey, SettingRuntimeStatus, UserStatus } from './types.js';
// ---------- 用户（BE-RBAC-01） ----------
export function roleDisplayName(role: Role): string {
  return role === 'PlatformOperator' ? translate('settings.roles.operator') : sessionRoleDisplayName(role);
}
export const USER_STATUS_OPTIONS: readonly UserStatus[] = ['INVITED', 'ACTIVE', 'DISABLED'];
export const USER_STATUS_LABELS: Readonly<Record<UserStatus, string>> = {
  get INVITED() {
    return translate('ui.cdacd173110e');
  },
  get ACTIVE() {
    return translate('page.f78d037abccd');
  },
  get DISABLED() {
    return translate('page.6c7dcbb73a59');
  },
};
/** 平台角色判定（AUTH-01 封闭集；其余为 Customer 角色）。 */
export function isPlatformRole(role: Role): boolean {
  return (PLATFORM_ROLES as readonly string[]).includes(role);
}
export interface InviteDraft {
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly Role[];
}
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 平台邀请使用 Cognito 临时凭证与已交付的角色。 */
export function validateInvite(draft: InviteDraft): string | null {
  if (!EMAIL_PATTERN.test(draft.email.trim()) || draft.email.trim().length > 254) {
    return translate('ui.4b345c5007d0');
  }
  const name = draft.displayName.trim();
  if (name.length === 0 || name.length > 128) {
    return translate('ui.a3ece6a764cf');
  }
  if (draft.roles.length === 0 || !draft.roles.every(isPlatformDeliveryRole)) {
    return translate('settings.roles.selectPlatformRole');
  }
  return null;
}
/** 角色集变更校验：1~3 且不混绑（自我提权/越权由服务端 403 最终裁决）。 */
export function validateRoleAssign(roles: readonly Role[]): string | null {
  if (roles.length < 1 || roles.length > 3) return translate('ui.3a2e1553df49');
  const platformCount = roles.filter(isPlatformRole).length;
  if (platformCount > 0 && platformCount < roles.length) return translate('ui.589ed5e42df0');
  return null;
}
// ---------- 业务设置（BE-SET-01） ----------
export const SETTING_KEYS: readonly SettingKey[] = [
  'alarm.thresholds',
  'command.confirmation',
  'dictionary.displayNames',
  'notification.business',
];
export const SETTING_KEY_LABELS: Readonly<Record<SettingKey, string>> = {
  get 'alarm.thresholds'() {
    return translate('ui.3d5cd1b64484');
  },
  get 'command.confirmation'() {
    return translate('ui.9e3f876d35e6');
  },
  get 'dictionary.displayNames'() {
    return translate('ui.0149c574da9a');
  },
  get 'notification.business'() {
    return translate('ui.8406bd86ff55');
  },
};
export const RUNTIME_STATUS_LABELS: Readonly<Record<SettingRuntimeStatus, string>> = {
  get ACTIVE() {
    return translate('ui.4b3acb8ea3dd');
  },
  get STORED_ONLY() {
    return translate('ui.f370566d31ef');
  },
};
/** DEC-023：命令确认方式固定——该 key 在 UI 只读展示，不提供编辑入口。 */
export const SETTING_READONLY_KEYS: readonly SettingKey[] = ['command.confirmation'];
/** 设置值 JSON 文本校验：前后端共享版本化 Schema，并返回精确字段路径。 */
export function validateSettingJson(key: SettingKey, raw: string): string | null {
  if (raw.trim() === '') return translate('ui.1b1cc8a947c1');
  try {
    const issues = validateBusinessSettingValue(key, JSON.parse(raw));
    if (issues.length === 0) return null;
    const first = issues[0]!;
    return `${first.path}: ${first.message}`;
  } catch {
    return translate('ui.3383f0e0c815');
  }
}
// ---------- 门控 ----------
export function canManageUsers(role: Role): boolean {
  return hasPermission(role, 'user:write');
}
export function canReadUsers(role: Role): boolean {
  return hasPermission(role, 'user:read');
}
export function canReadSettings(role: Role): boolean {
  return hasPermission(role, 'settings:read');
}
export function canWriteSettings(role: Role): boolean {
  return hasPermission(role, 'settings:write');
}
// ---------- CT-06 锚点（settings 页 FE-16 自有元素；Reject/Defer 不入表） ----------
export const SETTINGS_COVERAGE: Readonly<Record<string, string>> = {
  'settings.button.addPlatformUser': 'user-invite-open',
  'settings.button.resetPlatformUserPassword': 'user-reset-<userId>',
  'settings.button.deletePlatformUser': 'user-disable-<userId>',
  // FE-16 自有（clientSide）：设备用户筛选重置，由独立 DeviceUsersPage 承载
  'settings.button.deviceUserFilterReset': 'device-user-filter-reset',
};
