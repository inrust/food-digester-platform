/**
 * @fdp/auth（AUTH-01）：Cognito JWT 认证与角色授权。
 *
 * 组成：认证 Guard（createCognitoAuthenticator）、授权 Decorator（withAuthorization）、
 * 集中式权限矩阵（PERMISSION_MATRIX）、角色模型与错误类型。
 * 后端授权是唯一可信来源；前端仅消费角色显示名（FE-01/FE-16）。
 */
export { AuthError, AUTH_ERROR_DEFAULT_MESSAGE, AUTH_ERROR_HTTP_STATUS, forbidden, unauthenticated } from './errors.js';
export type { AuthErrorCode } from './errors.js';
export { actorTypeOf, isRole, CUSTOMER_ROLES, PLATFORM_ROLES, ROLES } from './roles.js';
export type { ActorContext, ActorType, CustomerRole, PlatformRole, Role } from './roles.js';
export { hasPermission, permissionsOf, PERMISSION_MATRIX, PERMISSIONS } from './permissions.js';
export type { Permission } from './permissions.js';
export { createCognitoAuthenticator } from './cognito.js';
export type { CognitoAuthenticator, CognitoAuthenticatorConfig } from './cognito.js';
export { assertCustomerScope, requirePermission, withAuthorization } from './guard.js';
export type { AuthenticatedRequest, AuthorizationRule } from './guard.js';
