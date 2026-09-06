/**
 * FE-02 管理后台壳层：侧栏 + 顶部栏 + 内容区 + 移动端抽屉（≤768px）。
 *
 * - 菜单由 FE-01 menuForRoles 按会话角色派生（按 route permission 过滤）；
 * - 移动端抽屉：汉堡按钮打开，遮罩点击或 Esc 关闭，关闭后焦点回收至汉堡按钮；
 * - 桌面/移动布局切换由 shell.css 的 @media (max-width: 768px) 完成。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { menuForRoles } from '../menu/menu.js';
import type { SessionSnapshot } from '../session/session-manager.js';
import { Sidebar } from './Sidebar.js';
import { Topbar } from './Topbar.js';

export interface AppShellProps {
  readonly path: string;
  readonly session: SessionSnapshot;
  readonly notificationCount?: number;
  readonly onNavigate: (path: string) => void;
  readonly onLogout: () => void;
  readonly children: ReactNode;
}

export function AppShell({ path, session, notificationCount, onNavigate, onLogout, children }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerButtonRef = useRef<HTMLButtonElement | null>(null);

  const closeDrawer = (returnFocus: boolean) => {
    setDrawerOpen(false);
    if (returnFocus) drawerButtonRef.current?.focus();
  };

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const nodes = menuForRoles(session.roles);

  const navigateAndClose = (next: string) => {
    setDrawerOpen(false);
    onNavigate(next);
  };

  return (
    <div className="app-shell">
      <div
        className={`sidebar-overlay${drawerOpen ? ' active' : ''}`}
        data-testid="drawer-overlay"
        onClick={() => closeDrawer(true)}
      />
      <aside className={`sidebar${drawerOpen ? ' open' : ''}`} data-testid="sidebar">
        <div className="logo">厨余机云平台</div>
        <Sidebar nodes={nodes} currentPath={path} onNavigate={navigateAndClose} />
      </aside>
      <div className="main-area">
        <Topbar
          path={path}
          session={session}
          {...(notificationCount !== undefined ? { notificationCount } : {})}
          onNavigate={onNavigate}
          onLogout={onLogout}
          onOpenDrawer={() => setDrawerOpen(true)}
          drawerButtonRef={drawerButtonRef}
        />
        <main className="page-content" data-testid="page-content">
          {children}
        </main>
      </div>
    </div>
  );
}
