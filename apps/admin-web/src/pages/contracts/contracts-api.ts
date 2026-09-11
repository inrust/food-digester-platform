/**
 * FE-17 Contract API 装配（BE-CON-01/BE-CON-02）。
 *
 * - 写操作全部携带 If-Match（当前 version 乐观锁）+ 强制原因（编辑/激活/续约/终止/绑定/解绑）；
 * - createContract 不自动激活 License（DEC-007）；关联/解绑不改变 Device lifecycle 与 License；
 * - 设备仅从 listAvailableDevices（eligible：同 Customer、非 Retired、无 ACTIVE 关联）选择。
 */
import type { ApiClient } from '../../api/http-client.js';
import type {
  AvailableDeviceView,
  ContractDeviceAssociationView,
  ContractDeviceDetailView,
  ContractStatus,
  ContractView,
} from './types.js';

export interface ContractListFilter {
  readonly status?: ContractStatus | null;
  readonly customerId?: string | null;
}

function buildQuery(filter: ContractListFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export async function listContracts(api: ApiClient, filter: ContractListFilter): Promise<readonly ContractView[]> {
  const response = await api.request<{ data: ContractView[] }>(`/admin/contracts${buildQuery(filter)}`);
  return response.data;
}

export async function getContract(api: ApiClient, contractId: string): Promise<ContractView> {
  const response = await api.request<{ data: ContractView }>(`/admin/contracts/${encodeURIComponent(contractId)}`);
  return response.data;
}

/** 创建输入（contact 可选；reason 可选）。 */
export interface ContractCreateInput {
  readonly contractNumber: string;
  readonly name: string;
  readonly customerId: string;
  readonly contact?: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly reason?: string;
}

export async function createContract(api: ApiClient, input: ContractCreateInput): Promise<ContractView> {
  const response = await api.request<{ data: ContractView }>('/admin/contracts', {
    method: 'POST',
    body: { ...input },
  });
  return response.data;
}

/** 编辑输入（reason 强制；startAt/endAt 仅 DRAFT 可改）。 */
export interface ContractUpdateInput {
  readonly name?: string;
  readonly contact?: string | null;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly reason: string;
}

export async function updateContract(
  api: ApiClient,
  contractId: string,
  input: ContractUpdateInput,
  version: number,
): Promise<ContractView> {
  const response = await api.request<{ data: ContractView }>(`/admin/contracts/${encodeURIComponent(contractId)}`, {
    method: 'PATCH',
    body: { ...input },
    ifMatch: version,
  });
  return response.data;
}

export async function activateContract(
  api: ApiClient,
  contractId: string,
  reason: string,
  version: number,
): Promise<ContractView> {
  const response = await api.request<{ data: ContractView }>(
    `/admin/contracts/${encodeURIComponent(contractId)}/activate`,
    { method: 'POST', body: { reason }, ifMatch: version },
  );
  return response.data;
}

export async function renewContract(
  api: ApiClient,
  contractId: string,
  newEndAt: string,
  reason: string,
  version: number,
): Promise<ContractView> {
  const response = await api.request<{ data: ContractView }>(
    `/admin/contracts/${encodeURIComponent(contractId)}/renew`,
    { method: 'POST', body: { newEndAt, reason }, ifMatch: version },
  );
  return response.data;
}

export async function terminateContract(
  api: ApiClient,
  contractId: string,
  reason: string,
  version: number,
): Promise<ContractView> {
  const response = await api.request<{ data: ContractView }>(
    `/admin/contracts/${encodeURIComponent(contractId)}/terminate`,
    { method: 'POST', body: { reason }, ifMatch: version },
  );
  return response.data;
}

// ---------- 设备关联（BE-CON-02） ----------

export async function listContractDevices(
  api: ApiClient,
  contractId: string,
): Promise<readonly ContractDeviceDetailView[]> {
  const response = await api.request<{ data: ContractDeviceDetailView[] }>(
    `/admin/contracts/${encodeURIComponent(contractId)}/devices`,
  );
  return response.data;
}

export async function listAvailableDevices(
  api: ApiClient,
  contractId: string,
): Promise<readonly AvailableDeviceView[]> {
  const response = await api.request<{ data: AvailableDeviceView[] }>(
    `/admin/contracts/${encodeURIComponent(contractId)}/available-devices`,
  );
  return response.data;
}

export async function listContractAssociations(
  api: ApiClient,
  contractId: string,
): Promise<readonly ContractDeviceAssociationView[]> {
  const response = await api.request<{ data: ContractDeviceAssociationView[] }>(
    `/admin/contracts/${encodeURIComponent(contractId)}/associations`,
  );
  return response.data;
}

export async function bindContractDevices(
  api: ApiClient,
  contractId: string,
  deviceIds: readonly string[],
  reason: string,
): Promise<readonly string[]> {
  const response = await api.request<{ data: { bound: string[] } }>(
    `/admin/contracts/${encodeURIComponent(contractId)}/devices/bind`,
    { method: 'POST', body: { deviceIds: [...deviceIds], reason } },
  );
  return response.data.bound;
}

export async function unbindContractDevices(
  api: ApiClient,
  contractId: string,
  deviceIds: readonly string[],
  reason: string,
): Promise<readonly string[]> {
  const response = await api.request<{ data: { unbound: string[] } }>(
    `/admin/contracts/${encodeURIComponent(contractId)}/devices/unbind`,
    { method: 'POST', body: { deviceIds: [...deviceIds], reason } },
  );
  return response.data.unbound;
}
