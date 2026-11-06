/** Propagate the lock lifetime to external I/O; timed-out callbacks must not keep using old authorization. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
const lifetime = new AsyncLocalStorage<{ deadline: number; signal: AbortSignal }>();
export async function withLiveImageIoLifetime<T>(work: () => Promise<T>, transactionTimeoutMs = 10000): Promise<T> {
  const parent = lifetime.getStore();
  if (parent && (parent.signal.aborted || parent.deadline <= performance.now()))
    throw new Error('LIVE_IMAGE_AUTHORIZATION_LIFETIME_ENDED');
  const remaining = Math.max(
    1,
    Math.floor(Math.min(transactionTimeoutMs * 0.8, parent ? parent.deadline - performance.now() : Infinity)),
  );
  const closed = new AbortController();
  return lifetime.run(
    {
      deadline: performance.now() + remaining,
      signal: AbortSignal.any([closed.signal, AbortSignal.timeout(remaining), ...(parent ? [parent.signal] : [])]),
    },
    async () => {
      try {
        return await work();
      } finally {
        closed.abort();
      }
    },
  );
}
/** Undefined only outside a guarded operation (e.g. explicit trusted recovery tooling). */
export function liveImageIoLifetime(): { remainingMs: number; signal: AbortSignal } | undefined {
  const current = lifetime.getStore();
  if (!current) return undefined;
  const remainingMs = current.deadline - performance.now();
  if (current.signal.aborted || remainingMs <= 0) throw new Error('LIVE_IMAGE_AUTHORIZATION_LIFETIME_ENDED');
  return { remainingMs, signal: current.signal };
}
