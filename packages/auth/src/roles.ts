/**
 * AUTH-01 角色模型。
 *
 * 事实源：Cognito User Pool Group（IAC-01 创建同名 5 组）与 DEC-012 封闭映射。
 * 平台角色与 Customer 角色互斥：一个 actor 不允许同时携带两类角色（配置错误，失败关闭）。
 */

export const PLATFORM_ROLES = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor'] as const;
export const CUSTOMER_ROLES = ['CustomerAdmin', 'CustomerViewer'] as const;
export const ROLES = [...PLATFORM_ROLES, ...CUSTOMER_ROLES] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export type CustomerRole = (typeof CUSTOMER_ROLES)[number];
export type Role = (typeof ROLES)[number];

export type ActorType = 'platform' | 'customer';

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function actorTypeOf(role: Role): ActorType {
  return (PLATFORM_ROLES as readonly string[]).includes(role) ? 'platform' : 'customer';
}

/**
 * 请求上下文中的调用者身份（由认证 Guard 注入，后端授权的唯一可信来源）。
 * - actorId：Cognito `sub`；username：`cognito:username`；
 * - authenticatedAt：经签名验证的 Cognito `auth_time`，供 DEC-023 高风险操作重新认证门使用；
 * - platform actor 的 customerId 恒为 null（即使 Token 携带 custom:customer_id 也忽略）；
 * - customer actor 的 customerId 必非空（缺失即 403）。
 */
export interface ActorContext {
  readonly actorId: string;
  readonly username: string;
  readonly actorType: ActorType;
  readonly roles: readonly Role[];
  readonly customerId: string | null;
  readonly tokenUse: 'id' | 'access';
  readonly authenticatedAt?: string;
}
