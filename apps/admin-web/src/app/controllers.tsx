import { translate } from '../i18n/i18n.js';
import { actorTypeOf, hasPermission } from '@fdp/auth/browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../api/http-client.js';
import type { ToastQueue } from '../components/Toast.js';
import { canAccessRoute } from '../menu/menu.js';
import { findRoute } from '../router/routes.js';
import type { SessionSnapshot } from '../session/session-manager.js';
import { CustomersPage } from '../pages/customers/CustomersPage.js';
import {
  createCustomer,
  deactivateCustomer,
  fetchCustomers,
  updateCustomer,
} from '../pages/customers/customers-api.js';
import type { CustomerStatus, CustomerView } from '../pages/customers/types.js';
import { DashboardPage } from '../pages/dashboard/DashboardPage.js';
import { createDashboardCommandSubmitter, fetchDashboardOverview } from '../pages/dashboard/dashboard-api.js';
import type { DashboardPageState } from '../pages/dashboard/DashboardPage.js';
import {
  deviceGroupsPath,
  deviceGroupsReturnPath,
  groupFiltersFromContext,
  readDeviceGroupFilters,
  sitesWorkbenchPath,
  uniqueQueryId,
  withGroupFilters,
} from '../router/device-navigation.js';
import { collectAll } from './collect-all.js';
import { customerOptionLabels } from '../pages/customers/customer-options.js';
import { DeviceGroupsPage } from '../pages/devices/DeviceGroupsPage.js';
import { fetchDevices } from '../pages/devices/devices-api.js';
import type { DeviceView } from '../pages/devices/types.js';
import type { DetailState } from '../pages/onboarding/OnboardingReviewPanel.js';
import {
  approveOnboardingRequest,
  fetchOnboardingRequest,
  fetchOnboardingRequests,
  rejectOnboardingRequest,
} from '../pages/onboarding/onboarding-api.js';
import type { OnboardingRequestView, OnboardingStatus } from '../pages/onboarding/types.js';
import { SitesPage } from '../pages/sites/SitesPage.js';
import type { SiteFilters } from '../pages/sites/SitesPage.js';
import {
  createSite,
  deactivateSite,
  deleteSite,
  fetchSite,
  fetchSites,
  reactivateSite,
  updateSite,
} from '../pages/sites/sites-api.js';
import type { SiteInput, SiteView } from '../pages/sites/types.js';
interface PageResult<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
function useCursorController<T>(loader: (cursor: string | null) => Promise<PageResult<T>>) {
  const [rows, setRows] = useState<readonly T[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<readonly (string | null)[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [dataUpdatedAt, setDataUpdatedAt] = useState<string | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void loader(currentCursor)
      .then((result) => {
        if (!active) return;
        setRows(result.items);
        setNextCursor(result.nextCursor);
        setDataUpdatedAt(new Date().toISOString());
      })
      .catch((reason: unknown) => {
        if (active) setError(reason);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [currentCursor, loader, revision]);
  const reset = useCallback(() => {
    setPrevious([]);
    setCurrentCursor(null);
    setNextCursor(null);
    setRevision((value) => value + 1);
  }, []);
  const next = useCallback(
    (cursor: string) => {
      setPrevious((values) => [...values, currentCursor]);
      setCurrentCursor(cursor);
    },
    [currentCursor],
  );
  const prev = useCallback(() => {
    setPrevious((values) => {
      if (values.length === 0) return values;
      setCurrentCursor(values.at(-1) ?? null);
      return values.slice(0, -1);
    });
  }, []);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return {
    rows,
    nextCursor,
    loading,
    error,
    dataUpdatedAt,
    stale: loading && rows !== null,
    hasPrevPage: previous.length > 0,
    next,
    prev,
    refresh,
    reset,
  };
}
function can(session: SessionSnapshot, permission: Parameters<typeof hasPermission>[1]): boolean {
  return session.roles.some((role) => hasPermission(role, permission));
}
function success(toasts: ToastQueue, message: string) {
  toasts.push('success', message);
}
export function DashboardController({
  api,
  session,
  onNavigate,
}: {
  api: ApiClient;
  session: SessionSnapshot;
  onNavigate: (path: string) => void;
}) {
  const [state, setState] = useState<DashboardPageState>({ status: 'loading' });
  const load = useCallback(() => {
    setState({ status: 'loading' });
    void fetchDashboardOverview(api).then(
      (overview) => setState({ status: 'ready', overview }),
      (error: unknown) => setState({ status: 'error', error }),
    );
  }, [api]);
  useEffect(load, [load]);
  const submit = useMemo(() => createDashboardCommandSubmitter(api), [api]);
  const deviceList = findRoute('/devices/groups');
  const customerScope = session.roles.some((role) => actorTypeOf(role) === 'customer');
  return (
    <DashboardPage
      state={state}
      customerId={customerScope ? session.customerId : null}
      {...(can(session, 'alarm:read') ? { alarmsPath: '/alarms' } : {})}
      deviceListPath={deviceList !== null && canAccessRoute(deviceList, session.roles) ? deviceList.path : null}
      onRefresh={load}
      onSubmitCommand={submit}
      onNavigate={onNavigate}
    />
  );
}
export function CustomersController({
  api,
  session,
  toasts,
}: {
  api: ApiClient;
  session: SessionSnapshot;
  toasts: ToastQueue;
}) {
  const [status, setStatus] = useState<CustomerStatus | null>(null);
  const loader = useCallback(
    (cursor: string | null) => fetchCustomers(api, { ...(status ? { status } : {}), cursor, limit: 50 }),
    [api, status],
  );
  const page = useCursorController<CustomerView>(loader);
  const filter = (next: CustomerStatus | null) => {
    setStatus(next);
    page.reset();
  };
  return (
    <CustomersPage
      list={{
        rows: page.rows,
        loading: page.loading,
        error: page.error,
        nextCursor: page.nextCursor,
        stale: page.stale,
        ...(page.dataUpdatedAt ? { dataUpdatedAt: page.dataUpdatedAt } : {}),
        hasPrevPage: page.hasPrevPage,
      }}
      statusFilter={status}
      onFilterStatus={filter}
      onLoadMore={page.next}
      onLoadPrevious={page.prev}
      onRefresh={page.refresh}
      canWrite={can(session, 'customer:write')}
      onCreate={async (input) => {
        const result = await createCustomer(api, input);
        success(toasts, translate('ui.9b6d634c0d95'));
        return result;
      }}
      onUpdate={async (customer, input) => {
        const result = await updateCustomer(api, customer.id, customer.version, input);
        success(toasts, translate('ui.e9b29b1a7ffb'));
        return result;
      }}
      onDeactivate={async (customer, reason) => {
        const result = await deactivateCustomer(api, customer.id, customer.version, reason);
        success(toasts, translate('ui.4dff4b91ad96'));
        return result;
      }}
    />
  );
}
const EMPTY_SITE_FILTERS: SiteFilters = { customerId: null, region: null, subregion: null, status: null };
export function SitesController({
  api,
  session,
  toasts,
  search,
  onNavigate,
}: {
  api: ApiClient;
  session: SessionSnapshot;
  toasts: ToastQueue;
  search: string;
  onNavigate: (path: string) => void;
}) {
  const params = new URLSearchParams(search);
  const status = params.get('status');
  const deviceId = uniqueQueryId(search, 'deviceId');
  const siteId = uniqueQueryId(search, 'siteId');
  const [filters, setFilters] = useState<SiteFilters>(() => ({
    ...EMPTY_SITE_FILTERS,
    customerId: params.get('customerId'),
    status: status === 'ACTIVE' || status === 'SUSPENDED' ? status : null,
    region: params.get('region'),
    subregion: params.get('subregion'),
    keyword: params.get('keyword'),
  }));
  const fixedCustomerId = session.customerId;
  const effectiveFilters = useMemo(
    () => (fixedCustomerId === null ? filters : { ...filters, customerId: fixedCustomerId }),
    [filters, fixedCustomerId],
  );
  const [customerOptions, setCustomerOptions] = useState<
    readonly {
      value: string;
      label: string;
    }[]
  >(session.customerId === null ? [] : [{ value: session.customerId, label: session.customerId }]);
  useEffect(() => {
    if (!can(session, 'customer:read')) return;
    let active = true;
    void collectAll((cursor) => fetchCustomers(api, { cursor, limit: 100 })).then(
      (items) => {
        if (!active) return;
        const labels = customerOptionLabels(
          items,
          (customer) => customer.id,
          (customer) => customer.name,
        );
        setCustomerOptions(
          items.map((customer) => ({ value: customer.id, label: labels.get(customer.id) ?? customer.name })),
        );
      },
      (error: unknown) => {
        if (active) toasts.push('error', error instanceof Error ? error.message : translate('ui.9226e4104016'));
      },
    );
    return () => {
      active = false;
    };
  }, [api, session, toasts.push]);
  const loader = useCallback(
    (cursor: string | null) => fetchSites(api, effectiveFilters, { cursor, limit: 50 }),
    [api, effectiveFilters],
  );
  const page = useCursorController<SiteView>(loader);
  const readSite = useCallback((id: string) => fetchSite(api, id), [api]);
  const applyFilters = (next: SiteFilters) => {
    setFilters(next);
    page.reset();
  };
  return (
    <SitesPage
      list={{
        rows: page.rows,
        loading: page.loading,
        error: page.error,
        nextCursor: page.nextCursor,
        stale: page.stale,
        ...(page.dataUpdatedAt ? { dataUpdatedAt: page.dataUpdatedAt } : {}),
        hasPrevPage: page.hasPrevPage,
      }}
      filters={effectiveFilters}
      fixedCustomerId={fixedCustomerId}
      onFilterChange={applyFilters}
      onLoadMore={page.next}
      onLoadPrevious={page.prev}
      onRefresh={page.refresh}
      customerOptions={customerOptions}
      canWrite={can(session, 'site:write')}
      initialSiteId={siteId}
      onBack={() =>
        onNavigate(
          deviceId
            ? withGroupFilters(
                `/devices/manage?deviceId=${encodeURIComponent(deviceId)}`,
                groupFiltersFromContext(search),
              )
            : deviceGroupsReturnPath(search),
        )
      }
      onReadSite={readSite}
      onCreate={async (customerId: string, input: SiteInput) => {
        const result = await createSite(api, customerId, input);
        success(toasts, translate('ui.5992e4f5d109'));
        return result;
      }}
      onUpdate={async (site: SiteView, input: SiteInput) => {
        const result = await updateSite(api, site.id, site.version, input);
        success(toasts, translate('ui.aa0e7f450c75'));
        return result;
      }}
      onDeactivate={async (site: SiteView, reason: string) => {
        const result = await deactivateSite(api, site.id, site.version, reason);
        success(toasts, translate('ui.6fce6628527c'));
        return result;
      }}
      onReactivate={async (site) => {
        const result = await reactivateSite(api, site.id, site.version);
        success(toasts, translate('siteFlow.reactivated'));
        return result;
      }}
      onDelete={async (site) => {
        const result = await deleteSite(api, site.id, site.version);
        success(toasts, translate('siteFlow.deleted'));
        return result;
      }}
    />
  );
}
export function DeviceGroupsController({
  api,
  session,
  toasts,
  search = '',
  onNavigate,
}: {
  api: ApiClient;
  session: SessionSnapshot;
  toasts: ToastQueue;
  search?: string;
  onNavigate: (path: string, options?: { replace?: boolean }) => void;
}) {
  const filters = useMemo(() => readDeviceGroupFilters(search), [search]);
  const deviceLoader = useCallback(
    (cursor: string | null) => fetchDevices(api, { ...filters, customerId: session.customerId }, { cursor, limit: 50 }),
    [api, filters, session.customerId],
  );
  const devices = useCursorController<DeviceView>(deviceLoader);
  const [directory, setDirectory] = useState<readonly SiteView[]>([]);
  const loadDirectory = useCallback(
    () => collectAll((cursor) => fetchSites(api, { customerId: session.customerId }, { cursor, limit: 100 })),
    [api, session.customerId],
  );
  const [directoryRevision, setDirectoryRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setDirectory([]);
    void loadDirectory().then(
      (items) => {
        if (active) setDirectory(items);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [loadDirectory, directoryRevision]);
  const [knownSites, setKnownSites] = useState<{
    customerId: string | null;
    sites: ReadonlyMap<string, NonNullable<DeviceView['site']>>;
  } | null>(null);
  useEffect(() => {
    const customerId = session.customerId;
    const discovered = devices.rows?.flatMap((row) =>
      row.site && (customerId === null || row.customer?.id === customerId) ? [[row.site.id, row.site] as const] : [],
    );
    if (!discovered?.length) return;
    setKnownSites((previous) => ({
      customerId,
      sites: new Map([...(previous?.customerId === customerId ? previous.sites : []), ...discovered]),
    }));
  }, [devices.rows, session.customerId]);
  const [status, setStatus] = useState<OnboardingStatus>('PENDING');
  const onboardingLoader = useCallback(
    (cursor: string | null) => fetchOnboardingRequests(api, { status, cursor, limit: 50 }),
    [api, status],
  );
  const onboarding = useCursorController<OnboardingRequestView>(onboardingLoader);
  const [detail, setDetail] = useState<DetailState>({ kind: 'none' });
  const selected = useRef<{ requestId: string } | null>(null);
  const closeDetail = () => {
    selected.current = null;
    setDetail({ kind: 'none' });
  };
  const select = (requestId: string) => {
    const selection = { requestId };
    selected.current = selection;
    setDetail({ kind: 'loading' });
    void fetchOnboardingRequest(api, requestId).then(
      (request) => {
        if (selected.current === selection) setDetail({ kind: 'ready', request });
      },
      (error: unknown) => {
        if (selected.current === selection) setDetail({ kind: 'error', error, requestId });
      },
    );
  };
  const options = useMemo(() => {
    const locations = [
      ...new Map([
        ...(knownSites?.customerId === session.customerId ? knownSites.sites : []),
        ...directory.map((site) => [site.id, site] as const),
      ]).values(),
    ];
    const regions = [...new Set(locations.map((site) => site.region).filter((v): v is string => Boolean(v)))];
    const subregions = [
      ...new Map(
        locations.flatMap((site) =>
          site.region && site.subregion
            ? [
                [
                  `${site.region}/${site.subregion}`,
                  { value: site.subregion, label: site.subregion, region: site.region },
                ] as const,
              ]
            : [],
        ),
      ).values(),
    ];
    const sites = locations.flatMap((site) =>
      site.region && site.subregion
        ? [{ value: site.id, label: site.name, subregion: site.subregion, region: site.region }]
        : [],
    );
    return { regions: regions.map((value) => ({ value, label: value })), subregions, sites };
  }, [directory, knownSites, session.customerId]);
  return (
    <DeviceGroupsPage
      list={{
        rows: devices.rows,
        loading: devices.loading,
        error: devices.error,
        nextCursor: devices.nextCursor,
        stale: devices.stale,
        ...(devices.dataUpdatedAt ? { dataUpdatedAt: devices.dataUpdatedAt } : {}),
        hasPrevPage: devices.hasPrevPage,
      }}
      filters={filters}
      onApplyFilters={(next) => {
        devices.reset();
        const path = deviceGroupsPath(next);
        if (path !== deviceGroupsPath(filters)) onNavigate(path, { replace: true });
      }}
      onLoadMore={devices.next}
      onLoadPrevious={devices.prev}
      onRefresh={() => {
        devices.refresh();
        setDirectoryRevision((value) => value + 1);
      }}
      filterOptions={options}
      {...(can(session, 'site:read')
        ? { onOpenSites: () => onNavigate(withGroupFilters(sitesWorkbenchPath(), search)) }
        : {})}
      onNavigate={(path) => onNavigate(withGroupFilters(path, search))}
      {...(can(session, 'config:read')
        ? {
            onOpenConfigurations: () => onNavigate(withGroupFilters('/configurations', search)),
          }
        : {})}
      onboarding={{
        activeStatus: status,
        onFilterStatus: (next) => {
          setStatus(next);
          onboarding.reset();
          closeDetail();
        },
        list: {
          rows: onboarding.rows?.filter((request) => request.status === status) ?? null,
          loading: onboarding.loading,
          error: onboarding.error,
          nextCursor: onboarding.nextCursor,
          stale: onboarding.stale,
          ...(onboarding.dataUpdatedAt ? { dataUpdatedAt: onboarding.dataUpdatedAt } : {}),
          hasPrevPage: onboarding.hasPrevPage,
        },
        onLoadMore: onboarding.next,
        onLoadPrevious: onboarding.prev,
        onRefresh: onboarding.refresh,
        detail,
        onSelect: select,
        onCloseDetail: closeDetail,
        canReview: can(session, 'onboarding:approve'),
        onApprove: async (request) => {
          const result = await approveOnboardingRequest(api, request.requestId, request.version);
          success(toasts, translate('ui.34d0512e6db2'));
          return result;
        },
        onReject: async (request, reason) => {
          const result = await rejectOnboardingRequest(api, request.requestId, request.version, reason);
          if (selected.current?.requestId === request.requestId) closeDetail();
          onboarding.refresh();
          success(toasts, translate('ui.b419c31e7173'));
          return result;
        },
        onNavigate,
      }}
    />
  );
}
