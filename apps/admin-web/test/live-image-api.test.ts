import { expect, test, vi } from 'vitest';
import { createHttpApiFetch } from '../src/api/http-client.js';
import { readLatestImage, releaseImageViewer, renewImageViewer } from '../src/pages/devices/live-image-api.js';
import type { ApiClient } from '../src/api/http-client.js';
test('preview API adapters use escaped paths, JSON lease, per-viewer reads and keepalive release', async () => {
  const request = vi.fn(async () => ({}));
  const api = { request: request as ApiClient['request'] },
    signal = new AbortController().signal;
  await renewImageViewer(api, 'd /?', 'v /?', signal);
  await readLatestImage(api, 'd /?', 'v /?', signal, 'f /?');
  await releaseImageViewer(api, 'd /?', 'v /?');
  expect(request.mock.calls[0]).toEqual([
    '/admin/devices/d%20%2F%3F/live-image/viewers/v%20%2F%3F',
    { method: 'PUT', body: {}, signal, cache: 'no-store' },
  ]);
  expect(request.mock.calls[1]).toEqual([
    '/admin/devices/d%20%2F%3F/live-image/latest?viewerId=v+%2F%3F&afterFrameId=f+%2F%3F',
    { signal, cache: 'no-store' },
  ]);
  expect(request.mock.calls[2]).toEqual([
    '/admin/devices/d%20%2F%3F/live-image/viewers/v%20%2F%3F',
    { method: 'DELETE', cache: 'no-store', keepalive: true },
  ]);
});
test('fetch transport propagates cancellation, no-store and keepalive without changing defaults', async () => {
  const transport = vi.fn(async () => new Response(null, { status: 204 }));
  const fetcher = createHttpApiFetch(transport as typeof fetch),
    signal = new AbortController().signal;
  expect(
    await fetcher('/preview', {
      method: 'DELETE',
      headers: { Authorization: 'test-token' },
      signal,
      cache: 'no-store',
      keepalive: true,
    }),
  ).toEqual({ status: 204, body: null });
  expect(transport.mock.calls[0]).toEqual([
    '/preview',
    { method: 'DELETE', headers: { Authorization: 'test-token' }, signal, cache: 'no-store', keepalive: true },
  ]);
});
