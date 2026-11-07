import type { LiveLatestSuccess, LiveLeaseSuccess } from '@fdp/contracts/rest/image-types.js';
import type { ApiClient } from '../../api/http-client.js';
const root = (deviceId: string) => `/admin/devices/${encodeURIComponent(deviceId)}/live-image`;
export function renewImageViewer(api: ApiClient, deviceId: string, viewerId: string, signal: AbortSignal) {
  return api.request<LiveLeaseSuccess>(`${root(deviceId)}/viewers/${encodeURIComponent(viewerId)}`, {
    method: 'PUT',
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
  knownFrameId?: string,
) {
  const query = new URLSearchParams({ viewerId });
  if (knownFrameId) query.set('knownFrameId', knownFrameId);
  return api.request<LiveLatestSuccess>(`${root(deviceId)}/latest?${query}`, { signal, cache: 'no-store' });
}
