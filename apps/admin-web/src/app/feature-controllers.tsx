import { deviceScopeMismatch } from './DeviceWorkbench.js';
import {
  deviceGroupsReturnPath,
  groupFiltersFromContext,
  licenseWorkbenchPath,
  uniqueQueryId,
  withGroupFilters,
} from '../router/device-navigation.js';
import { translate } from '../i18n/i18n.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import { hasPermission } from '@fdp/auth/browser';
import { createMediaDownloadUrl } from '../pages/media/media-api.js';
import { LiveImagePreview } from '../pages/devices/LiveImagePreview.js';
import { ApiClientError } from '../api/errors.js';
import type { ApiClient } from '../api/http-client.js';
import { collectAll } from './collect-all.js';
import { useDevicePicker } from './device-picker.js';
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
  fetchEffectiveConfigurationDevices,
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
  fetchDeviceUsers,
  updateDeviceUser,
  disableDeviceUser,
  assignDeviceUser,
  revokeDeviceUser,
} from '../pages/device-users/device-users-api.js';
import { DeviceUsersPage, EMPTY_DEVICE_USER_FILTER } from '../pages/device-users/DeviceUsersPage.js';
import type { DeviceUserFilter } from '../pages/device-users/DeviceUsersPage.js';
import { useDeviceUserDetail } from '../pages/device-users/use-device-user-detail.js';
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
import type { LicenseScope, LicenseScopeView } from '../pages/licenses/licenses-api.js';
import { EMPTY_LICENSE_FILTER, LicensesPage } from '../pages/licenses/LicensesPage.js';
import type { LicenseDetailState, LicenseFilter } from '../pages/licenses/LicensesPage.js';
import type { LicenseView } from '../pages/licenses/types.js';
import { fetchSites } from '../pages/sites/sites-api.js';
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
export function DeviceViewController({
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
  const picker = useDevicePicker(api, session.customerId);
  const [device, setDevice] = useState<DeviceView | null>(null);
  const [consoleState, setConsoleState] = useState<ConsoleState>({ status: 'idle' });
  const [mediaState, setMediaState] = useState<MediaState>({ status: 'idle' });
  const [activityState, setActivityState] = useState<ActivityState>({ status: 'idle' });
  const selectedId = useRef<string | null>(null);
  const generation = useRef(0);
  const [previewDeviceId, setPreviewDeviceId] = useState<string | null>(null);
  const loadConsole = useCallback(
    async (deviceId: string) => {
      const request = ++generation.current;
      selectedId.current = deviceId;
      setDevice(null);
      setPreviewDeviceId(deviceId);
      setConsoleState({ status: 'loading' });
      setMediaState({ status: 'loading' });
      setActivityState({ status: 'loading' });
      try {
        const [nextDevice, consoleView, activities] = await Promise.all([
          fetchDevice(api, deviceId),
          fetchDeviceConsole(api, deviceId),
          fetchDeviceActivities(api, deviceId),
        ]);
        if (generation.current !== request) return;
        setDevice(nextDevice);
        setConsoleState({ status: 'ready', console: consoleView });
        setActivityState({ status: 'ready', items: activities.items, nextCursor: activities.nextCursor });
        if (consoleView.latestMedia === null) setMediaState({ status: 'empty' });
        else {
          void fetchMediaDownloadUrl(api, consoleView.latestMedia.mediaId).then(
            (media) => {
              if (generation.current === request) setMediaState({ status: 'ready', media });
            },
            (error: unknown) => {
              if (generation.current === request) setMediaState({ status: 'error', error });
            },
          );
        }
      } catch (error) {
        if (generation.current === request) {
          setConsoleState({ status: 'error', error });
          setActivityState({ status: 'error', error });
          setMediaState({ status: 'error', error });
        }
      }
    },
    [api],
  );
  useEffect(() => {
    const initialId = queryId(search);
    if (initialId === null && selectedId.current !== null) {
      generation.current += 1;
      selectedId.current = null;
      setPreviewDeviceId(null);
      setDevice(null);
      setConsoleState({ status: 'idle' });
      setMediaState({ status: 'idle' });
      setActivityState({ status: 'idle' });
    } else if (initialId !== null && initialId !== selectedId.current) void loadConsole(initialId);
  }, [loadConsole, search]);
  return (
    <DeviceViewPage
      device={device}
      liveImagePreview={
        device &&
        device.id === previewDeviceId &&
        device.customer !== null &&
        (session.customerId === null || session.customerId === device.customer.id) &&
        ['Active', 'Maintenance'].includes(device.lifecycleStatus) &&
        ['Active', 'Maintenance'].includes(device.operationalStatus ?? '') &&
        consoleState.status !== 'error' &&
        session.roles.some((role) => hasPermission(role, 'device:read')) &&
        session.roles.some((role) => hasPermission(role, 'media:read')) ? (
          <LiveImagePreview
            key={`${session.username}:${session.customerId}:${session.roles.join(',')}:${device.id}`}
            api={api}
            deviceId={device.id}
            label={device.alias ?? device.serialNumber}
          />
        ) : null
      }
      consoleState={consoleState}
      mediaState={mediaState}
      activityState={activityState}
      filterOptions={picker.options}
      pickerState={picker.state}
      onRetryPicker={picker.retry}
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
        const request = generation.current;
        void fetchDeviceActivities(api, id, cursor).then(
          (page) => {
            if (request !== generation.current) return;
            setActivityState((old) =>
              old.status === 'ready'
                ? { status: 'ready', items: [...old.items, ...page.items], nextCursor: page.nextCursor }
                : old,
            );
          },
          (error: unknown) => {
            if (request === generation.current) setActivityState({ status: 'error', error });
          },
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
    if (results[0].status === 'fulfilled' && results[0].value.id === deviceId) {
      setDevice(results[0].value);
      setRetirement(results[0].value.retirement ?? null);
    } else {
      setDevice(null);
      setLoadError(results[0].status === 'rejected' ? results[0].reason : deviceScopeMismatch());
    }
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
      onBack={() => onNavigate(deviceGroupsReturnPath(search))}
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
      onNavigate={(path) =>
        onNavigate(
          /^(\/configurations|\/media|\/alarms|\/licenses|\/device-users)\?/.test(path)
            ? withGroupFilters(path, groupFiltersFromContext(search))
            : path,
        )
      }
    />
  );
}
export function LicensesController({
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
  const contractId = uniqueQueryId(search, 'contractId');
  const deviceId = uniqueQueryId(search, 'deviceId');
  const linkedId = uniqueQueryId(search, 'licenseId');
  const groupSearch = groupFiltersFromContext(search);
  const scope = useMemo<LicenseScope>(
    () => ({
      ...(contractId ? { contractId } : {}),
      ...(deviceId ? { deviceId } : {}),
    }),
    [contractId, deviceId],
  );
  const pathFor = (licenseId?: string) =>
    withGroupFilters(
      licenseWorkbenchPath({
        ...scope,
        ...(licenseId ? { licenseId } : {}),
      }),
      groupSearch,
    );
  const [filter, setFilter] = useState<LicenseFilter>(EMPTY_LICENSE_FILTER);
  const [list, setList] = useState<{
    rows: readonly LicenseView[] | null;
    loading?: boolean;
    error?: unknown;
    nextCursor?: string | null;
  }>({ rows: null });
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const resolved = useMemo(() => (scopeKey === null ? null : (JSON.parse(scopeKey) as LicenseScopeView)), [scopeKey]);
  const [detail, setDetail] = useState<LicenseDetailState>({ kind: 'none' });
  const selected = useRef<{ id: string; scope?: LicenseScope } | null>(null);
  const latestList = useRef(0);
  const invalid = contractId === '' || deviceId === '' || linkedId === '';
  const lookupLegacy = !contractId && !deviceId && Boolean(linkedId);
  const loadList = useCallback(
    async (cursor?: string) => {
      const generation = ++latestList.current;
      setList((old) => ({ ...old, loading: true, error: undefined }));
      try {
        if (invalid) throw deviceScopeMismatch();
        if (lookupLegacy && linkedId) {
          const license = await fetchLicense(api, linkedId);
          if (generation !== latestList.current) return;
          if (license.licenseId !== linkedId) throw deviceScopeMismatch();
          onNavigate(
            withGroupFilters(licenseWorkbenchPath({ deviceId: license.deviceId, licenseId: linkedId }), groupSearch),
            { replace: true },
          );
          return;
        }
        const result = await fetchLicenses(
          api,
          { status: filter.licenseStatus, keyword: filter.keyword, scope },
          { ...(cursor ? { cursor } : {}), limit: 50 },
        );
        if (generation !== latestList.current) return;
        const context = result.scope;
        if (
          !context ||
          (contractId !== null && context.contractId !== contractId) ||
          (deviceId !== null && (context.devices.length !== 1 || context.devices[0]?.deviceId !== deviceId)) ||
          result.items.some(
            (row) => !context.devices.some((d) => d.deviceId === row.deviceId && d.customerId === row.customerId),
          )
        ) {
          throw deviceScopeMismatch();
        }
        if (!contractId && context.contractId && deviceId) {
          onNavigate(
            withGroupFilters(
              licenseWorkbenchPath({
                contractId: context.contractId,
                deviceId,
                ...(linkedId ? { licenseId: linkedId } : {}),
              }),
              groupSearch,
            ),
            { replace: true },
          );
          return;
        }
        setScopeKey(JSON.stringify(context));
        setList({ rows: result.items, loading: false, nextCursor: result.nextCursor });
      } catch (error) {
        if (generation !== latestList.current) return;
        selected.current = null;
        setDetail({ kind: 'none' });
        setScopeKey(null);
        setList({ rows: [], error });
      }
    },
    [api, contractId, deviceId, filter, groupSearch, invalid, linkedId, lookupLegacy, onNavigate, scope],
  );
  const loadDetail = useCallback(
    async (id: string) => {
      if (!resolved) return;
      const selection: NonNullable<typeof selected.current> = { id };
      selected.current = selection;
      setDetail({ kind: 'loading' });
      try {
        const license = await fetchLicense(api, id, scope);
        if (selection !== selected.current) return;
        const device = resolved.devices.find(
          (candidate) => candidate.deviceId === license.deviceId && candidate.customerId === license.customerId,
        );
        if (license.licenseId !== id || !device) throw deviceScopeMismatch();
        selection.scope = {
          ...scope,
          deviceId: device.deviceId,
          ...(device.associationId ? { associationId: device.associationId } : {}),
        };
        try {
          const history = await fetchLicenseHistory(api, id, selection.scope);
          if (selected.current === selection) setDetail({ kind: 'ready', license, history });
        } catch (historyError) {
          if (historyError instanceof ApiClientError && [403, 404, 409].includes(historyError.status))
            throw historyError;
          if (selected.current === selection) setDetail({ kind: 'ready', license, history: [], historyError });
        }
      } catch (error) {
        if (selected.current === selection) setDetail({ kind: 'error', error });
      }
    },
    [api, resolved, scope],
  );
  useEffect(() => {
    void loadList();
    return () => {
      latestList.current += 1;
    };
  }, [loadList]);
  useEffect(() => {
    selected.current = null;
    if (linkedId && resolved) void loadDetail(linkedId);
    else setDetail({ kind: 'none' });
    return () => {
      selected.current = null;
    };
  }, [linkedId, loadDetail, resolved]);
  const writeContext = (id: string): [LicenseScope, number] => {
    const target = selected.current;
    if (target?.id !== id || !target.scope || detail.kind !== 'ready' || detail.license.licenseId !== id) {
      throw deviceScopeMismatch();
    }
    return [target.scope, detail.license.version];
  };
  const refresh = () => {
    void loadList();
    if (linkedId && resolved) void loadDetail(linkedId);
  };
  return (
    <LicensesPage
      key={JSON.stringify([scopeKey, linkedId])}
      role={roleOf(session)}
      scopeLabel={
        contractId
          ? translate('cmpT07.contractScope', { id: contractId })
          : resolved?.devices[0]
            ? translate('deviceWorkbench.scope', { name: resolved.devices[0].label, id: resolved.devices[0].deviceId })
            : ''
      }
      list={list}
      appliedFilter={filter}
      onApplyFilter={setFilter}
      onLoadMore={(cursor) => void loadList(cursor)}
      onRefresh={refresh}
      detail={detail}
      onSelect={(id) => onNavigate(pathFor(id))}
      onCloseDetail={() => {
        selected.current = null;
        setDetail({ kind: 'none' });
        onNavigate(pathFor());
      }}
      createCandidates={resolved?.devices.filter((d) => d.canCreate) ?? []}
      onCreate={(input) => {
        const target = resolved?.devices.find((device) => device.deviceId === input.deviceId && device.canCreate);
        if (!target) throw deviceScopeMismatch();
        return createLicense(api, input, {
          ...scope,
          deviceId: target.deviceId,
          ...(target.associationId ? { associationId: target.associationId } : {}),
        });
      }}
      onIssue={(id) => issueLicense(api, id, ...writeContext(id))}
      onActivate={(id) => activateLicense(api, id, ...writeContext(id))}
      onRenew={(id, validTo) => renewLicense(api, id, validTo, ...writeContext(id))}
      onRevoke={(id, reason) => revokeLicense(api, id, reason, ...writeContext(id))}
    />
  );
}
export function ConfigurationsController({
  api,
  session,
  device,
}: {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
  readonly device?: DeviceView;
}) {
  const [filter, setFilter] = useState<ConfigurationFilter>(EMPTY_CONFIGURATION_FILTER);
  const targetDeviceId = device?.id;
  const [list, setList] = useState<{
    rows: readonly ConfigurationSummaryView[] | null;
    error?: unknown;
  }>({
    rows: null,
  });
  const [detail, setDetail] = useState<ConfigurationDetailState>({ kind: 'none' });
  const selected = useRef<{ id: string } | null>(null);
  const latestList = useRef(0);
  const latestSync = useRef(new Map<number, object>());
  const loadEffectiveDevices = useCallback(
    (id: string, cursor: string | null) => fetchEffectiveConfigurationDevices(api, id, cursor),
    [api],
  );
  const loadList = useCallback(
    async (preserveRows = false) => {
      const request = ++latestList.current;
      setList((current) => ({ rows: preserveRows ? current.rows : null }));
      try {
        const rows = await fetchConfigurations(api, {
          ...(targetDeviceId !== undefined
            ? { targetDeviceId }
            : {
                ...(filter.targetModel ? { targetModel: filter.targetModel } : {}),
                ...(filter.targetDeviceId ? { targetDeviceId: filter.targetDeviceId } : {}),
              }),
        });
        if (targetDeviceId !== undefined && rows.some((row) => row.targetDeviceId !== targetDeviceId)) {
          throw deviceScopeMismatch();
        }
        if (request === latestList.current) setList({ rows });
      } catch (error) {
        if (request === latestList.current) setList((current) => ({ rows: current.rows ?? [], error }));
      }
    },
    [api, filter, targetDeviceId],
  );
  const loadDetail = useCallback(
    async (id: string, preserveDetail = false) => {
      const request = { id };
      selected.current = request;
      latestSync.current.clear();
      setDetail((current) =>
        preserveDetail && current.kind === 'ready' && current.detail.configurationId === id
          ? { ...current, refreshing: true }
          : { kind: 'loading' },
      );
      try {
        const next = await fetchConfiguration(api, id);
        if (next.configurationId !== id || (targetDeviceId !== undefined && next.targetDeviceId !== targetDeviceId)) {
          throw deviceScopeMismatch();
        }
        if (selected.current === request) setDetail({ kind: 'ready', detail: next, sync: {} });
      } catch (error) {
        if (selected.current === request) setDetail({ kind: 'error', error });
      }
    },
    [api, targetDeviceId],
  );
  useEffect(() => {
    void loadList();
  }, [loadList]);
  const refresh = () => {
    void loadList(true);
    if (selected.current !== null) void loadDetail(selected.current.id, true);
  };
  return (
    <ConfigurationsPage
      role={roleOf(session)}
      {...(device !== undefined ? { device } : {})}
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
      onLoadEffectiveDevices={loadEffectiveDevices}
      onLoadSyncStatus={(version) => {
        const selection = selected.current;
        if (selection === null) return;
        const request = {};
        latestSync.current.set(version, request);
        const finish = (status: NonNullable<Extract<ConfigurationDetailState, { kind: 'ready' }>['sync'][number]>) => {
          if (selected.current !== selection || latestSync.current.get(version) !== request) return;
          setDetail((old) => (old.kind === 'ready' ? { ...old, sync: { ...old.sync, [version]: status } } : old));
        };
        finish({ kind: 'loading', version });
        void fetchConfigurationVersionStatus(api, selection.id, version).then(
          (data) => finish({ kind: 'ready', data }),
          (error: unknown) => finish({ kind: 'error', version, error }),
        );
      }}
      onCreate={({ targetModel, ...input }) =>
        createConfiguration(
          api,
          targetDeviceId === undefined
            ? { ...input, ...(targetModel !== undefined ? { targetModel } : {}) }
            : { ...input, targetDeviceId },
        )
      }
      onCreateVersion={(id, input) => createConfigurationVersion(api, id, input)}
      onPublish={(id, version, input) => publishConfigurationVersion(api, id, version, input)}
    />
  );
}
export function DeviceUsersController({
  api,
  session,
  device,
  linkedUserId,
}: {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
  readonly device: DeviceView;
  readonly linkedUserId: string | null;
}) {
  const customerId = device.customer?.id;
  const [filter, setFilter] = useState<DeviceUserFilter>(EMPTY_DEVICE_USER_FILTER);
  const [list, setList] = useState<{
    rows: readonly DeviceUserListItemView[] | null;
    error?: unknown;
  }>({ rows: null });
  const { detail, openDetail, closeDetail, refreshDetail } = useDeviceUserDetail(api, device.id, customerId);
  const latestList = useRef(0);
  const loadList = useCallback(async () => {
    const request = ++latestList.current;
    setList({ rows: null });
    try {
      if (!customerId) throw deviceScopeMismatch();
      const rows = await fetchDeviceUsers(api, {
        scopeDeviceId: device.id,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.keyword ? { keyword: filter.keyword } : {}),
      });
      if (rows.some((row) => row.customerId !== customerId || row.activeDeviceCount !== 1)) throw deviceScopeMismatch();
      if (request === latestList.current) setList({ rows });
    } catch (error) {
      if (request === latestList.current) setList({ rows: [], error });
    }
  }, [api, customerId, device.id, filter]);
  useEffect(() => {
    void loadList();
    return () => {
      latestList.current += 1;
    };
  }, [loadList]);
  useEffect(() => {
    if (linkedUserId && customerId) void openDetail(linkedUserId);
  }, [customerId, linkedUserId, openDetail]);
  const versionFor = (id: string) => {
    if (detail.kind !== 'ready' || detail.detail.deviceUserId !== id) throw new Error(translate('ui.70dfcb6f13f4'));
    return detail.detail.version;
  };
  return (
    <DeviceUsersPage
      role={roleOf(session)}
      scopeDevice={device}
      fixedCustomerId={customerId ?? null}
      customerOptions={device.customer ? [option(device.customer.id, device.customer.name)] : []}
      topologyOptions={[]}
      list={list}
      appliedFilter={filter}
      onApplyFilter={setFilter}
      onRefresh={() => {
        void loadList();
        refreshDetail();
      }}
      onRefreshDetail={refreshDetail}
      detail={detail}
      onSelect={(id) => void openDetail(id)}
      onCloseDetail={closeDetail}
      assignableDevices={[]}
      onCreate={(input) => createDeviceUser(api, input, device.id)}
      onUpdate={(id, input) => updateDeviceUser(api, id, versionFor(id), input, device.id)}
      onDisable={(id, reason) => disableDeviceUser(api, id, versionFor(id), reason, device.id)}
      onAssign={(id, ids, reason) => assignDeviceUser(api, id, versionFor(id), ids, reason, device.id)}
      onRevoke={async (id, ids, reason) => {
        const result = await revokeDeviceUser(api, id, versionFor(id), ids, reason, device.id);
        closeDetail();
        return result;
      }}
      onListEligible={async () => {
        const rows = await fetchDeviceUsers(api, { scopeDeviceId: device.id, eligible: true });
        if (rows.some((row) => row.customerId !== customerId || row.activeDeviceCount !== 0 || row.status !== 'ACTIVE'))
          throw deviceScopeMismatch();
        return rows;
      }}
      onAssignEligible={(user, reason) =>
        assignDeviceUser(api, user.deviceUserId, user.version, [device.id], reason, device.id)
      }
    />
  );
}
type AlarmsControllerProps = {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
  readonly search: string;
  readonly onNavigate: Navigate;
  readonly device?: DeviceView;
};
export function AlarmsController(props: AlarmsControllerProps) {
  const { session } = props;
  return <AlarmsInstance key={`${session.username}:${session.customerId}:${session.roles.join(',')}`} {...props} />;
}
function AlarmsInstance({ api, session, search, onNavigate, device }: AlarmsControllerProps) {
  const parsed = useMemo(() => {
    const params = new URLSearchParams(search);
    const filterDeviceId = params.get('filterDeviceId');
    if (filterDeviceId !== null) params.set('deviceId', filterDeviceId);
    return urlStateFromSearch(params.toString());
  }, [search]);
  const deviceId = device?.id;
  const customerId = session.customerId;
  const groupSearch = groupFiltersFromContext(search);
  const urlState = useMemo<AlarmPageUrlState>(() => {
    if (deviceId === undefined && customerId === null) return parsed;
    const scope = deviceId === undefined ? { customerId } : { customerId, siteId: null, deviceId };
    return {
      ...parsed,
      alarm: { ...parsed.alarm, ...scope },
      event: { ...parsed.event, ...scope },
      tamper: { ...parsed.tamper, ...scope },
    };
  }, [parsed, customerId, deviceId]);
  const stateSearch = useCallback(
    (state: AlarmPageUrlState) => {
      const params = new URLSearchParams(urlStateToSearch(state));
      if (deviceId === undefined) {
        const filterDeviceId = params.get('deviceId');
        if (filterDeviceId !== null) {
          params.delete('deviceId');
          params.set('filterDeviceId', filterDeviceId);
        }
        return `?${params}`;
      }

      for (const key of ['deviceId', 'customerId', 'siteId']) params.delete(key);
      params.set('scopeDeviceId', deviceId);
      return withGroupFilters(`/alarms?${params}`, groupSearch).slice('/alarms'.length);
    },
    [deviceId, groupSearch],
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
  const detailGeneration = useRef(0);
  const listGeneration = useRef({ alarm: 0, event: 0, tamper: 0 });
  const requestEvidence = useCallback(
    (id: string, signal?: AbortSignal) => createMediaDownloadUrl(api, id, signal),
    [api],
  );
  const load = useCallback(
    async (tab: AlarmTab, cursor?: string) => {
      const generation = ++listGeneration.current[tab];
      if (tab === 'alarm') setAlarms((old) => ({ ...old, loading: true, error: undefined }));
      else if (tab === 'event') setEvents((old) => ({ ...old, loading: true, error: undefined }));
      else setTampers((old) => ({ ...old, loading: true, error: undefined }));
      try {
        if (tab === 'alarm') {
          const page = await fetchAlarms(api, urlState.alarm, cursor);
          if (generation !== listGeneration.current[tab]) return;
          if (deviceId !== undefined && page.rows.some((row) => row.deviceId !== deviceId)) throw deviceScopeMismatch();
          setAlarms({ rows: page.rows, loading: false, nextCursor: page.nextCursor });
        } else if (tab === 'event') {
          const page = await fetchDeviceEvents(api, urlState.event, cursor);
          if (generation !== listGeneration.current[tab]) return;
          if (deviceId !== undefined && page.rows.some((row) => row.deviceId !== deviceId)) throw deviceScopeMismatch();
          setEvents({ rows: page.rows, loading: false, nextCursor: page.nextCursor });
        } else {
          const page = await fetchTamperEvents(api, urlState.tamper, cursor);
          if (generation !== listGeneration.current[tab]) return;
          if (deviceId !== undefined && page.rows.some((row) => row.deviceId !== deviceId)) throw deviceScopeMismatch();
          setTampers({ rows: page.rows, loading: false, nextCursor: page.nextCursor });
        }
      } catch (error) {
        if (generation !== listGeneration.current[tab]) return;
        if (tab === 'alarm') setAlarms((old) => ({ ...old, loading: false, error }));
        else if (tab === 'event') setEvents((old) => ({ ...old, loading: false, error }));
        else setTampers((old) => ({ ...old, loading: false, error }));
      }
    },
    [api, deviceId, urlState],
  );
  const loadDetail = useCallback(
    async (id: string) => {
      const generation = ++detailGeneration.current;
      selected.current = id;
      setDetail({ kind: 'loading' });
      try {
        const alarm = await fetchAlarm(api, id);
        if (alarm.alarmId !== id || (deviceId !== undefined && alarm.deviceId !== deviceId))
          throw deviceScopeMismatch();
        if (selected.current === id && generation === detailGeneration.current) setDetail({ kind: 'ready', alarm });
      } catch (error) {
        if (selected.current === id && generation === detailGeneration.current) setDetail({ kind: 'error', error });
      }
    },
    [api, deviceId],
  );
  useEffect(() => {
    selected.current = null;
    ++detailGeneration.current;
    setDetail({ kind: 'none' });
    void load(urlState.tab);
    return () => {
      ++detailGeneration.current;
      ++listGeneration.current[urlState.tab];
      selected.current = null;
    };
  }, [load, urlState.tab]);
  useEffect(() => {
    if (deviceId !== undefined) return;
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
  }, [api, deviceId, session.customerId]);
  const apply = (next: AlarmPageUrlState) => {
    const nextSearch = stateSearch(next);
    if (nextSearch === stateSearch(urlState)) {
      void load(next.tab);
    } else {
      onNavigate(`/alarms${nextSearch}`);
    }
  };
  const refresh = () => {
    void load(urlState.tab);
    if (selected.current !== null) void loadDetail(selected.current);
  };
  return (
    <AlarmsPage
      key={search}
      role={roleOf(session)}
      canReadEvidence={session.roles.some((role) => hasPermission(role, 'media:read'))}
      onRequestEvidenceUrl={requestEvidence}
      isCustomerRole={session.customerId !== null}
      customerOptions={customerOptions}
      siteOptions={alarmSiteOptions}
      deviceOptions={alarmDeviceOptions}
      {...(device ? { device } : {})}
      urlState={urlState}
      serializeSearch={stateSearch}
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
