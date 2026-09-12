import { translate } from '../i18n/i18n.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import type { ApiClient } from '../api/http-client.js';
import type { FilterOption } from '../components/ScopeFilter.js';
import {
  fetchAlarms,
  fetchAlarm,
  fetchDeviceEvents,
  fetchTamperEvents,
  acknowledgeAlarm,
  clearAlarm,
} from '../pages/alarms/alarms-api.js';
import { urlStateFromSearch, urlStateToSearch } from '../pages/alarms/alarm-state.js';
import type { AlarmPageUrlState, AlarmTab } from '../pages/alarms/alarm-state.js';
import { AlarmsPage } from '../pages/alarms/AlarmsPage.js';
import type { AlarmDetailState, ListState } from '../pages/alarms/AlarmsPage.js';
import type { AlarmView, DeviceEventView, TamperEventView } from '../pages/alarms/types.js';
import {
  fetchConfigurations,
  createConfiguration,
  fetchConfiguration,
  createConfigurationVersion,
  publishConfigurationVersion,
  fetchConfigurationVersionStatus,
} from '../pages/configuration/configuration-api.js';
import { EMPTY_CONFIGURATION_FILTER, ConfigurationsPage } from '../pages/configuration/ConfigurationsPage.js';
import type { ConfigurationDetailState, ConfigurationFilter } from '../pages/configuration/ConfigurationsPage.js';
import type { ConfigurationSummaryView } from '../pages/configuration/types.js';
import { fetchCustomers } from '../pages/customers/customers-api.js';
import {
  assignDevice,
  fetchDeviceAssignments,
  forceCompleteRetirement,
  reactivateDevice,
  requestCertificateRotation,
  retireDevice,
  suspendDevice,
  updateDeviceAlias,
} from '../pages/device-manage/device-manage-api.js';
import { DeviceManagePage } from '../pages/device-manage/DeviceManagePage.js';
import type { DeviceAssignmentView, RetirementRecordView, RotationRequestView } from '../pages/device-manage/types.js';
import {
  createDeviceUser,
  fetchDeviceUser,
  fetchDeviceUsers,
  updateDeviceUser,
  disableDeviceUser,
  assignDeviceUser,
  revokeDeviceUser,
} from '../pages/device-users/device-users-api.js';
import { DeviceUsersPage, EMPTY_DEVICE_USER_FILTER } from '../pages/device-users/DeviceUsersPage.js';
import type {
  DeviceUserDetailState,
  DeviceUserFilter,
  DeviceUserTopologyOption,
  DeviceUsersPageProps,
} from '../pages/device-users/DeviceUsersPage.js';
import type { DeviceUserListItemView } from '../pages/device-users/types.js';
import {
  fetchDevice,
  fetchDeviceActivities,
  fetchDeviceConsole,
  fetchDevices,
  fetchMediaDownloadUrl,
} from '../pages/devices/devices-api.js';
import { DeviceViewPage } from '../pages/devices/DeviceViewPage.js';
import type { ActivityState, ConsoleState, MediaState } from '../pages/devices/DeviceViewPage.js';
import type { DeviceView } from '../pages/devices/types.js';
import {
  activateLicense,
  createLicense,
  fetchLicenses,
  fetchLicense,
  fetchLicenseHistory,
  issueLicense,
  renewLicense,
  revokeLicense,
} from '../pages/licenses/licenses-api.js';
import { EMPTY_LICENSE_FILTER, LicensesPage } from '../pages/licenses/LicensesPage.js';
import type { LicenseDetailState, LicenseFilter } from '../pages/licenses/LicensesPage.js';
import type { LicenseView } from '../pages/licenses/types.js';
import { fetchSites } from '../pages/sites/sites-api.js';
import type { SiteView } from '../pages/sites/types.js';
import type { SessionSnapshot } from '../session/session-manager.js';
type Navigate = (
  path: string,
  options?: {
    replace?: boolean;
  },
) => void;
function roleOf(session: SessionSnapshot): Role {
  const role = session.roles[0];
  if (role === undefined) throw new Error(translate('ui.fb2397e137f4'));
  return role;
}
function queryId(search: string): string | null {
  const value = new URLSearchParams(search).get('deviceId');
  return value === null || value.trim() === '' ? null : value;
}
function option(value: string, label: string): FilterOption {
  return { value, label };
}
async function collectAll<T>(
  load: (cursor: string | null) => Promise<{
    readonly items: readonly T[];
    readonly nextCursor: string | null;
  }>,
): Promise<readonly T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await load(cursor);
    items.push(...page.items);
    if (page.nextCursor === null || seen.has(page.nextCursor)) return items;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
