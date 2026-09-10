/**
 * FE-06 设备 API 装配：listDevices（BE-DEV-01，四轴组合筛选 + 键集游标）、
 * getDevice、getDeviceConsole/listDeviceActivities（BE-DEV-05），以及最新授权 Media 的短期下载 URL。
 * 不请求原始 Telemetry 长期表。
 */
import type { ApiClient } from '../../api/http-client.js';
import type { DeviceActivityView, DeviceConsoleView, DeviceView, MediaDownloadUrlView } from './types.js';

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

export async function fetchDeviceActivities(
  api: ApiClient,
  deviceId: string,
  cursor?: string,
): Promise<{ readonly items: readonly DeviceActivityView[]; readonly nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: '20' });
  if (cursor) params.set('cursor', cursor);
  const response = await api.request<{ data: DeviceActivityView[]; meta: { nextCursor: string | null } }>(
    `/admin/devices/${encodeURIComponent(deviceId)}/activities?${params.toString()}`,
  );
  return { items: response.data, nextCursor: response.meta.nextCursor };
}

export async function fetchMediaDownloadUrl(api: ApiClient, mediaId: string): Promise<MediaDownloadUrlView> {
  const response = await api.request<{ data: MediaDownloadUrlView }>(
    `/admin/media/${encodeURIComponent(mediaId)}/download-url`,
  );
  return response.data;
}
