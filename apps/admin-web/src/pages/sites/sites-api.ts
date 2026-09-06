/**
 * FE-05 Site API 装配（BE-CUS-02）：列表（customerId/region/subregion/status 筛选 + 游标）、
 * 创建、更新（customerId 不可变）、停用（原因必填）。写操作携 If-Match。
 */
import type { ApiClient } from '../../api/http-client.js';
import type { SiteInput, SiteStatus, SiteView } from './types.js';

export interface SiteListFilter {
  readonly customerId?: string | null;
  readonly region?: string | null;
  readonly subregion?: string | null;
  readonly status?: SiteStatus | null;
}

export interface SiteList {
  readonly items: readonly SiteView[];
  readonly nextCursor: string | null;
}

export async function fetchSites(
  api: ApiClient,
  filter?: SiteListFilter,
  options?: { cursor?: string | null; limit?: number },
): Promise<SiteList> {
  const params = new URLSearchParams();
  if (filter?.customerId) params.set('customerId', filter.customerId);
  if (filter?.region) params.set('region', filter.region);
  if (filter?.subregion) params.set('subregion', filter.subregion);
  if (filter?.status) params.set('status', filter.status);
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.toString();
  const response = await api.request<{ data: SiteView[]; meta: { nextCursor: string | null } }>(
    `/admin/sites${query === '' ? '' : `?${query}`}`,
  );
  return { items: response.data, nextCursor: response.meta.nextCursor };
}

export async function createSite(api: ApiClient, customerId: string, input: SiteInput): Promise<SiteView> {
  const response = await api.request<{ data: SiteView }>('/admin/sites', {
    method: 'POST',
    body: { customerId, ...input },
  });
  return response.data;
}

export async function updateSite(api: ApiClient, siteId: string, version: number, input: SiteInput): Promise<SiteView> {
  const response = await api.request<{ data: SiteView }>(`/admin/sites/${encodeURIComponent(siteId)}`, {
    method: 'PATCH',
    ifMatch: version,
    body: { ...input },
  });
  return response.data;
}

export async function deactivateSite(
  api: ApiClient,
  siteId: string,
  version: number,
  reason: string,
): Promise<SiteView> {
  const response = await api.request<{ data: SiteView }>(`/admin/sites/${encodeURIComponent(siteId)}/deactivate`, {
    method: 'POST',
    ifMatch: version,
    body: { reason },
  });
  return response.data;
}
