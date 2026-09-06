/**
 * FE-02 面包屑派生：与路由注册表/菜单分组保持一致（菜单展开/路由/面包屑一致）。
 *
 * 规则：菜单页 = [分组(纯文本), 页面(当前)]；概览/公共页 = [页面]；
 * 子页面 = [父分组(纯文本), 父菜单页(可点回链), 页面(当前)]。
 */
import { MENU_GROUP_LABELS } from '../menu/menu.js';
import { findRoute } from '../router/routes.js';

export interface Crumb {
  readonly label: string;
  /** null = 当前页或纯分组（不可点击）。 */
  readonly path: string | null;
}

export function breadcrumbsFor(path: string): Crumb[] {
  const route = findRoute(path);
  if (route === null) return [{ label: '未找到页面', path: null }];

  const crumbs: Crumb[] = [];
  if (route.parentPath !== undefined) {
    const parent = findRoute(route.parentPath);
    if (parent !== null) {
      if (parent.menuGroup !== null && parent.menuGroup !== 'overview') {
        crumbs.push({ label: MENU_GROUP_LABELS[parent.menuGroup], path: null });
      }
      crumbs.push({ label: parent.label, path: parent.path });
    }
  } else if (route.menuGroup !== null && route.menuGroup !== 'overview') {
    crumbs.push({ label: MENU_GROUP_LABELS[route.menuGroup], path: null });
  }
  crumbs.push({ label: route.label, path: null });
  return crumbs;
}
