import { Button } from '../components/ui.js';
import { DesignProvider } from '../components/DesignProvider.js';
import { translate } from '../i18n/i18n.js';
import { useEffect, useState } from 'react';
import { ToastHost, useToastQueue } from '../components/Toast.js';
import { resetUserTimeZonePreference, TimeZoneProvider } from '../components/TimeText.js';
import { I18nProvider, useI18n } from '../i18n/i18n.js';
import { legacySettingsTarget } from '../router/routes.js';
import { resolveRoute } from '../router/guard.js';
import { fetchOwnAccountProfile } from '../session/account-profile.js';
import type { OwnAccountProfile } from '../session/account-profile.js';
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
import { deviceGroupsReturnPath, deviceWorkbenchId, uniqueQueryId } from '../router/device-navigation.js';
import { ValidatedDeviceWorkbench } from './DeviceWorkbench.js';
import { safeReturnPath, useBrowserRouter } from './browser-router.js';
import {
  BusinessSettingsController,
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
  'business-settings',
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
      <Button onClick={() => onNavigate('/dashboard')}>{translate('ui.13e491d46e85')}</Button>
    </main>
  );
}
function NotFoundPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <main className="standalone-page">
      <h1>404</h1>
      <p>{translate('ui.db6114c405c1')}</p>
      <Button onClick={() => onNavigate('/dashboard')}>{translate('ui.13e491d46e85')}</Button>
    </main>
  );
}
export function AdminWebApp({ services }: { readonly services: AdminWebServices }) {
  // FE-19：i18n 顶层挂载（语言切换即时生效；localStorage 持久化，刷新/重新登录保持）
  return (
    <I18nProvider>
      <DesignProvider>
        <AdminWebAppInner services={services} />
      </DesignProvider>
    </I18nProvider>
  );
}
function AdminWebAppInner({ services }: { readonly services: AdminWebServices }) {
  // Re-render legacy translate() pages on language changes without remounting unsaved forms.
  useI18n();
  const { location, navigate } = useBrowserRouter();
  const [sessionRevision, setSessionRevision] = useState(0);
  const [account, setAccount] = useState<{ key: string; profile: OwnAccountProfile } | null>(null);
  const navigateWithinApp = navigate;
  const toasts = useToastQueue();
  const session = services.session.current();
  useEffect(
    () =>
      services.session.onClear(() => {
        setAccount(null);
        setSessionRevision((value) => value + 1);
        navigate('/login', { replace: true });
      }),
    [navigate, services.session],
  );
  const accountKey = session === null ? null : JSON.stringify([sessionRevision, session.subject, session.username]);
  useEffect(() => {
    if (accountKey === null) return;
    const request = new AbortController();
    void fetchOwnAccountProfile(services.api, request.signal).then(
      (profile) => {
        if (!request.signal.aborted) setAccount({ key: accountKey, profile });
      },
      () => {
        // Login identity remains available when the business profile cannot be read.
      },
    );
    return () => request.abort();
  }, [accountKey, services.api]);
  const verdict = resolveRoute(location.pathname, session);
  const legacyTarget =
    session === null
      ? null
      : location.pathname === '/customers' && verdict.kind === 'allow'
        ? '/contracts/customers'
        : location.pathname === '/sites' && verdict.kind === 'allow'
          ? `/devices/sites${location.search}${location.hash}`
          : legacySettingsTarget(location.pathname, location.search, location.hash);
  useEffect(() => {
    if (legacyTarget !== null) {
      navigate(legacyTarget, { replace: true });
    } else if (verdict.kind === 'redirect-login') {
      navigate(`/login?returnTo=${encodeURIComponent(`${verdict.returnTo}${location.search}${location.hash}`)}`, {
        replace: true,
      });
    } else if (verdict.kind === 'redirect-home') {
      navigate(verdict.home, { replace: true });
    }
  }, [
    location.pathname,
    location.search,
    location.hash,
    legacyTarget,
    navigate,
    verdict.kind,
    verdict.kind === 'redirect-login' ? verdict.returnTo : '',
    verdict.kind === 'redirect-home' ? verdict.home : '',
  ]);
  if (legacyTarget !== null || verdict.kind === 'redirect-login' || verdict.kind === 'redirect-home') return null;
  if (verdict.kind === 'not-found') return <NotFoundPage onNavigate={navigate} />;
  if (verdict.kind === 'forbidden' || verdict.route.pageState === 'forbidden')
    return <ForbiddenPage onNavigate={navigate} />;
  if (verdict.route.pageState === 'login') {
    return (
      <LoginPage
        auth={services.auth}
        onAuthenticated={() => {
          resetUserTimeZonePreference();
          setSessionRevision((value) => value + 1);
          navigate(safeReturnPath(new URLSearchParams(location.search).get('returnTo')), { replace: true });
        }}
      />
    );
  }
  if (session === null) return null;
  const sessionScope = `${session.username}:${session.customerId}:${session.roles.join(',')}`;
  const scopeId = deviceWorkbenchId(location.pathname, location.search);
  const chooseDevice = () => navigate(deviceGroupsReturnPath(location.search));
  const inDeviceContext = (render: Parameters<typeof ValidatedDeviceWorkbench>[0]['children']) => (
    <ValidatedDeviceWorkbench
      key={JSON.stringify([sessionScope, location.pathname, scopeId])}
      api={services.api}
      requestedId={scopeId ?? ''}
      customerId={session.customerId}
      onChoose={chooseDevice}
    >
      {render}
    </ValidatedDeviceWorkbench>
  );
  let page;
  switch (verdict.route.pageState) {
    case 'dashboard':
      page = <DashboardController api={services.api} session={session} onNavigate={navigate} />;
      break;
    case 'device-group':
      page = (
        <DeviceGroupsController
          key={sessionScope}
          api={services.api}
          session={session}
          toasts={toasts}
          search={location.search}
          onNavigate={navigate}
        />
      );
      break;
    case 'customers':
      page = <CustomersController api={services.api} session={session} toasts={toasts} />;
      break;
    case 'sites':
      page = (
        <SitesController
          key={`${sessionScope}:${location.search}`}
          api={services.api}
          session={session}
          toasts={toasts}
          search={location.search}
          onNavigate={navigate}
        />
      );
      break;
    case 'device-view':
      page = (
        <DeviceViewController api={services.api} session={session} search={location.search} onNavigate={navigate} />
      );
      break;
    case 'device-manage':
      page = (
        <DeviceManageController
          key={`${sessionScope}:${location.search}`}
          api={services.api}
          session={session}
          search={location.search}
          onNavigate={navigate}
        />
      );
      break;
    case 'licenses': {
      const contractId = uniqueQueryId(location.search, 'contractId');
      const linkedLicense = uniqueQueryId(location.search, 'licenseId');
      page =
        contractId !== null || scopeId !== null || linkedLicense !== null ? (
          <LicensesController
            key={JSON.stringify([sessionScope, contractId, scopeId])}
            api={services.api}
            session={session}
            search={location.search}
            onNavigate={navigate}
          />
        ) : (
          <section className="detail-stack" data-testid="licenses-page">
            <h1>{translate('menu.licenses')}</h1>
            <p>{translate('cmpT07.chooseLicenseContext')}</p>
            <div className="action-row">
              <Button type="button" data-testid="license-choose-contract" onClick={() => navigate('/contracts')}>
                {translate('cmpT07.chooseContract')}
              </Button>
              <Button type="button" onClick={chooseDevice}>
                {translate('deviceWorkbench.chooseDevice')}
              </Button>
            </div>
          </section>
        );
      break;
    }
    case 'configurations':
      page =
        scopeId === null ? (
          <ConfigurationsController key={sessionScope} api={services.api} session={session} />
        ) : (
          inDeviceContext((device) => <ConfigurationsController api={services.api} session={session} device={device} />)
        );
      break;
    case 'device-users':
      page =
        scopeId === null ? (
          <section className="detail-stack" data-testid="device-users-page">
            <h1>{translate('menu.device-users')}</h1>
            <p>{translate('cmpT07.chooseDeviceUsers')}</p>
            <Button type="button" data-testid="device-user-choose-device" onClick={chooseDevice}>
              {translate('deviceWorkbench.chooseDevice')}
            </Button>
          </section>
        ) : (
          inDeviceContext((device) => (
            <DeviceUsersController
              key={uniqueQueryId(location.search, 'deviceUserId') ?? ''}
              api={services.api}
              session={session}
              device={device}
              linkedUserId={uniqueQueryId(location.search, 'deviceUserId')}
            />
          ))
        );
      break;
    case 'alarms':
      page =
        scopeId === null ? (
          <AlarmsController api={services.api} session={session} search={location.search} onNavigate={navigate} />
        ) : (
          inDeviceContext((device) => (
            <AlarmsController
              api={services.api}
              session={session}
              search={location.search}
              onNavigate={navigate}
              device={device}
            />
          ))
        );
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
      page =
        scopeId === null ? (
          <section className="detail-stack" data-testid="media-page">
            <h1>{translate('menu.media')}</h1>
            <p>{translate('deviceWorkbench.mediaChoose')}</p>
            <Button type="button" data-testid="media-choose-device" onClick={chooseDevice}>
              {translate('deviceWorkbench.chooseDevice')}
            </Button>
          </section>
        ) : (
          inDeviceContext((device) => <MediaController api={services.api} session={session} device={device} />)
        );
      break;
    case 'audit-logs':
      page = <AuditLogsController key={sessionScope} api={services.api} session={session} />;
      break;
    case 'settings':
      page = (
        <SettingsController
          key={sessionScope}
          api={services.api}
          session={session}
          onStatusSuccess={(message) => toasts.push('success', message)}
        />
      );
      break;
    case 'business-settings':
      page = <BusinessSettingsController key={sessionScope} api={services.api} session={session} />;
      break;
    case 'contract-modify':
      page = <ContractsController api={services.api} session={session} onNavigate={navigate} />;
      break;
    case 'contract-new':
      page = (
        <ContractNewController key={sessionScope} api={services.api} session={session} onNavigate={navigateWithinApp} />
      );
      break;
    case 'contract-detail':
      page = (
        <ContractDetailController
          key={`${sessionScope}:${location.search}`}
          api={services.api}
          session={session}
          search={location.search}
          onNavigate={navigate}
        />
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
        search={location.search}
        session={session}
        accountProfile={account?.key === accountKey ? account.profile : null}
        onNavigate={navigateWithinApp}
        onLogout={() => void services.auth.logout()}
      >
        {page}
      </AppShell>
      <ToastHost toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </TimeZoneProvider>
  );
}
