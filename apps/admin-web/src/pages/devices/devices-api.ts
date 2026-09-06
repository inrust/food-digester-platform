/**
 * FE-06 设备 API 装配：listDevices（BE-DEV-01，四轴组合筛选 + 键集游标）、
 * getDevice、getDeviceConsole（BE-DEV-05）。不请求原始 Telemetry 长期表。
 */
import type { ApiClient } from '../../api/http-client.js';
import type { DeviceConsoleView, DeviceView } from './types.js';

export interface DeviceListFilter {
  readonly customerId?: string | null;
  readonly siteId?: string | null;
  readonly region?: string | null;
  readonly subregion?: string | null;
  readonly lifecycleStatus?: string | null;
  readonly operationalStatus?: string | null;
  readonly connectivity?: string | null;
  readonly licenseStatus?: string | null;
  readonly keyword?: string | null;
}

export interface DeviceList {
  readonly items: readonly DeviceView[];
  readonly nextCursor: string | null;
}

export async function fetchDevices(
  api: ApiClient,
  filter?: DeviceListFilter,
  options?: { cursor?: string | null; limit?: number },
): Promise<DeviceList> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter ?? {})) {
    if (typeof value === 'string' && value !== '') params.set(key, value);
  }
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.toString();
  const response = await api.request<{ data: DeviceView[]; meta: { nextCursor: string | null } }>(
    `/admin/devices${query === '' ? '' : `?${query}`}`,
  );
  return { items: response.data, nextCursor: response.meta.nextCursor };
}

export async function fetchDevice(api: ApiClient, deviceId: string): Promise<DeviceView> {
  const response = await api.request<{ data: DeviceView }>(`/admin/devices/${encodeURIComponent(deviceId)}`);
  return response.data;
}

export async function fetchDeviceConsole(api: ApiClient, deviceId: string): Promise<DeviceConsoleView> {
  const response = await api.request<{ data: DeviceConsoleView }>(
    `/admin/devices/${encodeURIComponent(deviceId)}/console`,
  );
  return response.data;
}
