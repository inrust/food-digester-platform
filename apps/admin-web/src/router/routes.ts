import { translate } from '../i18n/i18n.js';
/**
 * FE-01 路由注册表：正式 routeId 与角色可见性。
 *
 * 事实源：contracts/prototype-traceability.yaml（CT-06）的 menus.roles；
 * 一致性由 test/contract-parity.test.ts 自动核对，禁止单边修改。
 *
 * 注意：前端路由守卫只是体验层，授权唯一可信来源是后端（AUTH-01）。
 */
import type { Role } from '@fdp/auth';
import { hasPermission } from '@fdp/auth/browser';
export const LOGIN_PATH = '/login';
export const FORBIDDEN_PATH = '/403';
export type MenuGroupId = 'overview' | 'device' | 'esg' | 'contract' | 'platform';
/** 页面状态键（见 CT-06 pages；FE-05 新增 customers/sites 为矩阵外扩展路由）。 */
export type PageState =
  | 'login'
  | 'forbidden'
  | 'dashboard'
  | 'device-view'
  | 'device-operate'
  | 'device-group'
  | 'device-consumable'
  | 'esg-overview'
  | 'esg-device'
  | 'contract-modify'
  | 'settings'
  | 'device-manage'
  | 'contract-new'
  | 'contract-detail'
  | 'ota-campaigns'
  | 'ota-packages'
  | 'media'
  | 'audit-logs'
  | 'customers'
  | 'sites'
  | 'licenses'
  | 'configurations'
  | 'device-users'
  | 'alarms';
