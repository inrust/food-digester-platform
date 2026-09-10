import { hasPermission } from '@fdp/auth/browser';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../api/http-client.js';
import type { ToastQueue } from '../components/Toast.js';
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
import { DeviceGroupsPage, EMPTY_DEVICE_FILTERS } from '../pages/devices/DeviceGroupsPage.js';
import type { DeviceListFilters } from '../pages/devices/DeviceGroupsPage.js';
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
import { createSite, deactivateSite, fetchSites, updateSite } from '../pages/sites/sites-api.js';
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

export function DashboardController({ api, onNavigate }: { api: ApiClient; onNavigate: (path: string) => void }) {
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
  return <DashboardPage state={state} onRefresh={load} onSubmitCommand={submit} onNavigate={onNavigate} />;
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
        success(toasts, '客户已创建');
        return result;
      }}
      onUpdate={async (customer, input) => {
        const result = await updateCustomer(api, customer.id, customer.version, input);
        success(toasts, '客户已更新');
        return result;
      }}
      onDeactivate={async (customer, reason) => {
        const result = await deactivateCustomer(api, customer.id, customer.version, reason);
        success(toasts, '客户已停用');
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
}: {
  api: ApiClient;
  session: SessionSnapshot;
  toasts: ToastQueue;
}) {
  const [filters, setFilters] = useState<SiteFilters>(EMPTY_SITE_FILTERS);
  const [customerOptions, setCustomerOptions] = useState<readonly { value: string; label: string }[]>(
    session.customerId === null ? [] : [{ value: session.customerId, label: session.customerId }],
  );
  useEffect(() => {
    if (!can(session, 'customer:read')) return;
    void fetchCustomers(api, { limit: 100 }).then(
      (result) => setCustomerOptions(result.items.map((customer) => ({ value: customer.id, label: customer.name }))),
      (error: unknown) =>
        toasts.push('error', error instanceof Error ? error.message : '客户选项加载失败，请刷新后重试'),
    );
  }, [api, session, toasts.push]);
  const loader = useCallback(
    (cursor: string | null) => fetchSites(api, filters, { cursor, limit: 50 }),
    [api, filters],
  );
  const page = useCursorController<SiteView>(loader);
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
      filters={filters}
      onFilterChange={applyFilters}
      onLoadMore={page.next}
      onLoadPrevious={page.prev}
      onRefresh={page.refresh}
      customerOptions={customerOptions}
      canWrite={can(session, 'site:write')}
      onCreate={async (customerId: string, input: SiteInput) => {
        const result = await createSite(api, customerId, input);
        success(toasts, '站点已创建');
        return result;
      }}
      onUpdate={async (site: SiteView, input: SiteInput) => {
        const result = await updateSite(api, site.id, site.version, input);
        success(toasts, '站点已更新');
        return result;
      }}
      onDeactivate={async (site: SiteView, reason: string) => {
        const result = await deactivateSite(api, site.id, site.version, reason);
        success(toasts, '站点已停用');
        return result;
      }}
    />
  );
}

export function DeviceGroupsController({
  api,
  session,
  toasts,
  onNavigate,
}: {
  api: ApiClient;
  session: SessionSnapshot;
  toasts: ToastQueue;
  onNavigate: (path: string) => void;
}) {
  const [filters, setFilters] = useState<DeviceListFilters>(EMPTY_DEVICE_FILTERS);
  const deviceLoader = useCallback(
    (cursor: string | null) => fetchDevices(api, filters, { cursor, limit: 50 }),
    [api, filters],
  );
  const devices = useCursorController<DeviceView>(deviceLoader);
  const [status, setStatus] = useState<OnboardingStatus>('PENDING');
  const onboardingLoader = useCallback(
    (cursor: string | null) => fetchOnboardingRequests(api, { status, cursor, limit: 50 }),
    [api, status],
  );
  const onboarding = useCursorController<OnboardingRequestView>(onboardingLoader);
  const [detail, setDetail] = useState<DetailState>({ kind: 'none' });

  const select = (requestId: string) => {
    setDetail({ kind: 'loading' });
    void fetchOnboardingRequest(api, requestId).then(
      (request) => setDetail({ kind: 'ready', request }),
      (error: unknown) => setDetail({ kind: 'error', error }),
    );
  };
  const options = useMemo(() => {
    const rows = devices.rows ?? [];
    const regions = [...new Set(rows.map((row) => row.site?.region).filter((v): v is string => Boolean(v)))];
    const subregions = [
      ...new Map(
        rows.flatMap((row) =>
          row.site?.region && row.site.subregion
            ? [
                [
                  `${row.site.region}/${row.site.subregion}`,
                  { value: row.site.subregion, label: row.site.subregion, region: row.site.region },
                ] as const,
              ]
            : [],
        ),
      ).values(),
    ];
    const sites = [
      ...new Map(
        rows.flatMap((row) =>
          row.site?.subregion
            ? [[row.site.id, { value: row.site.id, label: row.site.name, subregion: row.site.subregion }] as const]
            : [],
        ),
      ).values(),
    ];
    return { regions: regions.map((value) => ({ value, label: value })), subregions, sites };
  }, [devices.rows]);

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
        setFilters(next);
        devices.reset();
      }}
      onLoadMore={devices.next}
      onLoadPrevious={devices.prev}
      onRefresh={devices.refresh}
      filterOptions={options}
      onNavigate={onNavigate}
      onboarding={{
        activeStatus: status,
        onFilterStatus: (next) => {
          setStatus(next);
          onboarding.reset();
          setDetail({ kind: 'none' });
        },
        list: {
          rows: onboarding.rows,
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
        onCloseDetail: () => setDetail({ kind: 'none' }),
        canReview: can(session, 'onboarding:approve'),
        onApprove: async (request) => {
          const result = await approveOnboardingRequest(api, request.requestId, request.version);
          success(toasts, '申请已批准');
          return result;
        },
        onReject: async (request, reason) => {
          const result = await rejectOnboardingRequest(api, request.requestId, request.version, reason);
          success(toasts, '申请已拒绝');
          return result;
        },
        onNavigate,
      }}
    />
  );
}
