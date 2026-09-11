/**
 * FE-16 用户/角色与业务设置纯逻辑：封闭角色集、邀请校验、设置 key 目录、CT-06 锚点。
 *
 * - 角色集合封闭（AUTH-01/DEC-012），V1 权限矩阵固定只读：页面仅允许分配已有角色，
 *   权限复选框渲染为只读展示（不可编辑矩阵本身）；
 * - DEC-012 冻结显示名：PlatformOperator 界面名固定为“设备操作员”（不得使用“运维人员”）；
 * - 平台/Customer 角色禁止混绑（单一 actorType）；Customer 角色必填 customerId，平台角色必须省略；
 * - 业务设置封闭 key 集四项；command.confirmation 的确认方式由 DEC-023 固定——UI 只读展示；
 * - 高风险权限变更（角色/停用/重置）必须明确确认。
 */
import { PLATFORM_ROLES, ROLES, hasPermission } from '@fdp/auth';
import type { Role } from '@fdp/auth';
import { roleDisplayName } from '../../menu/menu.js';
import type { SettingKey, SettingRuntimeStatus, UserStatus } from './types.js';

// ---------- 用户（BE-RBAC-01） ----------

/** 封闭角色集（= AUTH-01 ROLES；parity 锁定契约 RoleCode 枚举）。 */
export const ROLE_OPTIONS: readonly Role[] = ROLES;

export { roleDisplayName };

export const USER_STATUS_OPTIONS: readonly UserStatus[] = ['INVITED', 'ACTIVE', 'DISABLED'];

export const USER_STATUS_LABELS: Readonly<Record<UserStatus, string>> = {
  INVITED: '已邀请',
  ACTIVE: '正常',
  DISABLED: '已停用',
};

/** 平台角色判定（AUTH-01 封闭集；其余为 Customer 角色）。 */
export function isPlatformRole(role: Role): boolean {
  return (PLATFORM_ROLES as readonly string[]).includes(role);
}

export interface InviteDraft {
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly Role[];
  readonly customerId: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 邀请校验：email 格式；displayName 1~128；角色 1~3 且平台/Customer 禁止混绑；
 * Customer 角色必填 customerId，平台角色必须省略。表单不含永久密码字段（Cognito 临时凭证）。
 */
export function validateInvite(draft: InviteDraft): string | null {
  if (!EMAIL_PATTERN.test(draft.email.trim()) || draft.email.trim().length > 254) {
    return '邮箱格式非法（≤254 字符）';
  }
  const name = draft.displayName.trim();
  if (name.length === 0 || name.length > 128) {
    return '显示名必填且不超过 128 字符';
  }
  if (draft.roles.length < 1 || draft.roles.length > 3) {
    return '角色须为 1~3 个';
  }
  const platformCount = draft.roles.filter(isPlatformRole).length;
  if (platformCount > 0 && platformCount < draft.roles.length) {
    return '平台角色与 Customer 角色禁止混绑';
  }
  if (platformCount === 0 && draft.customerId.trim() === '') {
    return 'Customer 角色必须指定所属 Customer';
  }
  if (platformCount > 0 && draft.customerId.trim() !== '') {
    return '平台角色无 Customer scope，必须省略 customerId';
  }
  return null;
}

/** 角色集变更校验：1~3 且不混绑（自我提权/越权由服务端 403 最终裁决）。 */
export function validateRoleAssign(roles: readonly Role[]): string | null {
  if (roles.length < 1 || roles.length > 3) return '角色须为 1~3 个';
  const platformCount = roles.filter(isPlatformRole).length;
  if (platformCount > 0 && platformCount < roles.length) return '平台角色与 Customer 角色禁止混绑';
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
  'alarm.thresholds': '业务告警阈值',
  'command.confirmation': '命令二次确认策略',
  'dictionary.displayNames': '字典显示名称',
  'notification.business': '业务通知配置',
};

export const RUNTIME_STATUS_LABELS: Readonly<Record<SettingRuntimeStatus, string>> = {
  ACTIVE: '已生效',
  STORED_ONLY: '仅存储（更新不代表业务行为生效）',
};

/** DEC-023：命令确认方式固定——该 key 在 UI 只读展示，不提供编辑入口。 */
export const SETTING_READONLY_KEYS: readonly SettingKey[] = ['command.confirmation'];

/** 设置值 JSON 文本校验（解析失败返回错误文案）。 */
export function validateSettingJson(raw: string): string | null {
  if (raw.trim() === '') return '设置值必填（JSON）';
  try {
    JSON.parse(raw);
    return null;
  } catch {
    return '设置值须为合法 JSON';
  }
}

// ---------- 门控 ----------

export function canManageUsers(role: Role): boolean {
  return hasPermission(role, 'user:write');
}

export function canReadUsers(role: Role): boolean {
  return hasPermission(role, 'user:read');
}

export function canReadDeviceUsers(role: Role): boolean {
  return hasPermission(role, 'device-user:read');
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
  // FE-16 自有（clientSide）：设备用户筛选重置，由嵌入的 DeviceUsersPage 承载
  'settings.button.deviceUserFilterReset': 'device-user-filter-reset',
};
