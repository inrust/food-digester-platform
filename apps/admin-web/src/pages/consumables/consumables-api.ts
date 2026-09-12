/**
 * FE-18 耗材 API 装配（BE-CNS-01/BE-CNS-02）。
 *
 * - 状态迁移（process/complete/cancel）强制 If-Match（version）+ 审计；
 *   complete/cancel 强制处理备注/原因；
 * - 创建幂等：同设备同耗材存在开放申请 → 200 + replayed=true（无写入）；
 * - Customer 角色租户隔离由服务端强制（跨 Customer 详情 → 404）。
 */
import type { ApiClient } from '../../api/http-client.js';
import type {
  ConsumableContactView,
  ConsumableRequestCreateResult,
  ConsumableRequestStatus,
  ConsumableRequestView,
  ConsumableStatusView,
  ConsumableType,
} from './types.js';

export interface ConsumableStatusFilter {
  readonly region?: string | null;
  readonly subregion?: string | null;
  readonly siteId?: string | null;
  readonly connectivity?: 'ONLINE' | 'OFFLINE' | null;
  /** 设备 ID/序列号/别名。 */
  readonly keyword?: string | null;
  /** 阈值筛选（配合 consumableType；缺省任一已上报耗材）。 */
  readonly maxRemainingPercent?: number | null;
  readonly consumableType?: ConsumableType | null;
  /** 仅平台角色可传；Customer 角色强制本 Customer。 */
  readonly customerId?: string | null;
}

export interface ConsumableRequestFilter {
  readonly customerId?: string | null;
  readonly deviceId?: string | null;
  readonly status?: ConsumableRequestStatus | null;
  readonly consumableType?: ConsumableType | null;
}

function buildQuery(filter: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export async function listConsumableStatus(
  api: ApiClient,
  filter: ConsumableStatusFilter,
): Promise<readonly ConsumableStatusView[]> {
  const response = await api.request<{ data: ConsumableStatusView[] }>(
    `/admin/consumables${buildQuery({ ...filter })}`,
  );
  return response.data;
}

/** 联系人 PII 按设备、按点击授权加载；列表响应不含该字段。 */
export async function getConsumableContact(api: ApiClient, deviceId: string): Promise<ConsumableContactView> {
  const response = await api.request<{ data: ConsumableContactView }>(
    `/admin/consumables/${encodeURIComponent(deviceId)}/contact`,
  );
  return response.data;
}

export async function listConsumableRequests(
  api: ApiClient,
  filter: ConsumableRequestFilter,
): Promise<readonly ConsumableRequestView[]> {
  const response = await api.request<{ data: ConsumableRequestView[] }>(
    `/admin/consumable-requests${buildQuery({ ...filter })}`,
  );
  return response.data;
}

export async function createConsumableRequest(
  api: ApiClient,
  deviceId: string,
  consumableType: ConsumableType,
  note?: string,
): Promise<ConsumableRequestCreateResult> {
  const body: Record<string, unknown> = { deviceId, consumableType };
  if (note !== undefined && note !== '') body['note'] = note;
  const response = await api.request<{ data: ConsumableRequestView & { replayed?: boolean } }>(
    '/admin/consumable-requests',
    { method: 'POST', body },
  );
  const { replayed, ...request } = response.data;
  return { request, replayed: replayed === true };
}

/** 开始处理（PENDING→PROCESSING；处理备注可选）。 */
export async function processConsumableRequest(
  api: ApiClient,
  requestId: string,
  note: string | null,
  version: number,
): Promise<ConsumableRequestView> {
  const body: Record<string, unknown> = {};
  if (note !== null && note !== '') body['note'] = note;
  const response = await api.request<{ data: ConsumableRequestView }>(
    `/admin/consumable-requests/${encodeURIComponent(requestId)}/process`,
    { method: 'POST', body, ifMatch: version },
  );
  return response.data;
}

/** 完成处理（PROCESSING→COMPLETED；处理备注强制）。 */
export async function completeConsumableRequest(
  api: ApiClient,
  requestId: string,
  note: string,
  version: number,
): Promise<ConsumableRequestView> {
  const response = await api.request<{ data: ConsumableRequestView }>(
    `/admin/consumable-requests/${encodeURIComponent(requestId)}/complete`,
    { method: 'POST', body: { note }, ifMatch: version },
  );
  return response.data;
}

/** 取消（PENDING/PROCESSING→CANCELLED；原因强制）。 */
export async function cancelConsumableRequest(
  api: ApiClient,
  requestId: string,
  note: string,
  version: number,
): Promise<ConsumableRequestView> {
  const response = await api.request<{ data: ConsumableRequestView }>(
    `/admin/consumable-requests/${encodeURIComponent(requestId)}/cancel`,
    { method: 'POST', body: { note }, ifMatch: version },
  );
  return response.data;
}
