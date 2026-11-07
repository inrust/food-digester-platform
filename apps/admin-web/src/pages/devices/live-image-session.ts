/** One visible page owns one viewer, one renewal chain and one non-overlapping read chain. */
import { CAMERA_INTERACTION_POLICY } from '@fdp/contracts/domain/camera-interaction-policy.js';
import type { LiveReady } from '@fdp/contracts/rest/image-types.js';
import type { ApiClient } from '../../api/http-client.js';
import { ApiClientError } from '../../api/errors.js';
import { readLatestImage, releaseImageViewer, renewImageViewer } from './live-image-api.js';
const policy = CAMERA_INTERACTION_POLICY.liveImage;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ImagePreviewState =
  | { readonly status: 'connecting' | 'waiting' }
  | { readonly status: 'ready'; readonly frame: LiveReady }
  | { readonly status: 'error'; readonly error: unknown };
const invalid = () => new ApiClientError(502, 'INVALID_LIVE_IMAGE_RESPONSE', 'The image preview response is invalid');
export function startImagePreview(options: {
  readonly api: ApiClient;
  readonly deviceId: string;
  readonly onState: (state: ImagePreviewState) => void;
  readonly viewerId?: string;
  readonly clock?: () => number;
}): () => void {
  const { api, deviceId, onState } = options;
  const viewerId = options.viewerId ?? crypto.randomUUID();
  const clock = options.clock ?? (() => performance.now());
  let active = true,
    streamId: string | null = null,
    reading = false;
  let frame: LiveReady | null = null;
  let lastFrame: { id: string; expires: number } | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>(),
    requests = new Set<AbortController>();
  let frameTimer: ReturnType<typeof setTimeout> | undefined, leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (timer: ReturnType<typeof setTimeout> | undefined) => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(timer);
    }
  };
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (active) fn();
    }, ms);
    timers.add(timer);
    return timer;
  };
  // Best effort on close/unload. Unknown in-flight server outcomes remain bounded by the 30s lease.
  const release = () => {
    void releaseImageViewer(api, deviceId, viewerId).catch(() => {});
  };
  const stop = () => {
    if (!active) return;
    active = false;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const request of requests) request.abort();
    requests.clear();
    frame = null;
    lastFrame = null;
    release();
  };
  const fail = (error: unknown) => {
    if (active) {
      stop();
      onState({ status: 'error', error });
    }
  };
  const remaining = (expiresAt: string, serverAt: string, started: number, maxSeconds: number) => {
    const ttl = Date.parse(expiresAt) - Date.parse(serverAt);
    if (!Number.isFinite(ttl)) throw invalid();
    return Math.min(ttl, maxSeconds * 1000) - Math.max(0, clock() - started);
  };
  const waiting = () => {
    cancel(frameTimer);
    frame = null;
    onState({ status: 'waiting' });
  };
  async function read() {
    if (!active || !streamId || reading) return;
    reading = true;
    const expectedStream = streamId,
      started = clock(),
      abort = new AbortController();
    requests.add(abort);
    try {
      const response = await readLatestImage(api, deviceId, viewerId, abort.signal, frame?.frameId);
      if (!active) return;
      const data = response.data;
      if (data.streamId !== expectedStream)
        throw new ApiClientError(409, 'LIVE_STREAM_INACTIVE', 'The preview session changed');
      if (data.state === 'WAITING_FRAME') waiting();
      else if (data.state === 'UNCHANGED') {
        if (frame && data.frameId === frame.frameId && data.expiresAt === frame.expiresAt) {
          // Never extend the original local deadline on UNCHANGED.
          if (!lastFrame || lastFrame.expires <= clock()) waiting();
        } else if (!frame && lastFrame?.id === data.frameId) waiting();
        else throw invalid();
      } else if (data.state === 'READY') {
        if (
          data.mimeType !== 'image/jpeg' ||
          !UUID.test(data.frameId) ||
          !Number.isFinite(Date.parse(data.capturedAt)) ||
          typeof data.imageBase64 !== 'string' ||
          data.imageBase64.length > Math.ceil(policy.maxImageBytes / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.imageBase64) ||
          !data.imageBase64
        )
          throw invalid();
        const decodedBytes =
          (data.imageBase64.length / 4) * 3 -
          (data.imageBase64.endsWith('==') ? 2 : data.imageBase64.endsWith('=') ? 1 : 0);
        if (decodedBytes > policy.maxImageBytes) throw invalid();
        let expires = clock() + remaining(data.expiresAt, response.meta.timestamp, started, policy.frameTtlSeconds);
        if (lastFrame?.id === data.frameId) expires = Math.min(expires, lastFrame.expires);
        lastFrame = { id: data.frameId, expires };
        if (expires <= clock()) waiting();
        else {
          cancel(frameTimer);
          frame = data;
          onState({ status: 'ready', frame: data });
          frameTimer = later(waiting, expires - clock());
        }
      } else throw invalid();
    } catch (error) {
      if (active) fail(error);
    } finally {
      requests.delete(abort);
      reading = false;
      if (active)
        later(() => {
          void read();
        }, policy.readIntervalMs);
    }
  }
  async function renew() {
    if (!active) return;
    const abort = new AbortController(),
      started = clock();
    requests.add(abort);
    try {
      const response = await renewImageViewer(api, deviceId, viewerId, abort.signal);
      if (!active) {
        release();
        return;
      } // Compensate a transport that completed despite abort.
      const lease = response.data;
      if (
        !UUID.test(lease.streamId) ||
        lease.renewAfterSeconds !== policy.renewAfterSeconds ||
        lease.readIntervalMs !== policy.readIntervalMs
      )
        throw invalid();
      const ttl = remaining(lease.leaseExpiresAt, response.meta.timestamp, started, policy.leaseSeconds);
      if (ttl <= 0 || (streamId && streamId !== lease.streamId))
        throw new ApiClientError(409, 'LIVE_VIEWER_EXPIRED', 'The preview lease expired');
      cancel(leaseTimer);
      leaseTimer = later(() => fail(new ApiClientError(409, 'LIVE_VIEWER_EXPIRED', 'The preview lease expired')), ttl);
      const first = streamId === null;
      streamId = lease.streamId;
      if (first) {
        onState({ status: 'waiting' });
        void read();
      }
      later(() => {
        void renew();
      }, lease.renewAfterSeconds * 1000);
    } catch (error) {
      if (active) fail(error);
      else release();
    } finally {
      requests.delete(abort);
    }
  }
  onState({ status: 'connecting' });
  void renew();
  return stop;
}
