/**
 * FE-02 面包屑派生：与路由注册表/菜单分组保持一致（菜单展开/路由/面包屑一致）。
 * FE-19：Crumb 携带 i18nKey（菜单/分组资源键），渲染层经 useI18n 解析（无硬编码文案）。
 *
 * 规则：菜单页 = [分组(纯文本), 页面(当前)]；概览/公共页 = [页面]；
 * 子页面 = [父分组(纯文本), 父菜单页(可点回链), 页面(当前)]。
 */
import {
  deviceGroupsReturnPath,
  deviceWorkbenchId,
  groupFiltersFromContext,
  uniqueQueryId,
  withGroupFilters,
} from '../router/device-navigation.js';
import { findRoute } from '../router/routes.js';

export interface Crumb {
  /** i18n 资源键（菜单项 menu.<pageState> / 分组 menu.group.<id> / common.pageNotFound）。 */
  readonly i18nKey: string;
  /** null = 当前页或纯分组（不可点击）。 */
  readonly path: string | null;
}

export function breadcrumbsFor(path: string, search = ''): Crumb[] {
  const route = findRoute(path);
  if (route === null) return [{ i18nKey: 'common.pageNotFound', path: null }];

  const contractId = path === '/licenses' ? uniqueQueryId(search, 'contractId') : null;
  if (contractId) {
    return [
      { i18nKey: 'menu.group.contract', path: null },
      { i18nKey: 'menu.contract-modify', path: '/contracts' },
      { i18nKey: 'menu.contract-detail', path: `/contracts/detail?contractId=${encodeURIComponent(contractId)}` },
      { i18nKey: 'menu.licenses', path: null },
    ];
  }
  const scopeId = deviceWorkbenchId(path, search);
  if (scopeId) {
    return [
      { i18nKey: 'menu.group.device', path: null },
      { i18nKey: 'menu.device-group', path: deviceGroupsReturnPath(search) },
      {
        i18nKey: 'menu.device-manage',
        path: withGroupFilters(
          `/devices/manage?deviceId=${encodeURIComponent(scopeId)}`,
          groupFiltersFromContext(search),
        ),
      },
      { i18nKey: `menu.${route.pageState}`, path: null },
    ];
  }

  const crumbs: Crumb[] = [];
  if (route.parentPath !== undefined) {
    const parent = findRoute(route.parentPath);
    if (parent !== null) {
      if (parent.menuGroup !== null && parent.menuGroup !== 'overview') {
        crumbs.push({ i18nKey: `menu.group.${parent.menuGroup}`, path: null });
      }
      crumbs.push({
        i18nKey: `menu.${parent.pageState}`,
        path: parent.path === '/devices/groups' ? deviceGroupsReturnPath(search) : parent.path,
      });
    }
  } else if (route.menuGroup !== null && route.menuGroup !== 'overview') {
    crumbs.push({ i18nKey: `menu.group.${route.menuGroup}`, path: null });
  }
  crumbs.push({ i18nKey: `menu.${route.pageState}`, path: null });
  return crumbs;
}
