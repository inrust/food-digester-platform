/** One visible page owns one viewer, one renewal chain and one non-overlapping read chain. */
import { CAMERA_INTERACTION_POLICY } from '@fdp/contracts/domain/camera-interaction-policy.js';
import type { LiveReady } from '@fdp/contracts/rest/image-types.js';
import type { ApiClient } from '../../api/http-client.js';
import { ApiClientError, UnauthenticatedError } from '../../api/errors.js';
import { readLatestImage, releaseImageViewer, renewImageViewer } from './live-image-api.js';
const policy = CAMERA_INTERACTION_POLICY.liveImage;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ImagePreviewState =
  | { readonly status: 'connecting' }
  | { readonly status: 'waiting'; readonly expired?: boolean }
  | { readonly status: 'ready'; readonly frame: LiveReady }
  | { readonly status: 'recovering'; readonly error: unknown; readonly delayMs: number }
  | { readonly status: 'error'; readonly error: unknown; readonly exhausted?: boolean };
const invalid = () => new ApiClientError(502, 'INVALID_LIVE_IMAGE_RESPONSE', 'The image preview response is invalid');
interface PreviewOptions {
  readonly api: ApiClient;
  readonly deviceId: string;
  readonly onState: (state: ImagePreviewState) => void;
  readonly viewerId?: string;
  readonly clock?: () => number;
  /** Monotonic deadline retained by the page across hide/show and manual reopen. */
  readonly retryNotBefore?: number;
  readonly onRetryNotBefore?: (deadline: number) => void;
}
export const IMAGE_RECOVERY = { requestTimeoutMs: 12000, retryDelaysMs: [2000, 4000, 8000] } as const;
export function imageErrorReason(error: unknown): string {
  if (error instanceof UnauthenticatedError || (error instanceof ApiClientError && error.status === 401))
    return 'unauthenticated';
  if (error instanceof ApiClientError) {
    if (error.status === 403) return 'forbidden';
    if (error.status === 404) return 'unavailable';
    if (error.status === 429) return 'rateLimited';
    if (error.code === 'LIVE_REQUEST_TIMEOUT') return 'timeout';
    if (error.code === 'LIVE_VIEWER_EXPIRED' || error.code === 'LIVE_STREAM_INACTIVE') return 'expired';
    if (error.status >= 500 && error.code !== 'INVALID_LIVE_IMAGE_RESPONSE') return 'service';
    return 'invalid';
  }
  return error instanceof Error && error.message === 'IMAGE_DECODE_FAILED' ? 'decode' : 'network';
}
/** Recover only transient failures. Every recovery owns a new viewer; retries are bounded per open. */
export function startImagePreview(options: PreviewOptions): () => void {
  const clock = options.clock ?? (() => performance.now());
  let active = true,
    retries = 0,
    stopAttempt: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const begin = () => {
    if (!active) return;
    stopAttempt = startAttempt({
      ...options,
      viewerId: retries === 0 ? (options.viewerId ?? crypto.randomUUID()) : crypto.randomUUID(),
      onState: (state) => {
        if (!active) return;
        if (state.status !== 'error') {
          options.onState(state);
          return;
        }
        const reason = imageErrorReason(state.error);
        const headerDelay = state.error instanceof ApiClientError ? (state.error.retryAfterMs ?? 0) : 0;
        if (headerDelay > 0) options.onRetryNotBefore?.(clock() + headerDelay);
        if (
          !['network', 'timeout', 'service', 'expired', 'rateLimited'].includes(reason) ||
          retries >= IMAGE_RECOVERY.retryDelaysMs.length
        ) {
          options.onState(
            retries >= IMAGE_RECOVERY.retryDelaysMs.length &&
              ['network', 'timeout', 'service', 'expired', 'rateLimited'].includes(reason)
              ? { ...state, exhausted: true }
              : state,
          );
          return;
        }
        const delayMs = Math.max(IMAGE_RECOVERY.retryDelaysMs[retries++]!, headerDelay);
        const deadline = clock() + delayMs;
        options.onRetryNotBefore?.(deadline);
        options.onState({ status: 'recovering', error: state.error, delayMs });
        wait(deadline);
      },
    });
  };
  const wait = (deadline: number) => {
    // Long valid Retry-After values must not overflow setTimeout and trigger an immediate retry.
    timer = setTimeout(
      () => {
        if (!active) return;
        if (clock() < deadline) wait(deadline);
        else begin();
      },
      Math.min(Math.max(0, deadline - clock()), 2147483647),
    );
  };
  if ((options.retryNotBefore ?? 0) > clock()) {
    options.onState({
      status: 'recovering',
      error: new ApiClientError(429, 'RATE_LIMITED', 'Rate limited'),
      delayMs: options.retryNotBefore! - clock(),
    });
    wait(options.retryNotBefore!);
  } else begin();
  return () => {
    active = false;
    clearTimeout(timer);
    stopAttempt?.();
  };
}
function startAttempt(options: PreviewOptions): () => void {
  const { api, deviceId, onState } = options;
  const viewerId = options.viewerId ?? crypto.randomUUID();
  const clock = options.clock ?? (() => performance.now());
  let active = true,
    streamId: string | null = null,
    reading = false,
    leaseDeadline = 0;
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
  async function bounded<T>(operation: Promise<T>, abort: AbortController, compensate = false): Promise<T> {
    if (compensate)
      void operation.then(
        () => {
          if (abort.signal.aborted) release();
        },
        () => {
          if (abort.signal.aborted) release();
        },
      );
    let rejectAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(abort.signal.reason);
      abort.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const watchdog = later(
      () => abort.abort(new ApiClientError(408, 'LIVE_REQUEST_TIMEOUT', 'Preview request timed out')),
      IMAGE_RECOVERY.requestTimeoutMs,
    );
    try {
      return await Promise.race([operation, cancelled]);
    } finally {
      cancel(watchdog);
      if (rejectAbort) abort.signal.removeEventListener('abort', rejectAbort);
    }
  }
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
  const waiting = (expired = false) => {
    cancel(frameTimer);
    frame = null;
    onState({ status: 'waiting', expired });
  };
  async function read() {
    if (!active || !streamId || reading) return;
    if (frame && lastFrame && clock() >= lastFrame.expires) waiting(true);
    reading = true;
    const expectedStream = streamId,
      started = clock(),
      abort = new AbortController();
    requests.add(abort);
    try {
      const response = await bounded(readLatestImage(api, deviceId, viewerId, abort.signal, frame?.frameId), abort);
      if (!active) return;
      if (clock() >= leaseDeadline) throw new ApiClientError(409, 'LIVE_VIEWER_EXPIRED', 'The preview lease expired');
      if (!response?.data || typeof response.meta?.timestamp !== 'string') throw invalid();
      const data = response.data;
      if (data.streamId !== expectedStream) throw invalid();
      if (data.state === 'WAITING_FRAME') waiting();
      else if (data.state === 'UNCHANGED') {
        if (frame && data.frameId === frame.frameId && data.expiresAt === frame.expiresAt) {
          // Never extend the original local deadline on UNCHANGED.
          if (!lastFrame || lastFrame.expires <= clock()) waiting(true);
        } else if (!frame && lastFrame?.id === data.frameId) waiting(true);
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
        if (expires <= clock()) waiting(true);
        else {
          cancel(frameTimer);
          frame = data;
          onState({ status: 'ready', frame: data });
          frameTimer = later(() => waiting(true), expires - clock());
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
      const response = await bounded(renewImageViewer(api, deviceId, viewerId, abort.signal), abort, true);
      if (!active) return;
      if (!response?.data || typeof response.meta?.timestamp !== 'string') throw invalid();
      const lease = response.data;
      if (
        !UUID.test(lease.streamId) ||
        lease.renewAfterSeconds !== policy.renewAfterSeconds ||
        lease.readIntervalMs !== policy.readIntervalMs
      )
        throw invalid();
      const ttl = remaining(lease.leaseExpiresAt, response.meta.timestamp, started, policy.leaseSeconds);
      if (ttl <= 0 || (streamId && (streamId !== lease.streamId || clock() >= leaseDeadline)))
        throw new ApiClientError(409, 'LIVE_VIEWER_EXPIRED', 'The preview lease expired');
      leaseDeadline = clock() + ttl;
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
    } finally {
      requests.delete(abort);
    }
  }
  onState({ status: 'connecting' });
  void renew();
  return stop;
}
