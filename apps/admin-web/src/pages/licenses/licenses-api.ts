/**
 * FE-08 License API 装配（BE-LIC-01）。
 *
 * - 列表使用正式 License 查询接口，包含 Revoked/Expired 等终态历史记录；
 * - create：设备存在任一非终态 License → 409 CONFLICT（页面原样呈现后端 message）；
 * - issue/activate：无请求体；renew：newValidTo 必须晚于当前 validTo；revoke：强制原因；
 * - evaluate（SYSTEM 时间派生）不在管理页面暴露（见 license-state.ts 说明）。
 */
import type { ApiClient } from '../../api/http-client.js';
import type { EntitlementCode, LicenseHistoryEntryView, LicenseRenewResultView, LicenseView } from './types.js';

export interface LicenseCreateInput {
  readonly deviceId: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly entitlements: readonly EntitlementCode[];
  readonly reason?: string;
}

export async function fetchLicenses(
  api: ApiClient,
  filter: { status?: string | null; keyword?: string | null } = {},
  options: { cursor?: string | null; limit?: number } = {},
): Promise<{ readonly items: readonly LicenseView[]; readonly nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.keyword) params.set('keyword', filter.keyword);
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.toString();
  const response = await api.request<{ data: LicenseView[]; meta: { nextCursor: string | null } }>(
    `/admin/licenses${query ? `?${query}` : ''}`,
  );
  return { items: response.data, nextCursor: response.meta.nextCursor };
}

function licensePath(licenseId: string): string {
  return `/admin/licenses/${encodeURIComponent(licenseId)}`;
}

export async function createLicense(api: ApiClient, input: LicenseCreateInput): Promise<LicenseView> {
  const body: Record<string, unknown> = {
    deviceId: input.deviceId,
    validFrom: input.validFrom,
    validTo: input.validTo,
    entitlements: [...input.entitlements],
  };
  if (input.reason !== undefined && input.reason !== '') body['reason'] = input.reason;
  const response = await api.request<{ data: LicenseView }>('/admin/licenses', { method: 'POST', body });
  return response.data;
}

export async function fetchLicense(api: ApiClient, licenseId: string): Promise<LicenseView> {
  const response = await api.request<{ data: LicenseView }>(licensePath(licenseId));
  return response.data;
}

export async function fetchLicenseHistory(
  api: ApiClient,
  licenseId: string,
): Promise<readonly LicenseHistoryEntryView[]> {
  const response = await api.request<{ data: LicenseHistoryEntryView[] }>(`${licensePath(licenseId)}/history`);
  return response.data;
}

export async function issueLicense(api: ApiClient, licenseId: string): Promise<LicenseView> {
  const response = await api.request<{ data: LicenseView }>(`${licensePath(licenseId)}/issue`, { method: 'POST' });
  return response.data;
}

export async function activateLicense(api: ApiClient, licenseId: string): Promise<LicenseView> {
  const response = await api.request<{ data: LicenseView }>(`${licensePath(licenseId)}/activate`, { method: 'POST' });
  return response.data;
}

export async function renewLicense(
  api: ApiClient,
  licenseId: string,
  newValidTo: string,
): Promise<LicenseRenewResultView> {
  const response = await api.request<{ data: LicenseRenewResultView }>(`${licensePath(licenseId)}/renew`, {
    method: 'POST',
    body: { newValidTo },
  });
  return response.data;
}

export async function revokeLicense(api: ApiClient, licenseId: string, reason: string): Promise<LicenseView> {
  const response = await api.request<{ data: LicenseView }>(`${licensePath(licenseId)}/revoke`, {
    method: 'POST',
    body: { reason },
  });
  return response.data;
}
