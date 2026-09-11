/**
 * FE-02 侧栏：角色菜单渲染 + 可折叠分组（键盘可操作）。
 *
 * 菜单数据来自 FE-01 menuForRoles（已按角色过滤）；分组用 <button aria-expanded> 控制，
 * 菜单项用 <a href aria-current> 保证键盘与读屏可用；点击经 onNavigate 交给壳层路由。
 */
import { useState } from 'react';
import type { MenuNode } from '../menu/menu.js';
import { menuKeyForGroup, menuKeyForPageState, useI18n } from '../i18n/i18n.js';

export interface SidebarProps {
  readonly nodes: readonly MenuNode[];
  readonly currentPath: string;
  readonly onNavigate: (path: string) => void;
}

export function Sidebar({ nodes, currentPath, onNavigate }: SidebarProps) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const toggleGroup = (groupId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const renderItem = (item: { path: string; pageState: string; label: string }) => {
    const active = item.path === currentPath;
    return (
      <li key={item.path}>
        <a
          href={item.path}
          className={`menu-item${active ? ' active' : ''}`}
          data-testid={`menu-item-${item.path}`}
          aria-current={active ? 'page' : undefined}
          onClick={(event) => {
            event.preventDefault();
            onNavigate(item.path);
          }}
        >
          {t(menuKeyForPageState(item.pageState))}
        </a>
      </li>
    );
  };

  return (
    <nav aria-label={t('common.mainMenu')} className="sidebar-nav">
      <ul className="menu-list">
        {nodes.map((node) => {
          if (node.kind === 'leaf') {
            return renderItem(node.item);
          }
          const isCollapsed = collapsed.has(node.groupId);
          const subMenuId = `submenu-${node.groupId}`;
          return (
            <li key={node.groupId}>
              <button
                type="button"
                className="menu-item menu-group-toggle"
                data-testid={`menu-group-${node.groupId}`}
                aria-expanded={!isCollapsed}
                aria-controls={subMenuId}
                onClick={() => toggleGroup(node.groupId)}
              >
                {t(menuKeyForGroup(node.groupId))}
                <span aria-hidden="true" className={`arrow${isCollapsed ? '' : ' open'}`} />
              </button>
              <ul id={subMenuId} className="sub-menu" hidden={isCollapsed}>
                {node.items.map((item) => renderItem(item))}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
