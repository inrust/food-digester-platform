import { useState } from 'react';
import { Modal } from '../components/Modal.js';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
/**
 * FE-02 顶部栏：面包屑、显示时区、用户区（角色显示名 + 登出）、移动端抽屉开关。
 * FE-19：全部文案经 i18n 资源；用户区提供语言切换入口（en/zh-CN，localStorage 持久化）。
 */
import { roleDisplayName } from '../menu/menu.js';
import { SUPPORTED_TIME_ZONES, useUserTimeZone } from '../components/TimeText.js';
import { LANGUAGE_LABELS, LANGUAGE_OPTIONS, isLanguage, useI18n } from '../i18n/i18n.js';
import type { OwnAccountProfile } from '../session/account-profile.js';
import type { SessionSnapshot } from '../session/session-manager.js';
import { breadcrumbsFor } from './breadcrumb.js';
import type { Ref } from 'react';

export interface TopbarProps {
  readonly path: string;
  readonly session: SessionSnapshot;
  readonly accountProfile?: OwnAccountProfile | null;
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
  accountProfile,
  onNavigate,
  onLogout,
  onOpenDrawer,
  drawerButtonRef,
}: TopbarProps) {
  const [accountOpen, setAccountOpen] = useState(false);
  const accountName = accountProfile?.displayName ?? session.verifiedEmail ?? session.username;
  const crumbs = breadcrumbsFor(path);
  const primaryRole = session.roles[0];
  const roleName = primaryRole === undefined ? null : roleDisplayName(primaryRole);
  const { timeZone, setTimeZone } = useUserTimeZone();
  const { language, setLanguage, t } = useI18n();

  return (
    <header className="topbar">
      <Button
        type="button"
        className="topbar-menu-button"
        aria-label={t('common.openNav')}
        data-testid="drawer-open"
        ref={drawerButtonRef}
        onClick={onOpenDrawer}
      >
        <Icon name="menu" />
      </Button>

      <nav aria-label={t('common.breadcrumb')} className="breadcrumb">
        <ol>
          {crumbs.map((crumb, index) => (
            <li key={`${crumb.i18nKey}-${index}`} aria-current={index === crumbs.length - 1 ? 'page' : undefined}>
              {crumb.path !== null ? (
                <a
                  href={crumb.path}
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigate(crumb.path as string);
                  }}
                >
                  {t(crumb.i18nKey)}
                </a>
              ) : (
                t(crumb.i18nKey)
              )}
            </li>
          ))}
        </ol>
      </nav>

      <div className="topbar-right">
        <label className="time-zone-control">
          <span>{t('common.timeZone')}</span>
          <select
            aria-label={t('common.timeZone')}
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
        <label className="language-control">
          <span>{t('common.language')}</span>
          <select
            aria-label={t('common.language')}
            data-testid="language-select"
            value={language}
            onChange={(event) => {
              if (isLanguage(event.target.value)) setLanguage(event.target.value);
            }}
          >
            {LANGUAGE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {LANGUAGE_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <div className="user-badge" data-testid="user-badge">
          <Button
            type="button"
            className="account-trigger"
            data-testid="topbar-account"
            aria-haspopup="dialog"
            aria-label={t('account.open', { name: accountName })}
            title={accountName}
            onClick={() => setAccountOpen(true)}
          >
            <span className="user-avatar" aria-hidden="true">
              {Array.from(accountName)[0]?.toUpperCase()}
            </span>
            <span className="user-name" data-testid="topbar-account-name">
              {accountName}
            </span>
          </Button>
          {roleName !== null ? (
            <span className="role-tag" data-testid="role-tag">
              {roleName}
            </span>
          ) : null}
          <Button type="button" className="logout-button" data-testid="logout-button" onClick={onLogout}>
            {t('common.logout')}
          </Button>
        </div>
      </div>
      <Modal
        open={accountOpen}
        title={t('account.details')}
        onClose={() => setAccountOpen(false)}
        testid="account-details"
      >
        <dl className="account-facts">
          <dt>{t('account.displayedName')}</dt>
          <dd>{accountName}</dd>
          {roleName !== null ? (
            <>
              <dt>{t('account.role')}</dt>
              <dd>{roleName}</dd>
            </>
          ) : null}
          {session.verifiedEmail !== undefined ? (
            <>
              <dt>{t('account.verifiedEmail')}</dt>
              <dd>{session.verifiedEmail}</dd>
            </>
          ) : null}
        </dl>
      </Modal>
    </header>
  );
}
