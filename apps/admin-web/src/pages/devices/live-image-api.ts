import type { LiveLatestSuccess, LiveLeaseSuccess } from '@fdp/contracts/rest/image-types.js';
import type { ApiClient } from '../../api/http-client.js';
const root = (deviceId: string) => `/admin/devices/${encodeURIComponent(deviceId)}/live-image`;
export function renewImageViewer(api: ApiClient, deviceId: string, viewerId: string, signal: AbortSignal) {
  return api.request<LiveLeaseSuccess>(`${root(deviceId)}/viewers/${encodeURIComponent(viewerId)}`, {
    method: 'PUT',
    body: {},
    signal,
    cache: 'no-store',
  });
}
export function releaseImageViewer(api: ApiClient, deviceId: string, viewerId: string) {
  return api.request<void>(`${root(deviceId)}/viewers/${encodeURIComponent(viewerId)}`, {
    method: 'DELETE',
    cache: 'no-store',
    keepalive: true,
  });
}
export function readLatestImage(
  api: ApiClient,
  deviceId: string,
  viewerId: string,
  signal: AbortSignal,
  afterFrameId?: string,
) {
  const query = new URLSearchParams({ viewerId });
  if (afterFrameId) query.set('afterFrameId', afterFrameId);
  return api.request<LiveLatestSuccess>(`${root(deviceId)}/latest?${query}`, { signal, cache: 'no-store' });
}
