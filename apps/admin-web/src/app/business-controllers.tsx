import { translate } from '../i18n/i18n.js';
import type { Role } from '@fdp/auth/browser';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../api/http-client.js';
import {
  activateContract,
  bindContractDevices,
  createContract,
  getContract,
  listAvailableDevices,
  listContractAssociations,
  listContractDevices,
  listContracts,
  renewContract,
  terminateContract,
  unbindContractDevices,
  updateContract,
} from '../pages/contracts/contracts-api.js';
import type { ContractListFilter } from '../pages/contracts/contracts-api.js';
import { ContractDetailPage } from '../pages/contracts/ContractDetailPage.js';
import { ContractNewPage } from '../pages/contracts/ContractNewPage.js';
import { ContractsPage } from '../pages/contracts/ContractsPage.js';
import type {
  ContractDeviceAssociationView,
  ContractDeviceDetailView,
  ContractView,
} from '../pages/contracts/types.js';
import {
  cancelConsumableRequest,
  completeConsumableRequest,
  createConsumableRequest,
  getConsumableContact,
  listConsumableRequests,
  listConsumableStatus,
  processConsumableRequest,
} from '../pages/consumables/consumables-api.js';
import type { ConsumableRequestFilter, ConsumableStatusFilter } from '../pages/consumables/consumables-api.js';
import { ConsumablesPage } from '../pages/consumables/ConsumablesPage.js';
import type { ConsumableRequestView, ConsumableStatusView } from '../pages/consumables/types.js';
import { fetchCustomers } from '../pages/customers/customers-api.js';
import { getSetting, listSettings, updateSetting } from '../pages/settings/settings-api.js';
import { canReadSettings, canReadUsers } from '../pages/settings/settings-state.js';
import { SettingsPage } from '../pages/settings/SettingsPage.js';
import type { SettingView, UserView } from '../pages/settings/types.js';
import {
  assignUserRoles,
  disableUser,
  inviteUser,
  listUsers,
  setUserScope,
  triggerUserPasswordReset,
} from '../pages/settings/users-api.js';
import type { UserListFilter } from '../pages/settings/users-api.js';
import type { SessionSnapshot } from '../session/session-manager.js';
import { useDeviceUsersPageProps } from './feature-controllers.js';
import { DEFAULT_THRESHOLDS, thresholdsFromBusinessSetting } from '../pages/consumables/consumable-state.js';
import type { ConsumableThresholdSource, ConsumableThresholds } from '../pages/consumables/consumable-state.js';
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
function queryId(search: string, name: string): string | null {
  const value = new URLSearchParams(search).get(name)?.trim();
  return value ? value : null;
}
export function SettingsController({ api, session }: { readonly api: ApiClient; readonly session: SessionSnapshot }) {
  const role = roleOf(session);
  const [filter, setFilter] = useState<UserListFilter>({});
  const [users, setUsers] = useState<{
    rows: readonly UserView[] | null;
    loading?: boolean;
    error?: unknown;
    nextCursor?: string | null;
  }>({ rows: null });
  const [settings, setSettings] = useState<{
    rows: readonly SettingView[] | null;
    error?: unknown;
  }>({ rows: null });
  const deviceUsers = useDeviceUsersPageProps({ api, session });
  const loadUsers = useCallback(
    async (cursor?: string) => {
      if (!canReadUsers(role)) return setUsers({ rows: [] });
      setUsers((current) => ({ ...current, loading: true }));
      try {
        const page = await listUsers(api, filter, cursor);
        setUsers((current) => ({
          rows: cursor === undefined ? page.rows : [...(current.rows ?? []), ...page.rows],
          nextCursor: page.nextCursor,
        }));
      } catch (error) {
        setUsers({ rows: [], error });
      }
    },
    [api, filter, role],
  );
  const loadSettings = useCallback(async () => {
    if (!canReadSettings(role)) return setSettings({ rows: [] });
    try {
      setSettings({ rows: await listSettings(api) });
    } catch (error) {
      setSettings({ rows: [], error });
    }
  }, [api, role]);
  const refresh = useCallback(() => {
    void loadUsers();
    void loadSettings();
    deviceUsers.onRefresh();
  }, [deviceUsers, loadSettings, loadUsers]);
  useEffect(() => void loadUsers(), [loadUsers]);
  useEffect(() => void loadSettings(), [loadSettings]);
  return (
    <SettingsPage
      role={role}
      users={users}
      userFilter={filter}
      onApplyUserFilter={setFilter}
      onLoadMoreUsers={(cursor) => void loadUsers(cursor)}
      onInviteUser={(input) => inviteUser(api, input)}
      onAssignRoles={(userId, roles) => assignUserRoles(api, userId, roles)}
      onSetScope={(userId, customerId) => setUserScope(api, userId, customerId)}
      onDisableUser={(userId) => disableUser(api, userId)}
      onResetPassword={(userId) => triggerUserPasswordReset(api, userId)}
      settings={settings}
      onUpdateSetting={(key, value, version) => updateSetting(api, key, value, version)}
      deviceUsers={deviceUsers}
      onRefresh={refresh}
    />
  );
}
export function ContractsController({
  api,
  session,
  onNavigate,
}: {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
  readonly onNavigate: Navigate;
}) {
  const [filter, setFilter] = useState<ContractListFilter>({});
  const [contracts, setContracts] = useState<{
    rows: readonly ContractView[] | null;
    loading?: boolean;
    error?: unknown;
  }>({ rows: null });
  const [customers, setCustomers] = useState<
    readonly {
      customerId: string;
      name: string;
    }[]
  >([]);
  const [deviceCounts, setDeviceCounts] = useState<Readonly<Record<string, number>>>({});
  const load = useCallback(async () => {
    setContracts((current) => ({ ...current, loading: true }));
    try {
      const rows = await listContracts(api, filter);
      setContracts({ rows });
      const counts = await Promise.all(
        rows.map(
          async (contract) =>
            [contract.contractId, (await listContractDevices(api, contract.contractId)).length] as const,
        ),
      );
      setDeviceCounts(Object.fromEntries(counts));
    } catch (error) {
      setContracts({ rows: [], error });
    }
  }, [api, filter]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    void fetchCustomers(api, { limit: 100 }).then(
      (page) => setCustomers(page.items.map((customer) => ({ customerId: customer.id, name: customer.name }))),
      () => setCustomers([]),
    );
  }, [api]);
  return (
    <ContractsPage
      role={roleOf(session)}
      contracts={contracts}
      filter={filter}
      onApplyFilter={setFilter}
      customerOptions={customers}
      deviceCounts={deviceCounts}
      onOpenNew={() => onNavigate('/contracts/new')}
      onOpenDetail={(contractId) => onNavigate(`/contracts/detail?contractId=${encodeURIComponent(contractId)}`)}
      onRefresh={() => void load()}
    />
  );
}
export function ContractNewController({
  api,
  onNavigate,
  onNavigationBlockedChange,
}: {
  readonly api: ApiClient;
  readonly onNavigate: Navigate;
  readonly onNavigationBlockedChange: (blocked: boolean) => void;
}) {
  const [customers, setCustomers] = useState<
    readonly {
      customerId: string;
      name: string;
    }[]
  >([]);
  useEffect(() => {
    void fetchCustomers(api, { limit: 100 }).then(
      (page) => setCustomers(page.items.map((customer) => ({ customerId: customer.id, name: customer.name }))),
      () => setCustomers([]),
    );
  }, [api]);
  return (
    <ContractNewPage
      customerOptions={customers}
      onCreate={(input) => createContract(api, input)}
      onListAvailable={(contractId) => listAvailableDevices(api, contractId)}
      onBind={(contractId, deviceIds, reason) => bindContractDevices(api, contractId, deviceIds, reason)}
      onCancel={() => onNavigate('/contracts')}
      onDone={() => onNavigate('/contracts')}
      onNavigationBlockedChange={onNavigationBlockedChange}
    />
  );
}
export function ContractDetailController({
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
  const contractId = queryId(search, 'contractId');
  const [contract, setContract] = useState<ContractView | null>(null);
  const [contractError, setContractError] = useState<unknown>();
  const [devices, setDevices] = useState<{
    rows: readonly ContractDeviceDetailView[] | null;
    error?: unknown;
  }>({
    rows: null,
  });
  const [associations, setAssociations] = useState<readonly ContractDeviceAssociationView[] | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (contractId === null) return setContractError(new Error(translate('ui.0eb22b066a9a')));
    setContractError(undefined);
    const results = await Promise.allSettled([
      getContract(api, contractId),
      listContractDevices(api, contractId),
      listContractAssociations(api, contractId),
    ]);
    if (results[0].status === 'fulfilled') {
      const nextContract = results[0].value;
      setContract(nextContract);
      void fetchCustomers(api, { limit: 100 }).then(
        (page) => setCustomerName(page.items.find((customer) => customer.id === nextContract.customerId)?.name ?? null),
        () => setCustomerName(null),
      );
    } else setContractError(results[0].reason);
    setDevices(results[1].status === 'fulfilled' ? { rows: results[1].value } : { rows: [], error: results[1].reason });
    setAssociations(results[2].status === 'fulfilled' ? results[2].value : []);
  }, [api, contractId]);
  useEffect(() => void load(), [load]);
  const requireId = () => {
    if (contractId === null) throw new Error(translate('ui.0eb22b066a9a'));
    return contractId;
  };
  return (
    <ContractDetailPage
      role={roleOf(session)}
      contract={contract}
      {...(contractError !== undefined ? { contractError } : {})}
      customerName={customerName}
      devices={devices}
      associations={associations}
      onListAvailable={() => listAvailableDevices(api, requireId())}
      onEdit={(input, version) => updateContract(api, requireId(), input, version)}
      onActivate={(reason, version) => activateContract(api, requireId(), reason, version)}
      onRenew={(newEndAt, reason, version) => renewContract(api, requireId(), newEndAt, reason, version)}
      onTerminate={(reason, version) => terminateContract(api, requireId(), reason, version)}
      onBind={(deviceIds, reason) => bindContractDevices(api, requireId(), deviceIds, reason)}
      onUnbind={(deviceIds, reason) => unbindContractDevices(api, requireId(), deviceIds, reason)}
      onBack={() => onNavigate('/contracts')}
      onRefresh={() => void load()}
    />
  );
}
export function ConsumablesController({
  api,
  session,
}: {
  readonly api: ApiClient;
  readonly session: SessionSnapshot;
}) {
  const role = roleOf(session);
  const fixedCustomerId = session.customerId;
  const [thresholdConfig, setThresholdConfig] = useState<{
    readonly thresholds: ConsumableThresholds;
    readonly source: ConsumableThresholdSource;
  }>(() => ({
    thresholds: DEFAULT_THRESHOLDS,
    source: canReadSettings(role) ? { kind: 'loading' } : { kind: 'fallback', reason: 'NOT_AUTHORIZED' },
  }));
  const [statusFilter, setStatusFilter] = useState<ConsumableStatusFilter>(
    fixedCustomerId === null ? {} : { customerId: fixedCustomerId },
  );
  const [requestFilter, setRequestFilter] = useState<ConsumableRequestFilter>(
    fixedCustomerId === null ? {} : { customerId: fixedCustomerId },
  );
  const [status, setStatus] = useState<{
    rows: readonly ConsumableStatusView[] | null;
    error?: unknown;
  }>({
    rows: null,
  });
  const [requests, setRequests] = useState<{
    rows: readonly ConsumableRequestView[] | null;
    error?: unknown;
  }>({
    rows: null,
  });
  const statusQuery = useMemo<ConsumableStatusFilter>(
    () => (fixedCustomerId === null ? statusFilter : { ...statusFilter, customerId: fixedCustomerId }),
    [fixedCustomerId, statusFilter],
  );
  const requestQuery = useMemo<ConsumableRequestFilter>(
    () => (fixedCustomerId === null ? requestFilter : { ...requestFilter, customerId: fixedCustomerId }),
    [fixedCustomerId, requestFilter],
  );
  const load = useCallback(async () => {
    const [statusResult, requestResult] = await Promise.allSettled([
      listConsumableStatus(api, statusQuery),
      listConsumableRequests(api, requestQuery),
    ]);
    setStatus(
      statusResult.status === 'fulfilled' ? { rows: statusResult.value } : { rows: [], error: statusResult.reason },
    );
    setRequests(
      requestResult.status === 'fulfilled' ? { rows: requestResult.value } : { rows: [], error: requestResult.reason },
    );
  }, [api, requestQuery, statusQuery]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!canReadSettings(role)) return;
    let active = true;
    void getSetting(api, 'alarm.thresholds').then(
      (setting) => {
        if (active) setThresholdConfig(thresholdsFromBusinessSetting(setting));
      },
      () => {
        if (active)
          setThresholdConfig({ thresholds: DEFAULT_THRESHOLDS, source: { kind: 'fallback', reason: 'LOAD_FAILED' } });
      },
    );
    return () => {
      active = false;
    };
  }, [api, role]);
  return (
    <ConsumablesPage
      role={role}
      status={status}
      statusFilter={statusQuery}
      onApplyStatusFilter={setStatusFilter}
      onLoadContact={(deviceId) => getConsumableContact(api, deviceId)}
      requests={requests}
      requestFilter={requestQuery}
      onApplyRequestFilter={setRequestFilter}
      onCreateRequest={(deviceId, type, note) => createConsumableRequest(api, deviceId, type, note)}
      onProcess={(requestId, note, version) => processConsumableRequest(api, requestId, note, version)}
      onComplete={(requestId, note, version) => completeConsumableRequest(api, requestId, note, version)}
      onCancel={(requestId, note, version) => cancelConsumableRequest(api, requestId, note, version)}
      onRefresh={() => void load()}
      thresholds={thresholdConfig.thresholds}
      thresholdSource={thresholdConfig.source}
    />
  );
}
