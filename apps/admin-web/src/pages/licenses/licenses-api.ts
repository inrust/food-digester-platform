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

export interface LicenseScope {
  readonly contractId?: string;
  readonly deviceId?: string;
  readonly associationId?: string;
}

export interface LicenseScopeDevice {
  readonly deviceId: string;
  readonly customerId: string;
  readonly associationId: string | null;
  readonly label: string;
  readonly canCreate: boolean;
}

export interface LicenseScopeView {
  readonly contractId: string | null;
  readonly devices: readonly LicenseScopeDevice[];
}

function applyScope(params: URLSearchParams, scope?: LicenseScope): void {
  if (scope?.contractId) params.set('contractId', scope.contractId);
  if (scope?.deviceId) params.set('scopeDeviceId', scope.deviceId);
  if (scope?.associationId) params.set('associationId', scope.associationId);
}

function scopedPath(path: string, scope?: LicenseScope): string {
  const params = new URLSearchParams();
  applyScope(params, scope);
  return params.size === 0 ? path : `${path}?${params}`;
}

export async function fetchLicenses(
  api: ApiClient,
  filter: {
    customerId?: string | null;
    deviceId?: string | null;
    status?: string | null;
    keyword?: string | null;
    scope?: LicenseScope;
  } = {},
  options: { cursor?: string | null; limit?: number } = {},
): Promise<{
  readonly items: readonly LicenseView[];
  readonly nextCursor: string | null;
  readonly scope?: LicenseScopeView;
}> {
  const params = new URLSearchParams();
  applyScope(params, filter.scope);
  if (filter.customerId) params.set('customerId', filter.customerId);
  if (filter.deviceId) params.set('deviceId', filter.deviceId);
  if (filter.status) params.set('status', filter.status);
  if (filter.keyword) params.set('keyword', filter.keyword);
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.toString();
  const response = await api.request<{
    data: LicenseView[];
    meta: { nextCursor: string | null; scope?: LicenseScopeView };
  }>(`/admin/licenses${query ? `?${query}` : ''}`);
  return {
    items: response.data,
    nextCursor: response.meta.nextCursor,
    ...(response.meta.scope ? { scope: response.meta.scope } : {}),
  };
}

function licensePath(licenseId: string): string {
  return `/admin/licenses/${encodeURIComponent(licenseId)}`;
}

export async function createLicense(
  api: ApiClient,
  input: LicenseCreateInput,
  scope?: LicenseScope,
): Promise<LicenseView> {
  const body: Record<string, unknown> = {
    deviceId: input.deviceId,
    validFrom: input.validFrom,
    validTo: input.validTo,
    entitlements: [...input.entitlements],
  };
  if (input.reason !== undefined && input.reason !== '') body['reason'] = input.reason;
  const response = await api.request<{ data: LicenseView }>(scopedPath('/admin/licenses', scope), {
    method: 'POST',
    body,
  });
  return response.data;
}

export async function fetchLicense(api: ApiClient, licenseId: string, scope?: LicenseScope): Promise<LicenseView> {
  const response = await api.request<{ data: LicenseView }>(scopedPath(licensePath(licenseId), scope));
  return response.data;
}

export async function fetchLicenseHistory(
  api: ApiClient,
  licenseId: string,
  scope?: LicenseScope,
): Promise<readonly LicenseHistoryEntryView[]> {
  const response = await api.request<{ data: LicenseHistoryEntryView[] }>(
    scopedPath(`${licensePath(licenseId)}/history`, scope),
  );
  return response.data;
}

export async function issueLicense(
  api: ApiClient,
  licenseId: string,
  scope?: LicenseScope,
  ifMatch?: number,
): Promise<LicenseView> {
  const response = await api.request<{ data: LicenseView }>(scopedPath(`${licensePath(licenseId)}/issue`, scope), {
    method: 'POST',
    ...(ifMatch === undefined ? {} : { ifMatch }),
  });
  return response.data;
}

export async function activateLicense(
  api: ApiClient,
  licenseId: string,
  scope?: LicenseScope,
  ifMatch?: number,
): Promise<LicenseView> {
  const response = await api.request<{ data: LicenseView }>(scopedPath(`${licensePath(licenseId)}/activate`, scope), {
    method: 'POST',
    ...(ifMatch === undefined ? {} : { ifMatch }),
  });
  return response.data;
}

export async function renewLicense(
  api: ApiClient,
  licenseId: string,
  newValidTo: string,
  scope?: LicenseScope,
  ifMatch?: number,
): Promise<LicenseRenewResultView> {
  const response = await api.request<{ data: LicenseRenewResultView }>(
    scopedPath(`${licensePath(licenseId)}/renew`, scope),
    {
      ...(ifMatch === undefined ? {} : { ifMatch }),
      method: 'POST',
      body: { newValidTo },
    },
  );
  return response.data;
}

export async function revokeLicense(
  api: ApiClient,
  licenseId: string,
  reason: string,
  scope?: LicenseScope,
  ifMatch?: number,
): Promise<LicenseView> {
  const response = await api.request<{ data: LicenseView }>(scopedPath(`${licensePath(licenseId)}/revoke`, scope), {
    ...(ifMatch === undefined ? {} : { ifMatch }),
    method: 'POST',
    body: { reason },
  });
  return response.data;
}