export function DeviceViewController({
  api,
  search,
  onNavigate,
}: {
  readonly api: ApiClient;
  readonly search: string;
  readonly onNavigate: Navigate;
}) {
  const [devices, setDevices] = useState<readonly DeviceView[]>([]);
  const [viewSites, setViewSites] = useState<readonly SiteView[]>([]);
  const [device, setDevice] = useState<DeviceView | null>(null);
  const [consoleState, setConsoleState] = useState<ConsoleState>({ status: 'idle' });
  const [mediaState, setMediaState] = useState<MediaState>({ status: 'idle' });
  const [activityState, setActivityState] = useState<ActivityState>({ status: 'idle' });
  const selectedId = useRef<string | null>(null);
  const loadConsole = useCallback(
    async (deviceId: string) => {
      selectedId.current = deviceId;
      setConsoleState({ status: 'loading' });
      setMediaState({ status: 'loading' });
      setActivityState({ status: 'loading' });
      try {
        const [nextDevice, consoleView, activities] = await Promise.all([
          fetchDevice(api, deviceId),
          fetchDeviceConsole(api, deviceId),
          fetchDeviceActivities(api, deviceId),
        ]);
        if (selectedId.current !== deviceId) return;
        setDevice(nextDevice);
        setConsoleState({ status: 'ready', console: consoleView });
        setActivityState({ status: 'ready', items: activities.items, nextCursor: activities.nextCursor });
        if (consoleView.latestMedia === null) setMediaState({ status: 'empty' });
        else {
          void fetchMediaDownloadUrl(api, consoleView.latestMedia.mediaId).then(
            (media) => {
              if (selectedId.current === deviceId) setMediaState({ status: 'ready', media });
            },
            (error: unknown) => {
              if (selectedId.current === deviceId) setMediaState({ status: 'error', error });
            },
          );
        }
      } catch (error) {
        if (selectedId.current === deviceId) {
          setConsoleState({ status: 'error', error });
          setActivityState({ status: 'error', error });
          setMediaState({ status: 'error', error });
        }
      }
    },
    [api],
  );
  useEffect(() => {
    let active = true;
    void Promise.all([
      collectAll((cursor) => fetchDevices(api, undefined, { cursor, limit: 100 })),
      collectAll((cursor) => fetchSites(api, undefined, { cursor, limit: 100 })),
    ]).then(
      ([deviceRows, siteRows]) => {
        if (active) {
          setDevices(deviceRows);
          setViewSites(siteRows);
        }
      },
      (error: unknown) => {
        if (active) setConsoleState({ status: 'error', error });
      },
    );
    return () => {
      active = false;
    };
  }, [api]);
  useEffect(() => {
    const initialId = queryId(search);
    if (initialId !== null && initialId !== selectedId.current) void loadConsole(initialId);
  }, [loadConsole, search]);
  const filterOptions = useMemo(() => {
    const regions = [...new Set(viewSites.map((site) => site.region).filter((v): v is string => v !== null))];
    const subregions = [
      ...new Set(
        viewSites.flatMap((site) => (site.region && site.subregion ? [`${site.region}\u0000${site.subregion}`] : [])),
      ),
    ];
    const sites = viewSites;
    return {
      regions: regions.map((value) => option(value, value)),
      subregions: subregions.map((value) => {
        const [region = '', subregion = ''] = value.split('\u0000');
        return { ...option(subregion, subregion), region };
      }),
      sites: sites
        .filter((site) => site.subregion !== null)
        .map((site) => ({ ...option(site.id, site.name), subregion: site.subregion ?? '' })),
      devices: devices
        .filter((d) => d.site !== null)
        .map((d) => ({ ...option(d.id, d.alias ?? d.serialNumber), siteId: d.site?.id ?? '' })),
    };
  }, [devices, viewSites]);
  return (
    <DeviceViewPage
      device={device}
      consoleState={consoleState}
      mediaState={mediaState}
      activityState={activityState}
      filterOptions={filterOptions}
      onApply={(id) => {
        onNavigate(`/devices/view?deviceId=${encodeURIComponent(id)}`, { replace: true });
        void loadConsole(id);
      }}
      onRefreshConsole={() => {
        if (selectedId.current !== null) void loadConsole(selectedId.current);
      }}
      onLoadMoreActivities={(cursor) => {
        const id = selectedId.current;
        if (id === null) return;
        void fetchDeviceActivities(api, id, cursor).then(
          (page) =>
            setActivityState((old) =>
              old.status === 'ready'
                ? { status: 'ready', items: [...old.items, ...page.items], nextCursor: page.nextCursor }
                : old,
            ),
          (error: unknown) => setActivityState({ status: 'error', error }),
        );
      }}
    />
  );
}
export function DeviceManageController({
  api,
  session,
  search,
  onNavigate,
}: {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
  readonly search: string;
  readonly onNavigate: Navigate;
}) {
  const deviceId = queryId(search);
  const [device, setDevice] = useState<DeviceView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<unknown>();
  const [assignments, setAssignments] = useState<readonly DeviceAssignmentView[] | null>(null);
  const [assignmentsError, setAssignmentsError] = useState<unknown>();
  const [retirement, setRetirement] = useState<RetirementRecordView | null>(null);
  const [rotation, setRotation] = useState<RotationRequestView | null>(null);
  const [customers, setCustomers] = useState<readonly FilterOption[]>([]);
  const [sites, setSites] = useState<
    readonly (FilterOption & {
      customerId: string;
    })[]
  >([]);
  const load = useCallback(async () => {
    if (deviceId === null) {
      setDevice(null);
      setAssignments([]);
      return;
    }
    setLoading(true);
    setLoadError(undefined);
    setAssignments(null);
    setAssignmentsError(undefined);
    const results = await Promise.allSettled([fetchDevice(api, deviceId), fetchDeviceAssignments(api, deviceId)]);
    if (results[0].status === 'fulfilled') {
      setDevice(results[0].value);
      setRetirement(results[0].value.retirement ?? null);
    } else setLoadError(results[0].reason);
    if (results[1].status === 'fulfilled') setAssignments(results[1].value);
    else {
      setAssignments([]);
      setAssignmentsError(results[1].reason);
    }
    setLoading(false);
  }, [api, deviceId]);
  useEffect(() => {
    setRotation(null);
    void load();
  }, [load]);
  useEffect(() => {
    let active = true;
    void Promise.all([fetchCustomers(api, { limit: 100 }), fetchSites(api, undefined, { limit: 100 })]).then(
      ([customerPage, sitePage]) => {
        if (!active) return;
        setCustomers(customerPage.items.map((c) => option(c.id, c.name)));
        setSites(sitePage.items.map((s) => ({ ...option(s.id, s.name), customerId: s.customerId })));
      },
      () => {
        if (active) {
          setCustomers([]);
          setSites([]);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [api]);
  const requireId = () => {
    if (deviceId === null) throw new Error(translate('ui.b05a6a2c019b'));
    return deviceId;
  };
  return (
    <DeviceManagePage
      role={roleOf(session)}
      device={device}
      loading={loading}
      {...(loadError !== undefined ? { loadError } : {})}
      assignments={assignments}
      {...(assignmentsError !== undefined ? { assignmentsError } : {})}
      retirement={retirement}
      rotation={rotation}
      customers={customers}
      sites={sites}
      onBack={() => onNavigate('/devices/groups')}
      onRefresh={() => void load()}
      onAssign={(input) => assignDevice(api, requireId(), input)}
      onSuspend={(reason) => suspendDevice(api, requireId(), reason)}
      onReactivate={(reason) => reactivateDevice(api, requireId(), reason)}
      onRetire={async (reason) => {
        const result = await retireDevice(api, requireId(), reason);
        setRetirement(result.retirement);
        return result;
      }}
      onForceComplete={async (reason) => {
        const result = await forceCompleteRetirement(api, requireId(), reason);
        setRetirement(result.retirement);
        return result;
      }}
      onUpdateAlias={(alias) => {
        if (device === null) throw new Error(translate('ui.f0438a199754'));
        return updateDeviceAlias(api, requireId(), alias, device.updatedAt);
      }}
      onRequestRotation={async () => {
        const result = await requestCertificateRotation(api, requireId());
        setRotation(result);
        return result;
      }}
      onNavigate={onNavigate}
    />
  );
}
export function LicensesController({ api, session }: { readonly api: ApiClient; readonly session: SessionSnapshot }) {
  const [filter, setFilter] = useState<LicenseFilter>(EMPTY_LICENSE_FILTER);
  const [list, setList] = useState<{
    rows: readonly LicenseView[] | null;
    loading?: boolean;
    error?: unknown;
    nextCursor?: string | null;
  }>({ rows: null });
  const [createCandidates, setCreateCandidates] = useState<
    readonly {
      deviceId: string;
      label: string;
    }[]
  >([]);
  const [detail, setDetail] = useState<LicenseDetailState>({ kind: 'none' });
  const selected = useRef<string | null>(null);
  const loadList = useCallback(
    async (cursor?: string) => {
      setList((old) => ({ ...old, loading: true, error: undefined }));
      try {
        const result = await fetchLicenses(
          api,
          { status: filter.licenseStatus, keyword: filter.keyword },
          { ...(cursor ? { cursor } : {}), limit: 50 },
        );
        setList({ rows: result.items, loading: false, nextCursor: result.nextCursor });
      } catch (error) {
        setList((old) => ({ ...old, loading: false, error }));
      }
    },
    [api, filter],
  );
  const loadDetail = useCallback(
    async (id: string) => {
      selected.current = id;
      setDetail({ kind: 'loading' });
      try {
        const license = await fetchLicense(api, id);
        setDetail({ kind: 'ready', license, history: null });
        try {
          const history = await fetchLicenseHistory(api, id);
          if (selected.current === id) setDetail({ kind: 'ready', license, history });
        } catch (historyError) {
          if (selected.current === id) setDetail({ kind: 'ready', license, history: [], historyError });
        }
      } catch (error) {
        if (selected.current === id) setDetail({ kind: 'error', error });
      }
    },
    [api],
  );
  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    let active = true;
    void collectAll((cursor) => fetchDevices(api, undefined, { cursor, limit: 100 })).then(
      (devices) => {
        if (active) {
          setCreateCandidates(
            devices
              .filter((device) => device.customer !== null && device.lifecycleStatus !== 'Retired')
              .map((device) => ({ deviceId: device.id, label: device.alias ?? device.serialNumber })),
          );
        }
      },
      () => {
        if (active) setCreateCandidates([]);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);
  const refresh = () => {
    void loadList();
    if (selected.current !== null) void loadDetail(selected.current);
  };
  return (
    <LicensesPage
      role={roleOf(session)}
      list={list}
      appliedFilter={filter}
      onApplyFilter={setFilter}
      onLoadMore={(cursor) => void loadList(cursor)}
      onRefresh={refresh}
      detail={detail}
      onSelect={(id) => void loadDetail(id)}
      onCloseDetail={() => {
        selected.current = null;
        setDetail({ kind: 'none' });
      }}
      createCandidates={createCandidates}
      onCreate={(input) => createLicense(api, input)}
      onIssue={(id) => issueLicense(api, id)}
      onActivate={(id) => activateLicense(api, id)}
      onRenew={(id, validTo) => renewLicense(api, id, validTo)}
      onRevoke={(id, reason) => revokeLicense(api, id, reason)}
    />
  );
}
export function ConfigurationsController({
  api,
  session,
}: {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
}) {
  const [filter, setFilter] = useState<ConfigurationFilter>(EMPTY_CONFIGURATION_FILTER);
  const [list, setList] = useState<{
    rows: readonly ConfigurationSummaryView[] | null;
    error?: unknown;
  }>({
    rows: null,
  });
  const [detail, setDetail] = useState<ConfigurationDetailState>({ kind: 'none' });
  const selected = useRef<string | null>(null);
  const loadList = useCallback(async () => {
    setList({ rows: null });
    try {
      setList({
        rows: await fetchConfigurations(api, {
          ...(filter.targetModel ? { targetModel: filter.targetModel } : {}),
          ...(filter.targetDeviceId ? { targetDeviceId: filter.targetDeviceId } : {}),
        }),
      });
    } catch (error) {
      setList({ rows: [], error });
    }
  }, [api, filter]);
  const loadDetail = useCallback(
    async (id: string) => {
      selected.current = id;
      setDetail({ kind: 'loading' });
      try {
        const next = await fetchConfiguration(api, id);
        if (selected.current === id) setDetail({ kind: 'ready', detail: next, sync: { kind: 'none' } });
      } catch (error) {
        if (selected.current === id) setDetail({ kind: 'error', error });
      }
    },
    [api],
  );
  useEffect(() => {
    void loadList();
  }, [loadList]);
  const refresh = () => {
    void loadList();
    if (selected.current !== null) void loadDetail(selected.current);
  };
  return (
    <ConfigurationsPage
      role={roleOf(session)}
      list={list}
      appliedFilter={filter}
      onApplyFilter={setFilter}
      onRefresh={refresh}
      detail={detail}
      onSelect={(id) => void loadDetail(id)}
      onCloseDetail={() => {
        selected.current = null;
        setDetail({ kind: 'none' });
      }}
      onLoadSyncStatus={(version) => {
        const id = selected.current;
        if (id === null) return;
        setDetail((old) => (old.kind === 'ready' ? { ...old, sync: { kind: 'loading', version } } : old));
        void fetchConfigurationVersionStatus(api, id, version).then(
          (data) => setDetail((old) => (old.kind === 'ready' ? { ...old, sync: { kind: 'ready', data } } : old)),
          (error: unknown) =>
            setDetail((old) => (old.kind === 'ready' ? { ...old, sync: { kind: 'error', version, error } } : old)),
        );
      }}
      onCreate={(input) => createConfiguration(api, input)}
      onCreateVersion={(id, input) => createConfigurationVersion(api, id, input)}
      onPublish={(id, version, input) => publishConfigurationVersion(api, id, version, input)}
    />
  );
}
export function useDeviceUsersPageProps({
  api,
  session,
}: {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
}): DeviceUsersPageProps {
  const fixedCustomerId = session.customerId;
  const [filter, setFilter] = useState<DeviceUserFilter>({ ...EMPTY_DEVICE_USER_FILTER, customerId: fixedCustomerId });
  const [list, setList] = useState<{
    rows: readonly DeviceUserListItemView[] | null;
    error?: unknown;
  }>({ rows: null });
  const [detail, setDetail] = useState<DeviceUserDetailState>({ kind: 'none' });
  const [customerOptions, setCustomerOptions] = useState<readonly FilterOption[]>([]);
  const [topologyOptions, setTopologyOptions] = useState<readonly DeviceUserTopologyOption[]>([]);
  const [assignableDevices, setAssignableDevices] = useState<readonly FilterOption[]>([]);
  const selected = useRef<string | null>(null);
  const loadList = useCallback(async () => {
    const customerId = fixedCustomerId ?? filter.customerId;
    setList({ rows: null });
    try {
      setList({
        rows: await fetchDeviceUsers(api, {
          ...(customerId ? { customerId } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.keyword ? { keyword: filter.keyword } : {}),
          ...(filter.region ? { region: filter.region } : {}),
          ...(filter.subregion ? { subregion: filter.subregion } : {}),
          ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
        }),
      });
    } catch (error) {
      setList({ rows: [], error });
    }
  }, [api, filter, fixedCustomerId]);
  const loadDetail = useCallback(
    async (id: string) => {
      selected.current = id;
      setDetail({ kind: 'loading' });
      try {
        const next = await fetchDeviceUser(api, id);
        if (selected.current === id) setDetail({ kind: 'ready', detail: next });
      } catch (error) {
        if (selected.current === id) setDetail({ kind: 'error', error });
      }
    },
    [api],
  );
  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    let active = true;
    const customerRequest = fixedCustomerId === null ? fetchCustomers(api, { limit: 100 }) : null;
    void Promise.allSettled([
      customerRequest ?? Promise.resolve(null),
      collectAll((cursor) =>
        fetchDevices(api, fixedCustomerId ? { customerId: fixedCustomerId } : undefined, { cursor, limit: 100 }),
      ),
    ]).then(([customersResult, devicesResult]) => {
      if (!active) return;
      if (customersResult.status === 'fulfilled' && customersResult.value !== null) {
        setCustomerOptions(customersResult.value.items.map((c) => option(c.id, c.name)));
      } else setCustomerOptions([]);
      if (devicesResult.status === 'fulfilled') {
        const ds = devicesResult.value;
        setTopologyOptions(
          ds.map((d) => ({
            deviceId: d.id,
            label: d.alias ?? d.serialNumber,
            customerId: d.customer?.id ?? null,
            region: d.site?.region ?? null,
            subregion: d.site?.subregion ?? null,
          })),
        );
        setAssignableDevices(
          ds.filter((d) => d.lifecycleStatus !== 'Retired').map((d) => option(d.id, d.alias ?? d.serialNumber)),
        );
      } else {
        setTopologyOptions([]);
        setAssignableDevices([]);
      }
    });
    return () => {
      active = false;
    };
  }, [api, fixedCustomerId]);
  const versionFor = (id: string) => {
    if (detail.kind !== 'ready' || detail.detail.deviceUserId !== id) throw new Error(translate('ui.70dfcb6f13f4'));
    return detail.detail.version;
  };
  const refresh = () => {
    void loadList();
    if (selected.current !== null) void loadDetail(selected.current);
  };
  return {
    role: roleOf(session),
    fixedCustomerId,
    customerOptions,
    topologyOptions,
    list,
    appliedFilter: filter,
    onApplyFilter: (next) => setFilter({ ...next, customerId: fixedCustomerId ?? next.customerId }),
    onRefresh: refresh,
    detail,
    onSelect: (id) => void loadDetail(id),
    onCloseDetail: () => {
      selected.current = null;
      setDetail({ kind: 'none' });
    },
    assignableDevices,
    onCreate: (input) =>
      createDeviceUser(api, fixedCustomerId === null ? input : { ...input, customerId: fixedCustomerId }),
    onUpdate: (id, input) => updateDeviceUser(api, id, versionFor(id), input),
    onDisable: (id, reason) => disableDeviceUser(api, id, versionFor(id), reason),
    onAssign: (id, ids, reason) => assignDeviceUser(api, id, versionFor(id), ids, reason),
    onRevoke: (id, ids, reason) => revokeDeviceUser(api, id, versionFor(id), ids, reason),
  };
}
export function DeviceUsersController({
  api,
  session,
}: {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
}) {
  return <DeviceUsersPage {...useDeviceUsersPageProps({ api, session })} />;
}
export function AlarmsController({
  api,
  session,
  search,
  onNavigate,
}: {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
  readonly search: string;
  readonly onNavigate: Navigate;
}) {
  const parsed = useMemo(() => urlStateFromSearch(search), [search]);
  const urlState = useMemo<AlarmPageUrlState>(
    () =>
      session.customerId === null
        ? parsed
        : {
            ...parsed,
            alarm: { ...parsed.alarm, customerId: session.customerId },
            event: { ...parsed.event, customerId: session.customerId },
            tamper: { ...parsed.tamper, customerId: session.customerId },
          },
    [parsed, session.customerId],
  );
  const [alarms, setAlarms] = useState<ListState<AlarmView>>({ rows: null });
  const [events, setEvents] = useState<ListState<DeviceEventView>>({ rows: null });
  const [tampers, setTampers] = useState<ListState<TamperEventView>>({ rows: null });
  const [detail, setDetail] = useState<AlarmDetailState>({ kind: 'none' });
  const [customerOptions, setCustomerOptions] = useState<readonly FilterOption[]>([]);
  const [alarmSiteOptions, setAlarmSiteOptions] = useState<
    readonly (FilterOption & {
      customerId: string;
    })[]
  >([]);
  const [alarmDeviceOptions, setAlarmDeviceOptions] = useState<
    readonly (FilterOption & {
      customerId: string;
      siteId: string;
    })[]
  >([]);
  const selected = useRef<string | null>(null);
  const load = useCallback(
    async (tab: AlarmTab, cursor?: string) => {
      if (tab === 'alarm') setAlarms((old) => ({ ...old, loading: true, error: undefined }));
      else if (tab === 'event') setEvents((old) => ({ ...old, loading: true, error: undefined }));
      else setTampers((old) => ({ ...old, loading: true, error: undefined }));
      try {
        if (tab === 'alarm') {
          const page = await fetchAlarms(api, urlState.alarm, cursor);
          setAlarms({ rows: page.rows, loading: false, nextCursor: page.nextCursor });
        } else if (tab === 'event') {
          const page = await fetchDeviceEvents(api, urlState.event, cursor);
          setEvents({ rows: page.rows, loading: false, nextCursor: page.nextCursor });
        } else {
          const page = await fetchTamperEvents(api, urlState.tamper, cursor);
          setTampers({ rows: page.rows, loading: false, nextCursor: page.nextCursor });
        }
      } catch (error) {
        if (tab === 'alarm') setAlarms((old) => ({ ...old, loading: false, error }));
        else if (tab === 'event') setEvents((old) => ({ ...old, loading: false, error }));
        else setTampers((old) => ({ ...old, loading: false, error }));
      }
    },
    [api, urlState],
  );
  const loadDetail = useCallback(
    async (id: string) => {
      selected.current = id;
      setDetail({ kind: 'loading' });
      try {
        const alarm = await fetchAlarm(api, id);
        if (selected.current === id) setDetail({ kind: 'ready', alarm });
      } catch (error) {
        if (selected.current === id) setDetail({ kind: 'error', error });
      }
    },
    [api],
  );
  useEffect(() => {
    void load(urlState.tab);
  }, [load, urlState.tab]);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      session.customerId === null
        ? collectAll((cursor) => fetchCustomers(api, { cursor, limit: 100 }))
        : Promise.resolve(null),
      collectAll((cursor) =>
        fetchSites(api, session.customerId ? { customerId: session.customerId } : undefined, { cursor, limit: 100 }),
      ),
      collectAll((cursor) =>
        fetchDevices(api, session.customerId ? { customerId: session.customerId } : undefined, {
          cursor,
          limit: 100,
        }),
      ),
    ]).then(([customers, sites, devices]) => {
      if (!active) return;
      setCustomerOptions(
        customers.status === 'fulfilled' && customers.value ? customers.value.map((c) => option(c.id, c.name)) : [],
      );
      setAlarmSiteOptions(
        sites.status === 'fulfilled'
          ? sites.value.map((s) => ({ ...option(s.id, s.name), customerId: s.customerId }))
          : [],
      );
      setAlarmDeviceOptions(
        devices.status === 'fulfilled'
          ? devices.value.flatMap((d) =>
              d.customer && d.site
                ? [{ ...option(d.id, d.alias ?? d.serialNumber), customerId: d.customer.id, siteId: d.site.id }]
                : [],
            )
          : [],
      );
    });
    return () => {
      active = false;
    };
  }, [api, session.customerId]);
  const apply = (next: AlarmPageUrlState) => onNavigate(`/alarms${urlStateToSearch(next)}`);
  const refresh = () => {
    void load(urlState.tab);
    if (selected.current !== null) void loadDetail(selected.current);
  };
  return (
    <AlarmsPage
      key={search}
      role={roleOf(session)}
      isCustomerRole={session.customerId !== null}
      customerOptions={customerOptions}
      siteOptions={alarmSiteOptions}
      deviceOptions={alarmDeviceOptions}
      urlState={urlState}
      onApplyUrlState={apply}
      alarms={alarms}
      events={events}
      tampers={tampers}
      onLoadMore={(tab, cursor) => void load(tab, cursor)}
      onRefresh={refresh}
      alarmDetail={detail}
      onSelectAlarm={(id) => void loadDetail(id)}
      onCloseAlarmDetail={() => {
        selected.current = null;
        setDetail({ kind: 'none' });
      }}
      onAcknowledge={(id, reason) => acknowledgeAlarm(api, id, reason)}
      onClear={(id, reason) => clearAlarm(api, id, reason)}
    />
  );
}