export interface AppRoute {
  readonly path: string;
  readonly pageState: PageState;
  readonly label: string;
  /** 允许访问的角色（菜单页遵循 CT-06；写子页面按对应权限收窄）。 */
  readonly roles: readonly Role[];
  /** 菜单归属；null = 非菜单页面（详情/子页）或公共页。 */
  readonly menuGroup: MenuGroupId | null;
  /** 子页面的父菜单路由（面包屑回链）。 */
  readonly parentPath?: string;
  readonly public?: boolean;
}
const ALL_ROLES: readonly Role[] = [
  'PlatformSuperAdmin',
  'PlatformOperator',
  'Auditor',
  'CustomerAdmin',
  'CustomerViewer',
];
export const APP_ROUTES: readonly AppRoute[] = [
  // ---------- 公共页 ----------
  {
    path: LOGIN_PATH,
    pageState: 'login',
    get label() {
      return translate('ui.21f1e88275aa');
    },
    roles: ALL_ROLES,
    menuGroup: null,
    public: true,
  },
  {
    path: FORBIDDEN_PATH,
    pageState: 'forbidden',
    get label() {
      return translate('ui.cb8d4d206806');
    },
    roles: ALL_ROLES,
    menuGroup: null,
    public: true,
  },
  // ---------- 菜单页（roles 与 CT-06 menus 一致） ----------
  {
    path: '/dashboard',
    pageState: 'dashboard',
    get label() {
      return translate('ui.5060421d1574');
    },
    roles: ALL_ROLES,
    menuGroup: 'overview',
  },
  {
    path: '/devices/view',
    pageState: 'device-view',
    get label() {
      return translate('ui.d791a9ce40d7');
    },
    roles: ALL_ROLES,
    menuGroup: 'device',
  },
  {
    path: '/devices/operate',
    pageState: 'device-operate',
    get label() {
      return translate('ui.cc2af6e2cf26');
    },
    roles: ['PlatformSuperAdmin', 'PlatformOperator', 'CustomerAdmin'],
    menuGroup: 'device',
  },
  {
    path: '/devices/groups',
    pageState: 'device-group',
    get label() {
      return translate('ui.6668806c8a06');
    },
    roles: ALL_ROLES,
    menuGroup: 'device',
  },
  // FE-09 扩展路由（CT-06 矩阵外）：config:read = 平台三角色（写操作另需 config:publish）
  {
    path: '/configurations',
    pageState: 'configurations',
    get label() {
      return translate('ui.9ecf700c43d4');
    },
    roles: ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor'],
    menuGroup: 'device',
  },
  {
    path: '/consumables',
    pageState: 'device-consumable',
    get label() {
      return translate('page.737c0b5f942e');
    },
    roles: ['PlatformSuperAdmin', 'PlatformOperator', 'CustomerAdmin', 'CustomerViewer'],
    menuGroup: 'device',
  },
  // FE-10 扩展路由（CT-06 矩阵外）：alarm:read = 全部五角色；Customer 角色租户隔离由服务端强制
  {
    path: '/alarms',
    pageState: 'alarms',
    get label() {
      return translate('ui.99470ca43b25');
    },
    roles: ALL_ROLES,
    menuGroup: 'device',
  },
  // FE-14 扩展路由（CT-06 矩阵外）：media:read = 全部五角色；Customer 角色强制租户隔离（跨 Customer → 404）
  {
    path: '/media',
    pageState: 'media',
    get label() {
      return translate('page.fd695a67e418');
    },
    roles: ALL_ROLES,
    menuGroup: 'device',
  },
  {
    path: '/esg/overview',
    pageState: 'esg-overview',
    get label() {
      return translate('ui.2ebe79bc6d95');
    },
    roles: ALL_ROLES,
    menuGroup: 'esg',
  },
  {
    path: '/esg/devices',
    pageState: 'esg-device',
    get label() {
      return translate('ui.765884cf332f');
    },
    roles: ALL_ROLES,
    menuGroup: 'esg',
  },
  {
    path: '/contracts',
    pageState: 'contract-modify',
    get label() {
      return translate('page.b38179cfadeb');
    },
    roles: ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor'],
    menuGroup: 'contract',
  },
  {
    path: '/settings',
    pageState: 'settings',
    get label() {
      return translate('page.baf84751a2a2');
    },
    roles: ['PlatformSuperAdmin', 'CustomerAdmin'],
    menuGroup: 'platform',
  },
  // ---------- FE-05 扩展路由（CT-06 矩阵外；权限与 BE-CUS-01/02 契约一致） ----------
  // customer:read 持有者 = 平台三角色；写操作 customer:write（SuperAdmin/Operator）在页面内按角色禁用
  {
    path: '/customers',
    pageState: 'customers',
    get label() {
      return translate('ui.88c9f74936f0');
    },
    roles: ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor'],
    menuGroup: 'platform',
  },
  // site:read = 全部五角色；Customer 角色 scope 由服务端强制
  {
    path: '/sites',
    pageState: 'sites',
    get label() {
      return translate('ui.f40b79d76fd3');
    },
    roles: ALL_ROLES,
    menuGroup: 'platform',
  },
  // FE-08 扩展路由（CT-06 矩阵外）：license:read = 平台三角色（AUTH-01；Customer 角色无 license:read）
  {
    path: '/licenses',
    pageState: 'licenses',
    get label() {
      return translate('ui.39f08a19b655');
    },
    roles: ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor'],
    menuGroup: 'contract',
  },
  // FE-09 扩展路由（CT-06 矩阵外）：按共享 device-user:read 权限生成角色；Viewer 只读。
  {
    path: '/device-users',
    pageState: 'device-users',
    get label() {
      return translate('page.024ebe3ff3d1');
    },
    roles: ALL_ROLES.filter((role) => hasPermission(role, 'device-user:read')),
    menuGroup: 'platform',
  },
  // FE-15 扩展路由（CT-06 矩阵外）：audit:read V1 仅 PlatformSuperAdmin/Auditor（Customer 角色 403）
  {
    path: '/audit-logs',
    pageState: 'audit-logs',
    get label() {
      return translate('page.7666cd43234e');
    },
    roles: ['PlatformSuperAdmin', 'Auditor'],
    menuGroup: 'platform',
  },
  // ---------- 子页面（非菜单入口；角色继承父菜单，见 CT-06 pages） ----------
  // FE-07/08/09/13：经“设备群管理”操作列进入
  {
    path: '/devices/manage',
    pageState: 'device-manage',
    get label() {
      return translate('ui.3507d67f5e20');
    },
    roles: ALL_ROLES,
    menuGroup: null,
    parentPath: '/devices/groups',
  },
  // FE-17：经“合约查询及修改”进入
  {
    path: '/contracts/new',
    pageState: 'contract-new',
    get label() {
      return translate('page.44c75e312909');
    },
    roles: ['PlatformSuperAdmin'],
    menuGroup: null,
    parentPath: '/contracts',
  },
  {
    path: '/contracts/detail',
    pageState: 'contract-detail',
    get label() {
      return translate('ui.c84686fe7947');
    },
    roles: ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor'],
    menuGroup: null,
    parentPath: '/contracts',
  },
  // FE-13：经概览“升级”入口进入；持有 ota:read 的角色（AUTH-01 权限矩阵）
  {
    path: '/ota/campaigns',
    pageState: 'ota-campaigns',
    get label() {
      return translate('page.bdb9a2faeb72');
    },
    roles: ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor'],
    menuGroup: null,
    parentPath: '/dashboard',
  },
  // FE-13 扩展路由（CT-06 矩阵外）：固件包上传/校验（BE-OTA-01），经“设备管理详情-选择固件文件”进入
  {
    path: '/ota/packages',
    pageState: 'ota-packages',
    get label() {
      return translate('page.520fc0679572');
    },
    roles: ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor'],
    menuGroup: null,
    parentPath: '/ota/campaigns',
  },
];
export function findRoute(path: string): AppRoute | null {
  return APP_ROUTES.find((route) => route.path === path) ?? null;
}
