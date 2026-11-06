/** One database barrier for preview readers and every deployed authority writer.
 * Coarse by design in P0: lock ordering is barrier -> device/user row -> DynamoDB.
 */
import { withLiveImageIoLifetime } from './live-image-io.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaClient, Prisma } from './generated/client.js';
import type { DbClient } from './transaction.js';

export const LIVE_IMAGE_AUTHORITY_LOCK = 'fdp:live-image:authority:v1';
export async function lockLiveImageAuthority(tx: DbClient, mode: 'read' | 'write'): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
  const fn = mode === 'read' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock';
  await tx.$queryRawUnsafe(`SELECT ${fn}(hashtextextended($1, 0)) IS NULL AS acquired`, LIVE_IMAGE_AUTHORITY_LOCK);
}

export interface AuthorityMutation {
  readonly model: string;
  readonly operation: string;
  readonly args: readonly unknown[];
}
export interface AuthorityWriterHooks {
  /** Called before SQL; exceptions abort the SQL transaction. Returns a post-commit recheck, never called on rollback. */
  beforeMutation(tx: Prisma.TransactionClient, mutation: AuthorityMutation): Promise<(() => Promise<void>) | undefined>;
}
type Callable = (...args: unknown[]) => unknown;
type Dynamic = Record<string, Callable | object>;
const authorityClients = new WeakMap<object, PrismaClient>();
export function withLiveImageReadTransaction<T>(
  client: DbClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const raw = authorityClients.get(client) ?? client;
  if (!('$connect' in raw)) throw new Error('LIVE_IMAGE_READ_REQUIRES_ROOT_CLIENT');
  return withLiveImageIoLifetime(() =>
    (raw as PrismaClient).$transaction(
      async (tx) => {
        await lockLiveImageAuthority(tx, 'read');
        return work(tx);
      },
      { timeout: 10000, maxWait: 1000 },
    ),
  );
}
const MUTATIONS = /^(create|update|upsert|delete)/;

/** Lazy queries preserve array transactions: no SQL may escape before $transaction. */
export function withLiveImageAuthorityWriters(client: PrismaClient, hooks: AuthorityWriterHooks): PrismaClient {
  type Context = { tx: Prisma.TransactionClient; after: Array<() => Promise<void>> };
  const context = new AsyncLocalStorage<Context>();
  const queries = new WeakMap<object, (ctx: Context) => Promise<unknown>>();
  const raw = client as unknown as Dynamic;
  const inTransaction = async (work: (ctx: Context) => Promise<unknown>, options?: unknown) => {
    const existing = context.getStore();
    if (existing) return work(existing);
    const after: Array<() => Promise<void>> = [];
    const value = await withLiveImageIoLifetime(
      () =>
        client.$transaction(
          async (tx) => {
            await lockLiveImageAuthority(tx, 'write');
            const ctx = { tx, after };
            return context.run(ctx, () => work(ctx));
          },
          options as { timeout?: number; maxWait?: number } | undefined,
        ),
      (options as { timeout?: number } | undefined)?.timeout ?? 5000,
    );
    // SQL has committed. Failure here leaves the fence closed; it must not be reported as a SQL rollback.
    for (const recheck of after) await recheck();
    return value;
  };
  const wrap = (target: Dynamic): Dynamic =>
    new Proxy(target, {
      get(object, property) {
        if (typeof property !== 'string') return Reflect.get(object, property);
        if (property === '$extends') throw new Error('AUTHORITY_CLIENT_EXTENSION_FORBIDDEN');
        if (property === '$transaction')
          return (input: unknown, options?: unknown) =>
            inTransaction(async (ctx) => {
              if (typeof input === 'function') return input(wrap(ctx.tx as unknown as Dynamic));
              if (!Array.isArray(input) || input.some((q: object) => !queries.has(q)))
                throw new Error('FOREIGN_TRANSACTION_QUERY');
              const results: unknown[] = [];
              for (const q of input) results.push(await queries.get(q)!(ctx));
              return results;
            }, options);
        const value = object[property];
        if (value && typeof value === 'object' && !property.startsWith('$')) {
          return new Proxy(value, {
            get(delegate, operation) {
              const method = Reflect.get(delegate, operation);
              if (typeof method !== 'function' || typeof operation !== 'string') return method;
              return (...args: unknown[]) => lazy(property, operation, args, MUTATIONS.test(operation));
            },
          });
        }
        if (typeof value === 'function' && /^\$(queryRaw|executeRaw)/.test(property)) {
          return (...args: unknown[]) =>
            lazy('', property, args, property.startsWith('$executeRaw') || !isReadSql(args[0]));
        }
        if (typeof value === 'function') return value.bind(object);
        return value;
      },
    });
  function isReadSql(sql: unknown): boolean {
    const text =
      typeof sql === 'string' ? sql : ((sql as { sql?: string })?.sql ?? (Array.isArray(sql) ? sql.join('?') : ''));
    // Raw writes / CTEs are conservatively authority writes. All SQL remains parameterized by Prisma.
    const withoutRowLock = text.replace(/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/gi, '');
    return /^\s*SELECT\b/i.test(withoutRowLock) && !/\b(insert|update|delete|call)\b/i.test(withoutRowLock);
  }
  function lazy(model: string, operation: string, args: unknown[], mutation: boolean) {
    const execute = async (ctx: Context): Promise<unknown> => {
      if (mutation) {
        const after = await hooks.beforeMutation(ctx.tx, { model, operation, args });
        if (after) ctx.after.push(after);
      }
      const tx = ctx.tx as unknown as Dynamic;
      const delegate = model ? (tx[model] as Dynamic) : tx;
      return (delegate[operation] as Callable)(...args);
    };
    let promise: Promise<unknown> | undefined;
    const run = () =>
      (promise ??= context.getStore()
        ? execute(context.getStore()!)
        : mutation
          ? inTransaction(execute)
          : Promise.resolve(
              (model ? ((raw[model] as Dynamic)[operation] as Callable) : (raw[operation] as Callable))(...args),
            ));
    const query = {
      then: (...a: Parameters<Promise<unknown>['then']>) => run().then(...a),
      catch: (...a: Parameters<Promise<unknown>['catch']>) => run().catch(...a),
      finally: (...a: Parameters<Promise<unknown>['finally']>) => run().finally(...a),
      [Symbol.toStringTag]: 'PrismaPromise',
    };
    queries.set(query, execute);
    return query;
  }
  const wrapped = wrap(raw) as unknown as PrismaClient;
  authorityClients.set(wrapped, client);
  return wrapped;
}
