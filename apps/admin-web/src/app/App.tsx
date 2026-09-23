import { translate } from '../i18n/i18n.js';
import { useCallback, useEffect, useState } from 'react';
import { ToastHost, useToastQueue } from '../components/Toast.js';
import { TimeZoneProvider } from '../components/TimeText.js';
import { I18nProvider } from '../i18n/i18n.js';
import { resolveRoute } from '../router/guard.js';
import { AppShell } from '../shell/AppShell.js';
import type { AdminWebServices } from './composition-root.js';
import { CustomersController, DashboardController, DeviceGroupsController, SitesController } from './controllers.js';
import {
  AlarmsController,
  ConfigurationsController,
  DeviceManageController,
  DeviceUsersController,
  DeviceViewController,
  LicensesController,
} from './feature-controllers.js';
import {
  AuditLogsController,
  DeviceOperateController,
  EsgDevicesController,
  EsgOverviewController,
  MediaController,
  OtaCampaignsController,
  OtaPackagesController,
} from './operations-controllers.js';
import { LoginPage } from './LoginPage.js';
import { safeReturnPath, useBrowserRouter } from './browser-router.js';
import {
  ConsumablesController,
  ContractDetailController,
  ContractNewController,
  ContractsController,
  SettingsController,
} from './business-controllers.js';
export const IMPLEMENTED_PAGE_STATES = [
  'login',
  'forbidden',
  'dashboard',
  'device-group',
  'customers',
  'sites',
  'device-view',
  'device-manage',
  'licenses',
  'configurations',
  'device-users',
  'alarms',
  'esg-overview',
  'esg-device',
  'device-operate',
  'ota-campaigns',
  'ota-packages',
  'media',
  'audit-logs',
  'settings',
  'contract-modify',
  'contract-new',
  'contract-detail',
  'device-consumable',
] as const;
function ForbiddenPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <main className="standalone-page">
      <h1>403</h1>
      <p>{translate('ui.aeed26f03ff5')}</p>
      <button onClick={() => onNavigate('/dashboard')}>{translate('ui.13e491d46e85')}</button>
    </main>
  );
}
function NotFoundPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <main className="standalone-page">
      <h1>404</h1>
      <p>{translate('ui.db6114c405c1')}</p>
      <button onClick={() => onNavigate('/dashboard')}>{translate('ui.13e491d46e85')}</button>
    </main>
  );
}
export function AdminWebApp({ services }: { readonly services: AdminWebServices }) {
  // FE-19：i18n 顶层挂载（语言切换即时生效；localStorage 持久化，刷新/重新登录保持）
  return (
    <I18nProvider>
      <AdminWebAppInner services={services} />
    </I18nProvider>
  );
}
function AdminWebAppInner({ services }: { readonly services: AdminWebServices }) {
  const { location, navigate } = useBrowserRouter();
  const [sessionRevision, setSessionRevision] = useState(0);
  const [contractNavigationBlocked, setContractNavigationBlocked] = useState(false);
  const navigateWithinApp = useCallback(
    (path: string, options?: { replace?: boolean }) => {
      if (contractNavigationBlocked) return;
      navigate(path, options);
    },
    [contractNavigationBlocked, navigate],
  );
  const toasts = useToastQueue();
  const session = services.session.current();
  useEffect(
    () =>
      services.session.onClear(() => {
        setSessionRevision((value) => value + 1);
        navigate('/login', { replace: true });
      }),
    [navigate, services.session],
  );
  void sessionRevision;
  const verdict = resolveRoute(location.pathname, session);
  useEffect(() => {
    if (verdict.kind === 'redirect-login') {
      navigate(`/login?returnTo=${encodeURIComponent(`${verdict.returnTo}${location.search}`)}`, { replace: true });
    } else if (verdict.kind === 'redirect-home') {
      navigate(verdict.home, { replace: true });
    }
  }, [
    location.pathname,
    location.search,
    navigate,
    verdict.kind,
    verdict.kind === 'redirect-login' ? verdict.returnTo : '',
    verdict.kind === 'redirect-home' ? verdict.home : '',
  ]);
  if (verdict.kind === 'redirect-login' || verdict.kind === 'redirect-home') return null;
  if (verdict.kind === 'not-found') return <NotFoundPage onNavigate={navigate} />;
  if (verdict.kind === 'forbidden' || verdict.route.pageState === 'forbidden')
    return <ForbiddenPage onNavigate={navigate} />;
  if (verdict.route.pageState === 'login') {
    return (
      <LoginPage
        auth={services.auth}
        onAuthenticated={() => {
          setSessionRevision((value) => value + 1);
          navigate(safeReturnPath(new URLSearchParams(location.search).get('returnTo')), { replace: true });
        }}
      />
    );
  }
  if (session === null) return null;
  let page;
  switch (verdict.route.pageState) {
    case 'dashboard':
      page = <DashboardController api={services.api} onNavigate={navigate} />;
      break;
    case 'device-group':
      page = <DeviceGroupsController api={services.api} session={session} toasts={toasts} onNavigate={navigate} />;
      break;
    case 'customers':
      page = <CustomersController api={services.api} session={session} toasts={toasts} />;
      break;
    case 'sites':
      page = <SitesController api={services.api} session={session} toasts={toasts} />;
      break;
    case 'device-view':
      page = <DeviceViewController api={services.api} search={location.search} onNavigate={navigate} />;
      break;
    case 'device-manage':
      page = (
        <DeviceManageController api={services.api} session={session} search={location.search} onNavigate={navigate} />
      );
      break;
    case 'licenses':
      page = <LicensesController api={services.api} session={session} search={location.search} onNavigate={navigate} />;
      break;
    case 'configurations':
      page = <ConfigurationsController api={services.api} session={session} />;
      break;
    case 'device-users':
      page = <DeviceUsersController api={services.api} session={session} />;
      break;
    case 'alarms':
      page = <AlarmsController api={services.api} session={session} search={location.search} onNavigate={navigate} />;
      break;
    case 'esg-overview':
      page = <EsgOverviewController api={services.api} session={session} />;
      break;
    case 'esg-device':
      page = <EsgDevicesController api={services.api} session={session} />;
      break;
    case 'device-operate':
      page = (
        <DeviceOperateController api={services.api} session={session} search={location.search} onNavigate={navigate} />
      );
      break;
    case 'ota-campaigns':
      page = <OtaCampaignsController api={services.api} session={session} onNavigate={navigate} />;
      break;
    case 'ota-packages':
      page = <OtaPackagesController api={services.api} session={session} onNavigate={navigate} />;
      break;
    case 'media':
      page = <MediaController api={services.api} session={session} />;
      break;
    case 'audit-logs':
      page = <AuditLogsController api={services.api} session={session} />;
      break;
    case 'settings':
      page = <SettingsController api={services.api} session={session} />;
      break;
    case 'contract-modify':
      page = <ContractsController api={services.api} session={session} onNavigate={navigate} />;
      break;
    case 'contract-new':
      page = (
        <ContractNewController
          api={services.api}
          onNavigate={navigateWithinApp}
          onNavigationBlockedChange={setContractNavigationBlocked}
        />
      );
      break;
    case 'contract-detail':
      page = (
        <ContractDetailController api={services.api} session={session} search={location.search} onNavigate={navigate} />
      );
      break;
    case 'device-consumable':
      page = <ConsumablesController api={services.api} session={session} />;
      break;
    default:
      page = (
        <section className="scope-notice">
          <h2>{verdict.route.label}</h2>
          <p>{translate('ui.1a5dfd366418')}</p>
        </section>
      );
  }
  return (
    <TimeZoneProvider>
      <AppShell
        path={location.pathname}
        session={session}
        onNavigate={navigateWithinApp}
        onLogout={() => void services.auth.logout()}
      >
        {page}
      </AppShell>
      <ToastHost toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </TimeZoneProvider>
  );
}
