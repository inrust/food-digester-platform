/**
 * AUTH-01 集中式权限矩阵（V1 固定，DEC-012：不提供矩阵编辑 API，整体替换式演进）。
 *
 * 角色语义事实源：实施方案 §12.1 与 BE-RBAC-01 验收约束
 * （PlatformOperator 无合约、角色和 AWS 资源管理权限；Auditor 跨 Customer 只读 + 导出；
 * CustomerAdmin 仅管理所属 Customer 设备用户、查看数据、有限命令；CustomerViewer 只读）。
 *
 * 注意：本矩阵只表达产品页面/API 级权限，不授予任何 AWS 账号资源权限（DEC-012）。
 */
import type { Role } from './roles.js';

export const PERMISSIONS = [
  'dashboard:read',
  'customer:read',
  'customer:write',
  'site:read',
  'site:write',
  'device:read',
  'device:write',
  'device:assign',
  'device-user:read',
  'device-user:write',
  'onboarding:read',
  'onboarding:approve',
  // BE-CERT-03：证书轮换发起为安全敏感操作，仅授权安全角色（PlatformSuperAdmin）
  'certificate:rotate',
  'contract:read',
  'contract:write',
  'license:read',
  'license:write',
  'config:read',
  'config:publish',
  'command:send',
  'ota:read',
  'ota:write',
  'media:read',
  'alarm:read',
  'alarm:write',
  'report:read',
  'export:create',
  'audit:read',
  'user:read',
  'user:write',
  'role:read',
  'role:write',
  'settings:read',
  'settings:write',
  'replay:create',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const READ_PERMISSIONS = PERMISSIONS.filter((p) => p.endsWith(':read'));

/** 全平台配置、审批和权限管理（全部权限点）。 */
const PLATFORM_SUPER_ADMIN: readonly Permission[] = PERMISSIONS;

/** 客户、站点、设备、许可证、OTA 和命令操作；无合约写、角色、用户、设置、审批、导出权限。 */
const PLATFORM_OPERATOR: readonly Permission[] = [
  'dashboard:read',
  'customer:read',
  'customer:write',
  'site:read',
  'site:write',
  'device:read',
  'device:write',
  'device:assign',
  'onboarding:read',
  'contract:read',
  'license:read',
  'license:write',
  'config:read',
  'config:publish',
  'command:send',
  'ota:read',
  'ota:write',
  'media:read',
  'alarm:read',
  'alarm:write',
  'report:read',
  'replay:create',
];

/** 跨 Customer 只读、审计和报表导出。 */
const AUDITOR: readonly Permission[] = [...READ_PERMISSIONS, 'export:create'];

/** 所属 Customer：设备用户管理、数据查看、有限命令、数据导出。 */
const CUSTOMER_ADMIN: readonly Permission[] = [
  'dashboard:read',
  'site:read',
  'device:read',
  'device-user:read',
  'device-user:write',
  'media:read',
  'alarm:read',
  'report:read',
  'export:create',
  'command:send',
];

/** 所属 Customer 只读。 */
const CUSTOMER_VIEWER: readonly Permission[] = [
  'dashboard:read',
  'site:read',
  'device:read',
  'device-user:read',
  'media:read',
  'alarm:read',
  'report:read',
];

export const PERMISSION_MATRIX: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  PlatformSuperAdmin: new Set(PLATFORM_SUPER_ADMIN),
  PlatformOperator: new Set(PLATFORM_OPERATOR),
  Auditor: new Set(AUDITOR),
  CustomerAdmin: new Set(CUSTOMER_ADMIN),
  CustomerViewer: new Set(CUSTOMER_VIEWER),
} as const;

export function permissionsOf(role: Role): ReadonlySet<Permission> {
  return PERMISSION_MATRIX[role];
}

/** 角色是否持有权限点；任一角色持有即视为 actor 持有（见 guard.requirePermission）。 */
export function hasPermission(role: Role, permission: Permission): boolean {
  return PERMISSION_MATRIX[role].has(permission);
}
