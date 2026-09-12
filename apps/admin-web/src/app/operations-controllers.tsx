import { translate } from '../i18n/i18n.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import type { ApiClient } from '../api/http-client.js';
import { useUserTimeZone } from '../components/TimeText.js';
import type { FilterOption } from '../components/ScopeFilter.js';
import { fetchCustomers } from '../pages/customers/customers-api.js';
import {
  createActivityExport,
  createDeviceCommand,
  fetchActivityExport,
  fetchCommand,
  fetchCommands,
  fetchDeviceActivities,
} from '../pages/device-operate/commands-api.js';
import type { ActivityListFilter, CommandListFilter } from '../pages/device-operate/commands-api.js';
import { DeviceOperatePage } from '../pages/device-operate/DeviceOperatePage.js';
import type { CommandDetailState, ListState } from '../pages/device-operate/DeviceOperatePage.js';
import type { ActivityExportView, ActivityItemView, CommandListItemView } from '../pages/device-operate/types.js';
import { fetchDevice, fetchDeviceConsole, fetchDevices } from '../pages/devices/devices-api.js';
import type { DeviceView, LatestMediaView } from '../pages/devices/types.js';
import {
  createEsgExport,
  fetchEsgCalculationVersions,
  fetchEsgDailySummary,
  fetchEsgExport,
  fetchEsgReports,
} from '../pages/esg/esg-api.js';
import { EsgDevicesPage } from '../pages/esg/EsgDevicesPage.js';
import type { EsgDeviceAppliedQuery } from '../pages/esg/EsgDevicesPage.js';
import { EsgOverviewPage } from '../pages/esg/EsgOverviewPage.js';
import type { EsgAppliedQuery } from '../pages/esg/EsgOverviewPage.js';
import type { EsgPeriod } from '../pages/esg/esg-state.js';
import type {
  EsgCalculationVersionView,
  EsgDailySummaryView,
  EsgExportJobView,
  EsgReportView,
} from '../pages/esg/types.js';
import { listMedia, createMediaDownloadUrl } from '../pages/media/media-api.js';
import type { MediaListFilter } from '../pages/media/media-api.js';
import { MediaPage } from '../pages/media/MediaPage.js';
import type { MediaListState } from '../pages/media/types.js';
import {
  cancelOtaCampaign,
  completeFirmwareUpload,
  createFirmwareUpload,
  createOtaCampaign,
  expandOtaCampaignBatch,
  getOtaCampaign,
  listFirmwarePackages,
  listOtaCampaigns,
  listOtaTargets,
  pauseOtaCampaign,
  resumeOtaCampaign,
  retryOtaCampaignFailures,
} from '../pages/ota/ota-api.js';
import type { CampaignListFilter, PackageListFilter, TargetListFilter } from '../pages/ota/ota-api.js';
import { OtaCampaignsPage } from '../pages/ota/OtaCampaignsPage.js';
import type { CampaignDetailState, EligibleDeviceOption } from '../pages/ota/OtaCampaignsPage.js';
import { OtaPackagesPage } from '../pages/ota/OtaPackagesPage.js';
import type { FirmwarePackageView, OtaCampaignView, OtaListState } from '../pages/ota/types.js';
import { fetchSites } from '../pages/sites/sites-api.js';
import type { SiteView } from '../pages/sites/types.js';
import { getAuditLogDetail, listAuditLogs } from '../pages/audit/audit-api.js';
import type { AuditLogListFilter } from '../pages/audit/audit-api.js';
import { AuditLogsPage } from '../pages/audit/AuditLogsPage.js';
import type { AuditDetailState, AuditLogListState } from '../pages/audit/types.js';
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
function option(value: string, label: string): FilterOption {
  return { value, label };
}
export async function collectAllPages<T>(
  load: (cursor?: string) => Promise<{
    readonly rows: readonly T[];
    readonly nextCursor: string | null;
  }>,
) {
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await load(cursor);
    rows.push(...page.rows);
    if (page.nextCursor === null || seen.has(page.nextCursor)) return rows;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
async function topology(api: ApiClient) {
  const [devices, sites] = await Promise.all([
    collectAllPages(async (cursor) => {
      const page = await fetchDevices(api, undefined, { cursor: cursor ?? null, limit: 100 });
      return { rows: page.items, nextCursor: page.nextCursor };
    }),
    collectAllPages(async (cursor) => {
      const page = await fetchSites(api, undefined, { cursor: cursor ?? null, limit: 100 });
      return { rows: page.items, nextCursor: page.nextCursor };
    }),
  ]);
  return { devices, sites };
}
function scopeOptions(devices: readonly DeviceView[], sites: readonly SiteView[]) {
  const regions = [...new Set(sites.flatMap((site) => (site.region ? [site.region] : [])))];
  const regionPairs = [
    ...new Set(sites.flatMap((site) => (site.region && site.subregion ? [`${site.region}\0${site.subregion}`] : []))),
  ];
  return {
    regions: regions.map((value) => option(value, value)),
    subregions: regionPairs.map((value) => {
      const [region = '', subregion = ''] = value.split('\0');
      return { ...option(subregion, subregion), region };
    }),
    sites: sites.map((site) => ({ ...option(site.id, site.name), subregion: site.subregion ?? '' })),
    devices: devices.map((device) => ({
      ...option(device.id, device.alias ?? device.serialNumber),
      siteId: device.site?.id ?? '',
    })),
  };
}
export function EsgOverviewController({
  api,
  session,
}: {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
}) {
  const role = roleOf(session);
  const { timeZone } = useUserTimeZone();
  const [period, setPeriod] = useState<EsgPeriod>('day');
  const [applied, setApplied] = useState<EsgAppliedQuery>({ customerId: session.customerId, from: null, to: null });
  const [rows, setRows] = useState<readonly EsgDailySummaryView[] | null>(null);
  const [versions, setVersions] = useState<readonly EsgCalculationVersionView[] | null>(null);
  const [customers, setCustomers] = useState<readonly FilterOption[]>([]);
  const [exportJob, setExportJob] = useState<EsgExportJobView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const load = useCallback(
    async (query: EsgAppliedQuery) => {
      setLoading(true);
      setError(undefined);
      try {
        const [nextRows, nextVersions] = await Promise.all([
          collectAllPages((cursor) => fetchEsgDailySummary(api, query, cursor)),
          fetchEsgCalculationVersions(api),
        ]);
        setRows(nextRows);
        setVersions(nextVersions);
      } catch (nextError) {
        setRows([]);
        setError(nextError);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );
  useEffect(() => {
    void load(applied);
  }, [applied, load]);
  useEffect(() => {
    if (session.customerId === null)
      void fetchCustomers(api, { limit: 100 }).then(
        (p) => setCustomers(p.items.map((c) => option(c.id, c.name))),
        () => setCustomers([]),
      );
  }, [api, session.customerId]);
  return (
    <EsgOverviewPage
      role={role}
      timeZone={timeZone}
      isCustomerRole={session.customerId !== null}
      customerOptions={customers}
      period={period}
      onPeriodChange={setPeriod}
      appliedQuery={applied}
      onApply={setApplied}
      rows={rows}
      loading={loading}
      listError={error}
      versions={versions}
      exportJob={exportJob}
      onExport={async (input) => {
        const job = await createEsgExport(api, input);
        setExportJob(job);
        return job;
      }}
      onCheckExport={(id) => void fetchEsgExport(api, id).then(setExportJob)}
      onRefresh={() => void load(applied)}
    />
  );
}
export function EsgDevicesController({ api, session }: { readonly api: ApiClient; readonly session: SessionSnapshot }) {
  const { timeZone } = useUserTimeZone();
  const [period, setPeriod] = useState<EsgPeriod>('day');
  const [applied, setApplied] = useState<EsgDeviceAppliedQuery>({
    scope: { region: null, subregion: null, siteId: null, deviceId: null },
    from: null,
    to: null,
  });
  const [devices, setDevices] = useState<readonly DeviceView[]>([]);
  const [sites, setSites] = useState<readonly SiteView[]>([]);
  const [rows, setRows] = useState<readonly EsgReportView[] | null>(null);
  const [versions, setVersions] = useState<readonly EsgCalculationVersionView[] | null>(null);
  const [exportJob, setExportJob] = useState<EsgExportJobView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const load = useCallback(
    async (query: EsgDeviceAppliedQuery) => {
      setLoading(true);
      setError(undefined);
      try {
        const [nextRows, nextVersions] = await Promise.all([
          collectAllPages((cursor) =>
            fetchEsgReports(
              api,
              {
                siteId: query.scope.siteId,
                deviceId: query.scope.deviceId ?? null,
                from: query.from,
                to: query.to,
                reportType: 'DAILY',
              },
              cursor,
            ),
          ),
          fetchEsgCalculationVersions(api),
        ]);
        setRows(nextRows);
        setVersions(nextVersions);
      } catch (nextError) {
        setRows([]);
        setError(nextError);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );
  useEffect(() => {
    void topology(api).then((value) => {
      setDevices(value.devices);
      setSites(value.sites);
    }, setError);
  }, [api]);
  useEffect(() => {
    void load(applied);
  }, [applied, load]);
  const options = useMemo(() => scopeOptions(devices, sites), [devices, sites]);
  const deviceScope = useMemo(
    () =>
      Object.fromEntries(
        devices.flatMap((device) =>
          device.site?.region && device.site.subregion
            ? [[device.id, { region: device.site.region, subregion: device.site.subregion }]]
            : [],
        ),
      ),
    [devices],
  );
  return (
    <EsgDevicesPage
      role={roleOf(session)}
      timeZone={timeZone}
      period={period}
      onPeriodChange={setPeriod}
      scopeOptions={options}
      deviceScope={deviceScope}
      applied={applied}
      onApply={setApplied}
      rows={rows}
      loading={loading}
      listError={error}
      versions={versions}
      exportJob={exportJob}
      onExport={async (input) => {
        const job = await createEsgExport(api, input);
        setExportJob(job);
        return job;
      }}
      onCheckExport={(id) => void fetchEsgExport(api, id).then(setExportJob)}
      onRefresh={() => void load(applied)}
    />
  );
}
export function DeviceOperateController({
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
  const initial = new URLSearchParams(search).get('deviceId');
  const [devices, setDevices] = useState<readonly DeviceView[]>([]);
  const [sites, setSites] = useState<readonly SiteView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initial);
  const [selected, setSelected] = useState<DeviceView | null>(null);
  const [media, setMedia] = useState<LatestMediaView | null>(null);
  const [commandFilter, setCommandFilter] = useState<CommandListFilter>({ deviceId: initial });
  const [commands, setCommands] = useState<ListState<CommandListItemView>>({ rows: null, loading: true });
  const [commandDetail, setCommandDetail] = useState<CommandDetailState>({ kind: 'none' });
  const [activityFilter, setActivityFilter] = useState<ActivityListFilter>({});
  const [activities, setActivities] = useState<ListState<ActivityItemView>>({ rows: null });
  const [activityExport, setActivityExport] = useState<ActivityExportView | null>(null);
  const load = useCallback(
    async (deviceId: string | null, nextCommandFilter = commandFilter, nextActivityFilter = activityFilter) => {
      if (deviceId === null) {
        setSelected(null);
        setMedia(null);
        setCommands({ rows: [] });
        setActivities({ rows: [] });
        return;
      }
      setCommands({ rows: null, loading: true });
      setActivities({ rows: null, loading: true });
      const results = await Promise.allSettled([
        fetchDevice(api, deviceId),
        fetchDeviceConsole(api, deviceId),
        fetchCommands(api, { ...nextCommandFilter, deviceId }),
        fetchDeviceActivities(api, deviceId, nextActivityFilter),
      ]);
      if (results[0].status === 'fulfilled') setSelected(results[0].value);
      if (results[1].status === 'fulfilled') setMedia(results[1].value.latestMedia);
      setCommands(
        results[2].status === 'fulfilled'
          ? { rows: results[2].value.rows, nextCursor: results[2].value.nextCursor }
          : { rows: [], error: results[2].reason },
      );
      setActivities(
        results[3].status === 'fulfilled'
          ? { rows: results[3].value.rows, nextCursor: results[3].value.nextCursor }
          : { rows: [], error: results[3].reason },
      );
    },
    [activityFilter, api, commandFilter],
  );
  useEffect(() => {
    void topology(api).then((value) => {
      setDevices(value.devices);
      setSites(value.sites);
    });
  }, [api]);
  useEffect(() => {
    void load(selectedId);
  }, [load, selectedId]);
  const options = useMemo(() => scopeOptions(devices, sites), [devices, sites]);
  const select = (id: string | null) => {
    setSelectedId(id);
    setCommandFilter((old) => ({ ...old, deviceId: id }));
    onNavigate(id ? `/devices/operate?deviceId=${encodeURIComponent(id)}` : '/devices/operate', { replace: true });
  };
  return (
    <DeviceOperatePage
      role={roleOf(session)}
      scopeOptions={options}
      selectedDeviceId={selectedId}
      onSelectDevice={select}
      selectedDevice={selected}
      onSubmitCommand={async (id, input) => {
        const result = await createDeviceCommand(api, id, input);
        await load(id);
        return result;
      }}
      commands={commands}
      commandFilter={commandFilter}
      onApplyCommandFilter={(filter) => {
        setCommandFilter(filter);
        void load(selectedId, filter, activityFilter);
      }}
      onLoadMoreCommands={(cursor) =>
        void fetchCommands(api, { ...commandFilter, deviceId: selectedId }, cursor).then((page) =>
          setCommands((old) => ({ rows: [...(old.rows ?? []), ...page.rows], nextCursor: page.nextCursor })),
        )
      }
      commandDetail={commandDetail}
      onSelectCommand={(id) => {
        setCommandDetail({ kind: 'loading' });
        void fetchCommand(api, id).then(
          (command) => setCommandDetail({ kind: 'ready', command }),
          (error: unknown) => setCommandDetail({ kind: 'error', error }),
        );
      }}
      onCloseCommandDetail={() => setCommandDetail({ kind: 'none' })}
      activities={activities}
      activityFilter={activityFilter}
      onApplyActivityFilter={(filter) => {
        setActivityFilter(filter);
        void load(selectedId, commandFilter, filter);
      }}
      onLoadMoreActivities={(cursor) => {
        if (selectedId)
          void fetchDeviceActivities(api, selectedId, activityFilter, cursor).then((page) =>
            setActivities((old) => ({ rows: [...(old.rows ?? []), ...page.rows], nextCursor: page.nextCursor })),
          );
      }}
      activityExport={activityExport}
      onExportActivities={async (filter) => {
        if (!selectedId) throw new Error(translate('ui.7b372e6a09a3'));
        const job = await createActivityExport(api, selectedId, filter);
        setActivityExport(job);
        return job;
      }}
      onCheckActivityExport={(id) => void fetchActivityExport(api, id).then(setActivityExport)}
      latestMedia={media}
      onRefreshMedia={() => void load(selectedId)}
      onNavigate={onNavigate}
      onRefresh={() => void load(selectedId)}
    />
  );
}
export function OtaPackagesController({
  api,
  session,
  onNavigate,
}: {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
  readonly onNavigate: Navigate;
}) {
  const [filter, setFilter] = useState<PackageListFilter>({});
  const [packages, setPackages] = useState<OtaListState<FirmwarePackageView>>({ rows: null, loading: true });
  const load = useCallback(
    async (next = filter) => {
      setPackages({ rows: null, loading: true });
      try {
        const page = await listFirmwarePackages(api, next);
        setPackages({ rows: page.rows, nextCursor: page.nextCursor });
      } catch (error) {
        setPackages({ rows: [], error });
      }
    },
    [api, filter],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <OtaPackagesPage
      role={roleOf(session)}
      packages={packages}
      filter={filter}
      onApplyFilter={(next) => {
        setFilter(next);
        void load(next);
      }}
      onLoadMore={(cursor) =>
        void listFirmwarePackages(api, filter, cursor).then((page) =>
          setPackages((old) => ({ rows: [...(old.rows ?? []), ...page.rows], nextCursor: page.nextCursor })),
        )
      }
      onCreateUploadSession={(input) => createFirmwareUpload(api, input)}
      onUploadAndComplete={async (upload, file) => {
        if (file.size !== upload.sizeBytes) throw new Error(translate('ui.b4f86a353327'));
        const response = await fetch(upload.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        });
        if (!response.ok) throw new Error(translate('ui.e980062592b3') + ' ' + response.status + '\uFF09');
        const result = await completeFirmwareUpload(api, upload.packageId);
        await load();
        return result;
      }}
      onRefresh={() => void load()}
      onNavigate={onNavigate}
    />
  );
}
export function OtaCampaignsController({
  api,
  session,
  onNavigate,
}: {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
  readonly onNavigate: Navigate;
}) {
  const [filter, setFilter] = useState<CampaignListFilter>({});
  const [campaigns, setCampaigns] = useState<OtaListState<OtaCampaignView>>({ rows: null, loading: true });
  const [detail, setDetail] = useState<CampaignDetailState>({ kind: 'none' });
  const [targetFilter, setTargetFilter] = useState<TargetListFilter>({});
  const [packages, setPackages] = useState<readonly FirmwarePackageView[]>([]);
  const [eligible, setEligible] = useState<readonly EligibleDeviceOption[]>([]);
  const load = useCallback(
    async (next = filter) => {
      setCampaigns({ rows: null, loading: true });
      try {
        const page = await listOtaCampaigns(api, next);
        setCampaigns({ rows: page.rows, nextCursor: page.nextCursor });
      } catch (error) {
        setCampaigns({ rows: [], error });
      }
    },
    [api, filter],
  );
  const select = useCallback(
    async (id: string, targets = targetFilter) => {
      setDetail({ kind: 'loading' });
      try {
        const [campaign, page] = await Promise.all([getOtaCampaign(api, id), listOtaTargets(api, id, targets)]);
        setDetail({ kind: 'ready', campaign, targets: { rows: page.rows, nextCursor: page.nextCursor } });
      } catch (error) {
        setDetail({ kind: 'error', error });
      }
    },
    [api, targetFilter],
  );
  useEffect(() => {
    void load();
    void Promise.all([
      collectAllPages((cursor) => listFirmwarePackages(api, { status: 'VERIFIED' }, cursor)),
      topology(api),
    ]).then(([verified, top]) => {
      setPackages(verified);
      setEligible(
        top.devices
          .filter(
            (d) =>
              ['Active', 'Maintenance'].includes(d.operationalStatus ?? '') &&
              (d.license?.entitlements.includes('OTA_UPDATE') || d.license?.entitlements.includes('OTA')),
          )
          .map((d) => ({ deviceId: d.id, label: d.alias ?? d.serialNumber })),
      );
    });
  }, [api, load]);
  const refreshDetail = async () => {
    if (detail.kind === 'ready') await select(detail.campaign.campaignId);
  };
  return (
    <OtaCampaignsPage
      role={roleOf(session)}
      campaigns={campaigns}
      filter={filter}
      onApplyFilter={(next) => {
        setFilter(next);
        void load(next);
      }}
      onLoadMore={(cursor) =>
        void listOtaCampaigns(api, filter, cursor).then((page) =>
          setCampaigns((old) => ({ rows: [...(old.rows ?? []), ...page.rows], nextCursor: page.nextCursor })),
        )
      }
      detail={detail}
      onSelectCampaign={(id) => void select(id)}
      onCloseDetail={() => setDetail({ kind: 'none' })}
      onLoadMoreTargets={(cursor) => {
        if (detail.kind === 'ready')
          void listOtaTargets(api, detail.campaign.campaignId, targetFilter, cursor).then((page) =>
            setDetail((old) =>
              old.kind === 'ready'
                ? {
                    ...old,
                    targets: { rows: [...(old.targets.rows ?? []), ...page.rows], nextCursor: page.nextCursor },
                  }
                : old,
            ),
          );
      }}
      onApplyTargetFilter={(next) => {
        setTargetFilter(next);
        if (detail.kind === 'ready') void select(detail.campaign.campaignId, next);
      }}
      verifiedPackages={packages}
      eligibleDevices={eligible}
      onCreateCampaign={async (input) => {
        const result = await createOtaCampaign(api, input);
        await load();
        return result;
      }}
      onExpandBatch={async (...args) => {
        const result = await expandOtaCampaignBatch(api, ...args);
        await refreshDetail();
        return result;
      }}
      onPause={async (id) => {
        const result = await pauseOtaCampaign(api, id);
        await load();
        await select(id);
        return result;
      }}
      onResume={async (id) => {
        const result = await resumeOtaCampaign(api, id);
        await load();
        await select(id);
        return result;
      }}
      onCancel={async (id) => {
        const result = await cancelOtaCampaign(api, id);
        await load();
        await select(id);
        return result;
      }}
      onRetry={async (id, ids) => {
        const result = await retryOtaCampaignFailures(api, id, ids);
        await refreshDetail();
        return result;
      }}
      onNavigate={onNavigate}
      onRefresh={() => void load()}
    />
  );
}
export function MediaController({ api, session }: { readonly api: ApiClient; readonly session: SessionSnapshot }) {
  const [filter, setFilter] = useState<MediaListFilter>({});
  const [media, setMedia] = useState<MediaListState>({ rows: null, loading: true });
  const load = useCallback(
    async (next = filter) => {
      setMedia({ rows: null, loading: true });
      try {
        const page = await listMedia(api, next);
        setMedia({ rows: page.rows, nextCursor: page.nextCursor });
      } catch (error) {
        setMedia({ rows: [], error });
      }
    },
    [api, filter],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <MediaPage
      role={roleOf(session)}
      media={media}
      filter={filter}
      onApplyFilter={(next) => {
        setFilter(next);
        void load(next);
      }}
      onLoadMore={(cursor) =>
        void listMedia(api, filter, cursor).then((page) =>
          setMedia((old) => ({ rows: [...(old.rows ?? []), ...page.rows], nextCursor: page.nextCursor })),
        )
      }
      onRefresh={() => void load()}
      onRequestDownloadUrl={(id) => createMediaDownloadUrl(api, id)}
    />
  );
}
export function AuditLogsController({ api, session }: { readonly api: ApiClient; readonly session: SessionSnapshot }) {
  const [filter, setFilter] = useState<AuditLogListFilter>({});
  const [logs, setLogs] = useState<AuditLogListState>({ rows: null, loading: true });
  const [detail, setDetail] = useState<AuditDetailState>({ kind: 'none' });
  const load = useCallback(
    async (next = filter) => {
      setLogs({ rows: null, loading: true });
      try {
        const page = await listAuditLogs(api, next);
        setLogs({ rows: page.rows, nextCursor: page.nextCursor });
      } catch (error) {
        setLogs({ rows: [], error });
      }
    },
    [api, filter],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <AuditLogsPage
      role={roleOf(session)}
      logs={logs}
      filter={filter}
      onApplyFilter={(next) => {
        setFilter(next);
        void load(next);
      }}
      onLoadMore={(cursor) =>
        void listAuditLogs(api, filter, cursor).then((page) =>
          setLogs((old) => ({ rows: [...(old.rows ?? []), ...page.rows], nextCursor: page.nextCursor })),
        )
      }
      detail={detail}
      onSelectLog={(id) => {
        setDetail({ kind: 'loading' });
        void getAuditLogDetail(api, id).then(
          (nextDetail) => setDetail({ kind: 'ready', detail: nextDetail }),
          (error: unknown) => setDetail({ kind: 'error', error }),
        );
      }}
      onCloseDetail={() => setDetail({ kind: 'none' })}
      onRefresh={() => void load()}
    />
  );
}
