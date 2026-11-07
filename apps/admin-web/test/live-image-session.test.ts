import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { startImagePreview } from '../src/pages/devices/live-image-session.js';
import type { ImagePreviewState } from '../src/pages/devices/live-image-session.js';
import type { ApiClient, ApiRequestOptions } from '../src/api/http-client.js';
import { ApiClientError, UnauthenticatedError } from '../src/api/errors.js';
const stream = '10000000-0000-4000-8000-000000000001',
  frameId = '20000000-0000-4000-8000-000000000001';
const viewer = '30000000-0000-4000-8000-000000000001';
const jpeg = readFileSync(
  new URL('../../../contracts/rest/fixtures/device-images/capture.jpg', import.meta.url),
).toString('base64');
const meta = () => ({ requestId: 'r', timestamp: new Date(Date.now()).toISOString() });
const lease = () => ({
  data: {
    streamId: stream,
    leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
    renewAfterSeconds: 10,
    readIntervalMs: 2000,
  },
  meta: meta(),
});
const ready = () => ({
  data: {
    state: 'READY',
    streamId: stream,
    frameId,
    capturedAt: new Date(Date.now()).toISOString(),
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    mimeType: 'image/jpeg',
    imageBase64: jpeg,
  },
  meta: meta(),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
});
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture(handler?: (path: string, options: ApiRequestOptions) => Promise<unknown>) {
  const states: ImagePreviewState[] = [];
  const request = vi.fn(async (path: string, options: ApiRequestOptions = {}) => {
    if (handler) return handler(path, options);
    if (options.method === 'PUT') return lease();
    if (options.method === 'DELETE') return undefined;
    return ready();
  });
  const api = { request: request as ApiClient['request'] };
  const stop = startImagePreview({
    api,
    deviceId: 'device /one',
    viewerId: viewer,
    clock: () => Date.now(),
    onState: (state) => states.push(state),
  });
  stops.push(stop);
  return { request, stop, states, latest: () => states.at(-1) };
}
test('acquires once, reads at 2s, renews at 10s, sends viewer/afterFrame IDs and never requests S3', async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.latest()?.status).toBe('ready');
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.request.mock.calls[0]?.[0]).toContain('/device%20%2Fone/live-image/viewers/');
  await vi.advanceTimersByTimeAsync(2000);
  const read = f.request.mock.calls.at(-1)!;
  expect(new URL(read[0], 'https://local.test').searchParams.get('knownFrameId')).toBe(frameId);
  expect(new URL(read[0], 'https://local.test').searchParams.get('viewerId')).toBe(viewer);
  await vi.advanceTimersByTimeAsync(8000);
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(2);
  expect(f.request.mock.calls.every((call) => call[1]?.cache === 'no-store')).toBe(true);
  expect(f.request.mock.calls.every((call) => !call[0].includes('media') && !call[0].startsWith('https:'))).toBe(true);
});
test('read latency never creates overlapping GET requests', async () => {
  const pending = deferred<ReturnType<typeof ready>>();
  const f = fixture(async (_path, options) =>
    options.method === 'PUT' ? lease() : options.method === 'DELETE' ? undefined : pending.promise,
  );
  await vi.advanceTimersByTimeAsync(9000);
  expect(f.request.mock.calls.filter((call) => !call[1]?.method)).toHaveLength(1);
  pending.resolve(ready());
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(1999);
  expect(f.request.mock.calls.filter((call) => !call[1]?.method)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.request.mock.calls.filter((call) => !call[1]?.method)).toHaveLength(2);
});
test('close aborts all pending calls, releases exactly its viewer and cancels every future timer', async () => {
  const pending = deferred<ReturnType<typeof ready>>();
  const f = fixture(async (_path, options) =>
    options.method === 'PUT' ? lease() : options.method === 'DELETE' ? undefined : pending.promise,
  );
  await vi.advanceTimersByTimeAsync(0);
  const previous = f.latest();
  const signal = f.request.mock.calls.find((call) => !call[1]?.method)![1]!.signal!;
  f.stop();
  expect(signal.aborted).toBe(true);
  expect(f.request.mock.calls.at(-1)).toMatchObject([
    expect.stringContaining(viewer),
    { method: 'DELETE', keepalive: true },
  ]);
  pending.resolve(ready());
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.latest()).toBe(previous);
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
test('a late lease reply after close is released again and never starts reading', async () => {
  const pending = deferred<ReturnType<typeof lease>>();
  const reply = lease();
  const f = fixture(async (_path, options) => (options.method === 'PUT' ? pending.promise : undefined));
  f.stop();
  expect(f.request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  pending.resolve(reply);
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'DELETE')).toHaveLength(2);
  expect(f.states.map((state) => state.status)).toEqual(['connecting']);
});
test('multiple viewers receive independent IDs and releasing one does not stop the other', async () => {
  const requests: { path: string; options: ApiRequestOptions }[] = [];
  const api: ApiClient = {
    request: async <T>(path: string, options: ApiRequestOptions = {}) => {
      requests.push({ path, options });
      return (options.method === 'PUT' ? lease() : options.method === 'DELETE' ? undefined : ready()) as T;
    },
  };
  const a = startImagePreview({ api, deviceId: 'd', onState: () => {}, clock: () => Date.now() });
  const b = startImagePreview({ api, deviceId: 'd', onState: () => {}, clock: () => Date.now() });
  stops.push(a, b);
  await vi.advanceTimersByTimeAsync(0);
  const put = requests.filter((call) => call.options.method === 'PUT');
  expect(put[0]!.path).not.toBe(put[1]!.path);
  a();
  await vi.advanceTimersByTimeAsync(10000);
  expect(requests.filter((call) => call.options.method === 'PUT' && call.path === put[0]!.path)).toHaveLength(1);
  expect(requests.filter((call) => call.options.method === 'PUT' && call.path === put[1]!.path)).toHaveLength(2);
});
test('UNCHANGED never extends the original 10s deadline, including network stall at expiry', async () => {
  const first = ready();
  let reads = 0;
  const stall = deferred<unknown>();
  const f = fixture(async (_path, options) => {
    if (options.method === 'PUT') return lease();
    if (options.method === 'DELETE') return undefined;
    if (reads++ === 0) return first;
    if (reads > 4) return stall.promise;
    return { data: { state: 'UNCHANGED', streamId: stream, frameId, expiresAt: first.data.expiresAt }, meta: meta() };
  });
  await vi.advanceTimersByTimeAsync(9999);
  expect(f.latest()?.status).toBe('ready');
  await vi.advanceTimersByTimeAsync(1);
  expect(f.latest()?.status).toBe('waiting');
});
test('expired frame cannot reappear through READY replay with a later invented expiry', async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(12000);
  expect(f.latest()?.status).toBe('waiting');
});
test('WAITING_FRAME clears an existing frame', async () => {
  let reads = 0;
  const f = fixture(async (_path, options) =>
    options.method === 'PUT'
      ? lease()
      : options.method === 'DELETE'
        ? undefined
        : reads++ === 0
          ? ready()
          : { data: { state: 'WAITING_FRAME', streamId: stream }, meta: meta() },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(f.latest()?.status).toBe('ready');
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.latest()?.status).toBe('waiting');
});
test('TTL uses server timestamp minus RTT rather than trusting the local wall-clock offset', async () => {
  const response = ready();
  response.meta.timestamp = new Date(Date.now() + 86400000).toISOString();
  response.data.expiresAt = new Date(Date.now() + 86400000 + 10000).toISOString();
  const pending = deferred<typeof response>();
  let reads = 0;
  const f = fixture(async (_path, options) =>
    options.method === 'PUT'
      ? lease()
      : options.method === 'DELETE'
        ? undefined
        : reads++ === 0
          ? pending.promise
          : deferred<unknown>().promise,
  );
  await vi.advanceTimersByTimeAsync(3000);
  pending.resolve(response);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.latest()?.status).toBe('ready');
  await vi.advanceTimersByTimeAsync(6999);
  expect(f.latest()?.status).toBe('ready');
  await vi.advanceTimersByTimeAsync(1);
  expect(f.latest()?.status).toBe('waiting');
});
test.each([
  new UnauthenticatedError(),
  new ApiClientError(403, 'FORBIDDEN', 'denied'),
  new ApiClientError(404, 'NOT_FOUND', 'missing'),
])('read failure stops viewing, clears frame and releases lease: %s', async (error) => {
  let reads = 0;
  const f = fixture(async (_path, options) => {
    if (options.method === 'PUT') return lease();
    if (options.method === 'DELETE') return undefined;
    if (reads++ === 0) return ready();
    throw error;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.latest()?.status).toBe('ready');
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.latest()).toEqual({ status: 'error', error });
  expect(f.request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  expect(vi.getTimerCount()).toBe(0);
});
test('stalled renewal times out before the 30s lease and clears all old activity', async () => {
  let renewals = 0;
  const pending = deferred<unknown>();
  const f = fixture(async (_path, options) =>
    options.method === 'PUT'
      ? renewals++ === 0
        ? lease()
        : pending.promise
      : options.method === 'DELETE'
        ? undefined
        : ready(),
  );
  await vi.advanceTimersByTimeAsync(22000);
  expect(f.latest()?.status).toBe('recovering');
  expect(f.request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  expect(vi.getTimerCount()).toBe(1);
});
test('stream change on renewal aborts the previous stream and requires a fresh start', async () => {
  let renewals = 0;
  const f = fixture(async (_path, options) =>
    options.method === 'PUT'
      ? { ...lease(), data: { ...lease().data, streamId: renewals++ ? crypto.randomUUID() : stream } }
      : options.method === 'DELETE'
        ? undefined
        : ready(),
  );
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.latest()?.status).toBe('recovering');
  await vi.advanceTimersByTimeAsync(2000);
  const puts = f.request.mock.calls.filter((call) => call[1]?.method === 'PUT');
  expect(puts.at(-1)![0]).not.toBe(puts[0]![0]);
});
test.each(['mime', 'oversized', 'malformed', 'wrong-stream', 'unchanged-without-frame'] as const)(
  'invalid response %s fails closed',
  async (kind) => {
    const f = fixture(async (_path, options) => {
      if (options.method === 'PUT') return lease();
      if (options.method === 'DELETE') return undefined;
      const response = ready();
      if (kind === 'mime') response.data.mimeType = 'image/svg+xml';
      if (kind === 'oversized') response.data.imageBase64 = 'A'.repeat(180000);
      if (kind === 'malformed') response.data.imageBase64 = 'data:image/jpeg;base64,x';
      if (kind === 'wrong-stream') response.data.streamId = crypto.randomUUID();
      if (kind === 'unchanged-without-frame')
        return {
          data: { state: 'UNCHANGED', streamId: stream, frameId, expiresAt: response.data.expiresAt },
          meta: meta(),
        };
      return response;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.latest()?.status).toBe('error');
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each([
  new ApiClientError(409, 'LIVE_VIEWER_EXPIRED', 'expired'),
  new ApiClientError(409, 'LIVE_STREAM_INACTIVE', 'changed'),
  new ApiClientError(429, 'RATE_LIMITED', 'limited'),
  new ApiClientError(503, 'TEMPORARILY_UNAVAILABLE', 'busy'),
  new Error('offline'),
])('transient failure clears the frame, releases old viewer and acquires a different viewer: %s', async (error) => {
  let reads = 0;
  const f = fixture(async (_path, options) => {
    if (options.method === 'PUT') return lease();
    if (options.method === 'DELETE') return undefined;
    if (reads++ === 1) throw error;
    return ready();
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.latest()).toEqual({ status: 'recovering', error, delayMs: 2000 });
  expect(f.request.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  await vi.advanceTimersByTimeAsync(1999);
  expect(f.latest()?.status).toBe('recovering');
  await vi.advanceTimersByTimeAsync(1);
  expect(f.latest()?.status).toBe('ready');
  const puts = f.request.mock.calls.filter((call) => call[1]?.method === 'PUT');
  expect(puts).toHaveLength(2);
  expect(puts[0]![0]).not.toBe(puts[1]![0]);
});
test('retries are bounded even when the network keeps failing; closing cancels backoff', async () => {
  const f = fixture(async (_path, options) => {
    if (options.method === 'DELETE') return;
    throw new Error('offline');
  });
  await vi.advanceTimersByTimeAsync(13999);
  expect(f.latest()).toMatchObject({ status: 'recovering', delayMs: 8000 });
  await vi.advanceTimersByTimeAsync(1);
  expect(f.latest()?.status).toBe('error');
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(4);
  expect(vi.getTimerCount()).toBe(0);
  const g = fixture(async () => {
    throw new Error('offline');
  });
  await vi.advanceTimersByTimeAsync(0);
  g.stop();
  const count = g.request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(g.request).toHaveBeenCalledTimes(count);
});
test('429 Retry-After is honored, including a retained deadline after reopening', async () => {
  let calls = 0;
  const f = fixture(async (_path, options) => {
    if (options.method === 'DELETE') return;
    if (options.method === 'PUT' && calls++ === 0) throw new ApiClientError(429, 'RATE_LIMITED', 'limited', 'r', 15000);
    return options.method === 'PUT' ? lease() : ready();
  });
  await vi.advanceTimersByTimeAsync(14999);
  expect(f.latest()).toMatchObject({ status: 'recovering', delayMs: 15000 });
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.latest()?.status).toBe('ready');
  f.stop();
  const request = vi.fn(async () => lease());
  const stop = startImagePreview({
    api: { request: request as ApiClient['request'] },
    deviceId: 'd',
    clock: () => Date.now(),
    retryNotBefore: Date.now() + 6000,
    onState: () => {},
  });
  stops.push(stop);
  await vi.advanceTimersByTimeAsync(5999);
  expect(request).not.toHaveBeenCalled();
  stop();
  await vi.advanceTimersByTimeAsync(1);
  expect(request).not.toHaveBeenCalled();
});
test('long Retry-After cannot overflow the browser timer into immediate retries', async () => {
  const f = fixture(async (_path, options) => {
    if (options.method !== 'DELETE') throw new ApiClientError(429, 'RATE_LIMITED', 'limited', null, 3_000_000_000);
  });
  await vi.advanceTimersByTimeAsync(2147483647);
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(1);
  expect(f.latest()?.status).toBe('recovering');
});
test('initial lease timeout aborts transport, retries fresh, and compensates only the old late lease', async () => {
  const old = deferred<ReturnType<typeof lease>>();
  let puts = 0;
  const f = fixture(async (_path, options) =>
    options.method === 'PUT'
      ? puts++ === 0
        ? old.promise
        : lease()
      : options.method === 'DELETE'
        ? undefined
        : ready(),
  );
  await vi.advanceTimersByTimeAsync(12000);
  expect(f.latest()).toMatchObject({ status: 'recovering' });
  expect(f.request.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.latest()?.status).toBe('ready');
  const newViewer = f.request.mock.calls.filter((call) => call[1]?.method === 'PUT').at(-1)![0];
  old.resolve(lease());
  await vi.advanceTimersByTimeAsync(0);
  expect(f.latest()?.status).toBe('ready');
  expect(f.request.mock.calls.at(-1)![0]).toContain(viewer);
  expect(f.request.mock.calls.filter((call) => call[0] === newViewer && call[1]?.method === 'DELETE')).toHaveLength(0);
});
test('timed-out GET cannot replace a newer session frame when its transport ignores abort', async () => {
  const old = deferred<ReturnType<typeof ready>>();
  let reads = 0;
  const f = fixture(async (_path, options) =>
    options.method === 'PUT'
      ? lease()
      : options.method === 'DELETE'
        ? undefined
        : reads++ === 0
          ? old.promise
          : ready(),
  );
  await vi.advanceTimersByTimeAsync(14000);
  const newest = f.latest();
  expect(newest?.status).toBe('ready');
  const replay = ready();
  replay.data.imageBase64 = 'AAAA';
  old.resolve(replay);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.latest()).toBe(newest);
});
test('permission revocation during a pending GET aborts it and no late image or retry survives', async () => {
  const old = deferred<ReturnType<typeof ready>>();
  let renewals = 0;
  const f = fixture(async (_path, options) => {
    if (options.method === 'DELETE') return;
    if (options.method === 'PUT') {
      if (renewals++ > 0) throw new ApiClientError(403, 'FORBIDDEN', 'revoked');
      return lease();
    }
    return old.promise;
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.latest()?.status).toBe('error');
  const count = f.request.mock.calls.length;
  old.resolve(ready());
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.latest()?.status).toBe('error');
  expect(f.request).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});
test('response arriving after its 10s lifetime is never published, even if TTL is inflated', async () => {
  const old = deferred<ReturnType<typeof ready>>();
  const response = ready();
  response.data.expiresAt = new Date(Date.now() + 60000).toISOString();
  const f = fixture(async (_path, options) =>
    options.method === 'PUT' ? lease() : options.method === 'DELETE' ? undefined : old.promise,
  );
  await vi.advanceTimersByTimeAsync(10001);
  old.resolve(response);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.states.some((state) => state.status === 'ready')).toBe(false);
  expect(f.latest()).toMatchObject({ status: 'waiting', expired: true });
});
test('lease response beyond its server deadline is rejected before reading', async () => {
  const pending = deferred<ReturnType<typeof lease>>(),
    response = lease();
  response.data.leaseExpiresAt = new Date(Date.now() + 1000).toISOString();
  const f = fixture(async (_path, options) => (options.method === 'PUT' ? pending.promise : undefined));
  await vi.advanceTimersByTimeAsync(1001);
  pending.resolve(response);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.latest()?.status).toBe('recovering');
  expect(f.request.mock.calls.some((call) => !call[1]?.method)).toBe(false);
});
test('expired local lease rejects a late GET even before delayed timers can run', async () => {
  const old = deferred<ReturnType<typeof ready>>();
  const f = fixture(async (_path, options) =>
    options.method === 'PUT' ? lease() : options.method === 'DELETE' ? undefined : old.promise,
  );
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(Date.now() + 31000); // Simulate a suspended event loop using the injected deadline clock.
  old.resolve(ready());
  await vi.advanceTimersByTimeAsync(0);
  expect(f.states.some((state) => state.status === 'ready')).toBe(false);
  expect(f.latest()?.status).toBe('recovering');
});
test('lease deadline aborts a pending renewal before its watchdog and late renewal cannot revive the old viewer', async () => {
  let puts = 0;
  const pending = deferred<ReturnType<typeof lease>>();
  const f = fixture(async (_path, options) => {
    if (options.method === 'DELETE') return;
    if (options.method === 'PUT') {
      if (puts++ > 0) return pending.promise;
      const response = lease();
      response.data.leaseExpiresAt = new Date(Date.now() + 15000).toISOString();
      return response;
    }
    return ready();
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.latest()).toMatchObject({ status: 'recovering' });
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'PUT').at(-1)![1]!.signal!.aborted).toBe(true);
  pending.resolve(lease());
  await vi.advanceTimersByTimeAsync(0);
  expect(f.latest()?.status).toBe('recovering');
  expect(f.request.mock.calls.filter((call) => call[1]?.method === 'DELETE')).toHaveLength(2);
});
test.each([null, { data: null }, { data: { state: 'READY' }, meta: {} }])(
  'malformed response is terminal rather than a retryable transport failure: %s',
  async (response) => {
    const f = fixture(async (_path, options) =>
      options.method === 'PUT' ? lease() : options.method === 'DELETE' ? undefined : response,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.latest()).toMatchObject({
      status: 'error',
      error: expect.objectContaining({ code: 'INVALID_LIVE_IMAGE_RESPONSE' }),
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);
