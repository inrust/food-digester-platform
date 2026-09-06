/**
 * FE-05 Customer API 装配（BE-CUS-01）：列表（status 筛选 + 游标）、创建、改名、停用（原因必填）。
 * 写操作携 If-Match；权限由后端强制（customer:read/customer:write）。
 */
import type { ApiClient } from '../../api/http-client.js';
import type { CustomerStatus, CustomerView } from './types.js';

export interface CustomerList {
  readonly items: readonly CustomerView[];
  readonly nextCursor: string | null;
}

export async function fetchCustomers(
  api: ApiClient,
  options?: { status?: CustomerStatus; cursor?: string | null; limit?: number },
): Promise<CustomerList> {
  const params = new URLSearchParams();
  if (options?.status !== undefined) params.set('status', options.status);
  if (options?.cursor !== undefined && options.cursor !== null) params.set('cursor', options.cursor);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.toString();
  const response = await api.request<{ data: CustomerView[]; meta: { nextCursor: string | null } }>(
    `/admin/customers${query === '' ? '' : `?${query}`}`,
  );
  return { items: response.data, nextCursor: response.meta.nextCursor };
}

export async function createCustomer(api: ApiClient, input: { name: string }): Promise<CustomerView> {
  const response = await api.request<{ data: CustomerView }>('/admin/customers', {
    method: 'POST',
    body: { name: input.name },
  });
  return response.data;
}

export async function updateCustomer(
  api: ApiClient,
  customerId: string,
  version: number,
  input: { name: string },
): Promise<CustomerView> {
  const response = await api.request<{ data: CustomerView }>(`/admin/customers/${encodeURIComponent(customerId)}`, {
    method: 'PATCH',
    ifMatch: version,
    body: { name: input.name },
  });
  return response.data;
}

export async function deactivateCustomer(
  api: ApiClient,
  customerId: string,
  version: number,
  reason: string,
): Promise<CustomerView> {
  const response = await api.request<{ data: CustomerView }>(
    `/admin/customers/${encodeURIComponent(customerId)}/deactivate`,
    { method: 'POST', ifMatch: version, body: { reason } },
  );
  return response.data;
}
