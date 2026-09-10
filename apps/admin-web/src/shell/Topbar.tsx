/**
 * FE-02 顶部栏：面包屑、通知徽标、用户区（角色显示名 + 登出）、移动端抽屉开关。
 */
import { roleDisplayName } from '../menu/menu.js';
import { SUPPORTED_TIME_ZONES, useUserTimeZone } from '../components/TimeText.js';
import type { SessionSnapshot } from '../session/session-manager.js';
import { breadcrumbsFor } from './breadcrumb.js';
import type { Ref } from 'react';

export interface TopbarProps {
  readonly path: string;
  readonly session: SessionSnapshot;
  readonly notificationCount?: number;
  readonly onNavigate: (path: string) => void;
  readonly onLogout: () => void;
  /** 打开移动端抽屉（≤768px 可见，见 shell.css）。 */
  readonly onOpenDrawer: () => void;
  /** 抽屉按钮 ref：抽屉关闭后焦点回收到此按钮。 */
  readonly drawerButtonRef?: Ref<HTMLButtonElement>;
}

export function Topbar({
  path,
  session,
  notificationCount = 0,
  onNavigate,
  onLogout,
  onOpenDrawer,
  drawerButtonRef,
}: TopbarProps) {
  const crumbs = breadcrumbsFor(path);
  const primaryRole = session.roles[0];
  const { timeZone, setTimeZone } = useUserTimeZone();

  return (
    <header className="topbar">
      <button
        type="button"
        className="topbar-menu-button"
        aria-label="打开导航菜单"
        data-testid="drawer-open"
        ref={drawerButtonRef}
        onClick={onOpenDrawer}
      >
        ☰
      </button>

      <nav aria-label="面包屑" className="breadcrumb">
        <ol>
          {crumbs.map((crumb, index) => (
            <li key={`${crumb.label}-${index}`} aria-current={index === crumbs.length - 1 ? 'page' : undefined}>
              {crumb.path !== null ? (
                <a
                  href={crumb.path}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(crumb.path as string);
                  }}
                >
                  {crumb.label}
                </a>
              ) : (
                crumb.label
              )}
            </li>
          ))}
        </ol>
      </nav>

      <div className="topbar-right">
        <label className="time-zone-control">
          <span>显示时区</span>
          <select
            aria-label="显示时区"
            data-testid="time-zone-select"
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
          >
            {SUPPORTED_TIME_ZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="notification-button"
          aria-label={notificationCount > 0 ? `通知，${notificationCount} 条未读` : '通知，无未读'}
          data-testid="notification-button"
        >
          🔔
          {notificationCount > 0 ? (
            <span className="notification-badge" data-testid="notification-badge">
              {notificationCount}
            </span>
          ) : null}
        </button>

        <div className="user-badge" data-testid="user-badge">
          <span className="user-name">{session.username}</span>
          {primaryRole !== undefined ? (
            <span className="role-tag" data-testid="role-tag">
              {roleDisplayName(primaryRole)}
            </span>
          ) : null}
          <button type="button" className="logout-button" onClick={onLogout}>
            登出
          </button>
        </div>
      </div>
    </header>
  );
}
