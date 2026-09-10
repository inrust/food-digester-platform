/** 浏览器安全的 AUTH-01 角色与权限表面；不得从此入口导出数据库、Node crypto 或服务端 Guard。 */
export { actorTypeOf, isRole, CUSTOMER_ROLES, PLATFORM_ROLES, ROLES } from './roles.js';
export type { ActorContext, ActorType, CustomerRole, PlatformRole, Role } from './roles.js';
export { hasPermission, permissionsOf, PERMISSION_MATRIX, PERMISSIONS } from './permissions.js';
export type { Permission } from './permissions.js';
