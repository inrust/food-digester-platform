/**
 * DEC-012 原型角色映射策略（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/domain/role-mapping-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-012@0.2.0（status=pending，全部为定性规则，已可直接执行）。
 *
 * 消费方：AUTH-01（登录/鉴权）、BE-RBAC-01（RBAC）、FE-01（布局/导航）、FE-16（角色管理）。
 */

export type RoleMappingPolicyStatus = 'provisional' | 'frozen';

export type SystemRole = 'PlatformSuperAdmin' | 'PlatformOperator';

export interface RoleMapping {
  readonly prototypeRole: string;
  readonly systemRole: SystemRole;
  /** 界面显示名。 */
  readonly uiName: string;
}

export interface RoleMappingPolicy {
  readonly policyVersion: string;
  readonly status: RoleMappingPolicyStatus;
  readonly roleMappings: {
    readonly mappings: readonly RoleMapping[];
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly awsPermissions: {
    /** PlatformOperator 不授予 AWS 资源权限，锁定为 false。 */
    readonly operatorGetsAwsResourceAccess: false;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly matrix: {
    /** V1 权限矩阵固定，锁定为 true。 */
    readonly permissionMatrixFixed: true;
    /** 原型权限复选框只读，锁定为 true。 */
    readonly prototypeCheckboxesReadonly: true;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * 暂定值（DEC-012 v0.2.0，pending）：
 * 平台管理员→PlatformSuperAdmin；原型"运维人员"→PlatformOperator（界面名"设备操作员"），
 * 且不授予 AWS 资源权限；V1 权限矩阵固定，原型权限复选框只读。
 */
export const ROLE_MAPPING_POLICY: RoleMappingPolicy = {
  policyVersion: '0.1.0',
  status: 'provisional',
  roleMappings: {
    mappings: [
      { prototypeRole: '平台管理员', systemRole: 'PlatformSuperAdmin', uiName: '平台管理员' },
      { prototypeRole: '运维人员', systemRole: 'PlatformOperator', uiName: '设备操作员' },
    ],
    consumers: ['AUTH-01', 'BE-RBAC-01', 'FE-01', 'FE-16'],
    note: '原型角色到系统角色的封闭映射。PlatformOperator 界面名固定为"设备操作员"。新增角色必须先走 DEC-012 冻结或版本升级。',
  },
  awsPermissions: {
    operatorGetsAwsResourceAccess: false,
    consumers: ['AUTH-01', 'BE-RBAC-01'],
    note: 'PlatformOperator 不授予任何 AWS 资源权限（IAM/Cognito 组不含 AWS API 授权）；其能力仅限管理后台业务 API 范围内的 RBAC 权限点。',
  },
  matrix: {
    permissionMatrixFixed: true,
    prototypeCheckboxesReadonly: true,
    consumers: ['BE-RBAC-01', 'FE-01', 'FE-16'],
    note: 'V1 权限矩阵固定，不支持后台自定义编辑；原型界面中的权限复选框渲染为只读，仅用于展示当前角色的固定权限点。',
  },
  pendingParameters: [],
  frozenUpgradePath:
    'DEC-012 冻结时：按 decision-change-template 变更 DEC-012 至 >=1.0.0，status 改 frozen；若权限矩阵或角色集合变化需同步 BE-RBAC-01 权限点表与 FE-16 角色管理界面。',
} as const;

/** 原型角色 → 系统角色映射。未知原型角色返回 null（失败关闭）。 */
export function mapPrototypeRole(prototypeRole: string): RoleMapping | null {
  return ROLE_MAPPING_POLICY.roleMappings.mappings.find((m) => m.prototypeRole === prototypeRole) ?? null;
}

/** 系统角色的界面显示名。未知角色返回 null（失败关闭）。 */
export function getRoleUiName(systemRole: string): string | null {
  return ROLE_MAPPING_POLICY.roleMappings.mappings.find((m) => m.systemRole === systemRole)?.uiName ?? null;
}

/** 系统角色封闭集合。 */
export function getSystemRoles(): readonly SystemRole[] {
  return ROLE_MAPPING_POLICY.roleMappings.mappings.map((m) => m.systemRole);
}

/** 是否为已知系统角色。未知角色返回 false（失败关闭）。 */
export function isKnownSystemRole(role: string): role is SystemRole {
  return (getSystemRoles() as readonly string[]).includes(role);
}

/** 角色是否授予 AWS 资源权限。PlatformOperator 恒 false；PlatformSuperAdmin 由 Cognito 组配置决定（本策略不约束）；未知角色返回 false（失败关闭）。 */
export function roleHasAwsResourceAccess(role: string): boolean {
  if (!isKnownSystemRole(role)) return false;
  if (role === 'PlatformOperator') return ROLE_MAPPING_POLICY.awsPermissions.operatorGetsAwsResourceAccess;
  return true;
}

/** V1 权限矩阵是否固定：恒为 true（锁定规则）。 */
export function isPermissionMatrixFixed(): boolean {
  return ROLE_MAPPING_POLICY.matrix.permissionMatrixFixed;
}

/** 原型权限复选框是否只读：恒为 true（锁定规则）。 */
export function arePrototypeCheckboxesReadonly(): boolean {
  return ROLE_MAPPING_POLICY.matrix.prototypeCheckboxesReadonly;
}

/** 策略当前状态：provisional 表示 DEC-012 未冻结。 */
export function getRoleMappingPolicyStatus(): RoleMappingPolicyStatus {
  return ROLE_MAPPING_POLICY.status;
}
