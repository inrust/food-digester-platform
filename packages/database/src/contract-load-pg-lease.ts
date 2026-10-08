import type { PoolClient } from 'pg';
import { beginContractLoadPgQuery } from './contract-load-observation.js';

const leases = new WeakMap<PoolClient, (...args: any[]) => any>();
/** Temporary per-checkout port; no prototype/global patch, no query text/values/result inspection. */
export function attachContractLoadPgLease(client: PoolClient, release: (...args: any[]) => any): typeof release {
  const existing = leases.get(client);
  if (existing) return existing;
  const query = client.query;
  const queryDescriptor = Object.getOwnPropertyDescriptor(client, 'query');
  const releaseDescriptor = Object.getOwnPropertyDescriptor(client, 'release');
  const restore = () => {
    if (client.query === wrappedQuery) {
      if (queryDescriptor) Object.defineProperty(client, 'query', queryDescriptor);
      else delete (client as any).query;
    }
    if (client.release === wrappedRelease) {
      if (releaseDescriptor) Object.defineProperty(client, 'release', releaseDescriptor);
      else delete (client as any).release;
    }
    leases.delete(client);
  };
  function wrappedQuery(this: PoolClient, ...args: any[]): any {
    // Query/submittable or embedded callback configurations are passed through unchanged;
    // the shipped Prisma adapter uses ordinary config + Promise. Missing proof fails the detail Gate.
    if (typeof args[0]?.submit === 'function' || args[0]?.callback !== undefined)
      return Reflect.apply(query, this, args);
    const finish = beginContractLoadPgQuery();
    if (!finish) return Reflect.apply(query, this, args);
    const last = args.length - 1,
      callback = args[last];
    if (typeof callback === 'function')
      args[last] = function (this: unknown, ...values: any[]) {
        finish(values[0] ?? undefined);
        return Reflect.apply(callback, this, values);
      };
    try {
      const result = Reflect.apply(query, this, args);
      if (typeof callback !== 'function' && result instanceof Promise) {
        // Observe settlement without replacing the original Promise or the original rejection.
        void result.then(
          () => finish(),
          (error) => finish(error ?? new Error('PG_QUERY_FAILED')),
        );
      }
      return result;
    } catch (error) {
      finish(error ?? new Error('PG_QUERY_FAILED'));
      throw error;
    }
  }
  function wrappedRelease(this: unknown, ...args: any[]): any {
    restore();
    return Reflect.apply(release, this, args);
  }
  try {
    client.query = wrappedQuery;
    client.release = wrappedRelease;
    leases.set(client, wrappedRelease);
    return wrappedRelease;
  } catch {
    restore();
    return release; // Unsupported property descriptors cannot change a business checkout.
  }
}
