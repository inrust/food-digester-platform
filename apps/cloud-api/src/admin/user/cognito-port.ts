/**
 * BE-RBAC-01 Cognito 管理端口（注入式，无 AWS 依赖——部署层接 Cognito Admin API）。
 *
 * 同步语义（AUTH-01 运行时事实源）：
 * - 角色 ↔ User Pool Groups（`cognito:groups`）；
 * - Customer scope ↔ `custom:customer_id`（平台角色用户恒为 null）；
 * - 邀请/密码重置的临时凭证由 Cognito 生成并直接发送给用户——本端口与本 API
 *   均不接收、不返回管理员指定的永久密码或任何凭证材料；
 * - 部署层实现：AdminCreateUser（邀请）/ AdminAddUserToGroup + AdminRemoveUserFromGroup
 *   （角色）/ AdminUpdateUserAttributes（scope）/ AdminDisableUser（停用）/
 *   AdminResetUserPassword（重置触发）。
 */

export interface CognitoAdminPort {
  /** 邀请用户（Cognito 生成临时凭证并发送）；返回 Cognito 主体标识 sub。 */
  readonly inviteUser: (input: {
    readonly email: string;
    readonly groups: readonly string[];
    readonly customerId: string | null;
  }) => Promise<{ readonly cognitoSub: string }>;
  /** 整体替换用户 Group 集合（角色分配）。 */
  readonly setUserGroups: (input: { readonly cognitoSub: string; readonly groups: readonly string[] }) => Promise<void>;
  /** 同步 custom:customer_id（Customer 角色用户；平台角色传 null）。 */
  readonly setUserCustomerScope: (input: {
    readonly cognitoSub: string;
    readonly customerId: string | null;
  }) => Promise<void>;
  /** 停用（DISABLED 用户不可登录）。 */
  readonly disableUser: (input: { readonly cognitoSub: string }) => Promise<void>;
  /** 触发受控密码重置（Cognito 生成临时凭证并发送；无返回值材料）。 */
  readonly triggerPasswordReset: (input: { readonly cognitoSub: string }) => Promise<void>;
}
