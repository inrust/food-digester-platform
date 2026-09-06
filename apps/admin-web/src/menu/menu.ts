/**
 * FE-01 基于角色的菜单派生与角色显示名。
 *
 * 菜单结构按原型 index19.html 侧栏：概览（顶级项）+ 设备管理 / ESG管理 / 合约管理 / 平台管理
 * 四个可折叠分组；项级可见性 = CT-06 菜单角色 ∩ 当前会话角色。
 * DEC-012 冻结显示名：PlatformSuperAdmin→平台管理员、PlatformOperator→设备操作员；
 * 其余角色 V1 无冻结显示名，回退角色代码本身（不得虚构）。
 */
import type { Role } from '@fdp/auth';
import type { AppRoute, MenuGroupId } from '../router/routes.js';
import { APP_ROUTES } from '../router/routes.js';

/** DEC-012@1.0.0 冻结的原型角色映射显示名（一致性由 contract-parity 测试核对）。 */
export const FROZEN_ROLE_DISPLAY_NAMES: Readonly<Partial<Record<Role, string>>> = {
  PlatformSuperAdmin: '平台管理员',
  PlatformOperator: '设备操作员',
} as const;

export function roleDisplayName(role: Role): string {
  return FROZEN_ROLE_DISPLAY_NAMES[role] ?? role;
}

export function canAccessRoute(route: AppRoute, roles: readonly Role[]): boolean {
  return roles.some((role) => route.roles.includes(role));
}

export interface MenuLeaf {
  readonly path: string;
  readonly pageState: string;
  readonly label: string;
}

export type MenuNode =
  | { readonly kind: 'leaf'; readonly item: MenuLeaf }
  | {
      readonly kind: 'group';
      readonly groupId: Exclude<MenuGroupId, 'overview'>;
      readonly label: string;
      readonly items: readonly MenuLeaf[];
    };

export const MENU_GROUP_LABELS: Readonly<Record<Exclude<MenuGroupId, 'overview'>, string>> = {
  device: '设备管理',
  esg: 'ESG管理',
  contract: '合约管理',
  platform: '平台管理',
} as const;

const GROUP_ORDER: readonly Exclude<MenuGroupId, 'overview'>[] = ['device', 'esg', 'contract', 'platform'];

/** 按会话角色派生侧栏菜单：概览顶级项在前，空分组整体隐藏。 */
export function menuForRoles(roles: readonly Role[]): MenuNode[] {
  const nodes: MenuNode[] = [];
  const menuRoutes = APP_ROUTES.filter((route) => route.menuGroup !== null && canAccessRoute(route, roles));

  for (const route of menuRoutes.filter((r) => r.menuGroup === 'overview')) {
    nodes.push({ kind: 'leaf', item: { path: route.path, pageState: route.pageState, label: route.label } });
  }
  for (const groupId of GROUP_ORDER) {
    const items = menuRoutes
      .filter((r) => r.menuGroup === groupId)
      .map((r) => ({ path: r.path, pageState: r.pageState, label: r.label }));
    if (items.length > 0) {
      nodes.push({ kind: 'group', groupId, label: MENU_GROUP_LABELS[groupId], items });
    }
  }
  return nodes;
}

/** 会话角色的首页（首个可见菜单路由）；五角色均可见 /dashboard。 */
export function homePathForRoles(roles: readonly Role[]): string {
  const first = APP_ROUTES.find((route) => route.menuGroup !== null && canAccessRoute(route, roles));
  return first?.path ?? '/login';
}
