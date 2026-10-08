import { assert, test } from 'vitest';
import { rejects, strictEqual } from 'node:assert/strict';
import { withDataPathTrace, beginDataPathPhase } from '@fdp/observability';
import type { PoolClient } from 'pg';
import { attachContractLoadPgLease } from '../src/contract-load-pg-lease.js';
import {
  observeContractLoad,
  markContractLoadModelEntry,
  observeContractLoadSubmission,
  observeContractLoadDriver,
} from '../src/contract-load-observation.js';
import { validateContractLoadDetail } from '../../../scripts/qa09-contract-load-detail-proof.mjs';

const trace = (id: string, work: () => Promise<unknown>, rows: Record<string, unknown>[]) =>
  withDataPathTrace({ lambdaRequestId: id, gatewayRequestId: id, operationId: 'updateContract' }, work, (r) =>
    rows.push(r),
  );
async function load(work: () => Promise<unknown>, detailed = true) {
  return observeContractLoad(async () => {
    markContractLoadModelEntry('Contract', 'findFirst', detailed);
    const pending = observeContractLoadSubmission(() => Promise.resolve());
    await pending;
    return observeContractLoadDriver(work, true);
  });
}
function client(query: (...args: any[]) => any) {
  let releases = 0;
  const value = Object.assign(Object.create({ query }), {
    release() {
      releases++;
    },
  }) as PoolClient;
  return { value, releases: () => releases };
}
function proof(rows: Record<string, unknown>[]) {
  return validateContractLoadDetail(
    rows.filter((r) => r.event === 'data-path.phase.completed'),
    rows.filter((r) => r.event === 'data-path.contract-load.ownership'),
    true,
  );
}
test('Promise identity, value, receiver and inherited descriptor survive pg observation and release', async () => {
  const result = {},
    promise = Promise.resolve(result);
  const captured: { receiver?: unknown; argument?: unknown } = {};
  const c = client(function (this: unknown, q: unknown) {
      captured.receiver = this;
      captured.argument = q;
      return promise;
    }),
    original = c.value.query,
    release = c.value.release;
  attachContractLoadPgLease(c.value, c.value.release);
  strictEqual(c.value.query({ text: 'outside' }), promise); // Outside a load: exact return, no settlement observer.
  const rows: Record<string, unknown>[] = [],
    q = { text: 'SECRET_SQL', values: ['SECRET_ARG'] };
  const returned = await trace(
    'promise',
    () =>
      load(() => {
        const p = c.value.query(q);
        strictEqual(p, promise);
        return p;
      }),
    rows,
  );
  strictEqual(returned, result);
  strictEqual(captured.receiver, c.value);
  strictEqual(captured.argument, q);
  assert.equal(proof(rows)?.gate, 'PASS');
  c.value.release();
  strictEqual(c.value.query, original);
  strictEqual(c.value.release, release);
  assert.isUndefined(Object.getOwnPropertyDescriptor(c.value, 'query'));
  assert.equal(c.releases(), 1);
  assert.notInclude(JSON.stringify(rows), 'SECRET');
});
for (const mode of ['string-callback', 'config-callback', 'values-callback'])
  test(`pg ${mode} preserves callback receiver, arguments and return`, async () => {
    const token = {},
      value = {},
      receiver = {},
      c = client((...args: any[]) => {
        args.at(-1).call(receiver, null, value);
        return token;
      });
    const release = attachContractLoadPgLease(c.value, c.value.release),
      rows: Record<string, unknown>[] = [];
    const cb = function (this: unknown, error: unknown, v: unknown) {
      strictEqual(this, receiver);
      assert.isNull(error);
      strictEqual(v, value);
    };
    await trace(
      mode,
      () =>
        load(async () => {
          const args =
            mode === 'string-callback'
              ? ['SECRET_SQL', cb]
              : mode === 'config-callback'
                ? [{ text: 'SECRET_SQL' }, cb]
                : ['SECRET_SQL', ['SECRET_ARG'], cb];
          strictEqual(Reflect.apply(c.value.query, c.value, args), token);
          return value;
        }),
      rows,
    );
    assert.equal(proof(rows)?.gate, 'PASS');
    release(true);
    assert.equal(c.releases(), 1);
  });
for (const mode of ['promise-reject', 'sync-throw', 'callback-error'])
  test(`original ${mode} rejects unchanged without retries or release takeover`, async () => {
    const error = Object.assign(Error('SECRET_ERROR'), { code: '40001' });
    let calls = 0;
    const c = client((...args: any[]) => {
      calls++;
      if (mode === 'sync-throw') throw error;
      if (mode === 'callback-error') {
        args.at(-1)(error);
        return undefined;
      }
      return Promise.reject(error);
    });
    attachContractLoadPgLease(c.value, c.value.release);
    const rows: Record<string, unknown>[] = [];
    await rejects(
      trace(
        mode,
        () =>
          load(() =>
            mode === 'callback-error'
              ? new Promise((_resolve, reject) => c.value.query('SECRET', (e: Error) => reject(e)))
              : c.value.query('SECRET'),
          ),
        rows,
      ),
      (e: unknown) => e === error,
    );
    assert.equal(calls, 1);
    assert.equal(c.releases(), 0);
    assert.throws(() => proof(rows));
    c.value.release();
    assert.equal(c.releases(), 1);
    assert.notInclude(JSON.stringify(rows), 'SECRET');
  });
test('callback observation belongs to origin; the business callback keeps its unrelated context', async () => {
  let callback: (...args: any[]) => unknown = () => {};
  const c = client((...args: any[]) => {
    callback = args.at(-1);
    return undefined;
  });
  attachContractLoadPgLease(c.value, c.value.release);
  const rows: Record<string, unknown>[] = [],
    other: Record<string, unknown>[] = [];
  const pending = trace(
    'owner',
    () =>
      load(
        () =>
          new Promise<void>((resolve) =>
            c.value.query('SECRET', () => {
              beginDataPathPhase('envelope')();
              resolve();
            }),
          ),
      ),
    rows,
  );
  await new Promise((r) => setImmediate(r));
  await trace('unrelated', async () => callback(null, {}), other);
  await pending;
  assert.equal(proof(rows)?.gate, 'PASS');
  assert.isTrue(rows.every((r) => r.gatewayRequestId === 'owner'));
  assert.equal(other.length, 1);
  assert.equal(other[0].gatewayRequestId, 'unrelated');
  c.value.release();
});
test('two clients and concurrent scopes settle independently with exact ownership', async () => {
  const rows: Record<string, unknown>[] = [],
    resolvers: (() => void)[] = [],
    clients = [0, 1].map(() => client(() => new Promise<void>((r) => resolvers.push(r))));
  clients.forEach((c) => attachContractLoadPgLease(c.value, c.value.release));
  const jobs = clients.map((c, i) => trace('owner-' + i, () => load(() => c.value.query('SECRET')), rows));
  await new Promise((r) => setImmediate(r));
  resolvers.reverse().forEach((r) => r());
  await Promise.all(jobs);
  for (const [i, c] of clients.entries()) {
    assert.equal(proof(rows.filter((r) => r.gatewayRequestId === 'owner-' + i))?.gate, 'PASS');
    c.value.release();
    assert.equal(c.releases(), 1);
  }
});
test('default off preserves query Promise and does not emit children even if a leased port exists', async () => {
  const p = Promise.resolve(1),
    c = client(() => p),
    rows: Record<string, unknown>[] = [];
  attachContractLoadPgLease(c.value, c.value.release);
  await trace(
    'off',
    () =>
      load(() => {
        strictEqual(c.value.query('SECRET'), p);
        return p;
      }, false),
    rows,
  );
  assert.isFalse(rows.some((r) => r.phase === 'contract-load-driver-pg'));
  assert.throws(() => proof(rows), /DETAIL_REQUIRED/);
  c.value.release();
});
test('submittable/embedded callback and frozen port pass through; missing pg proof fails closed', async () => {
  for (const q of [{ submit() {} }, { text: 'SECRET', callback() {} }]) {
    const token = {},
      c = client((arg) => {
        strictEqual(arg, q);
        return token;
      }),
      rows: Record<string, unknown>[] = [];
    attachContractLoadPgLease(c.value, c.value.release);
    await trace('unsupported', () => load(async () => Reflect.apply(c.value.query, c.value, [q])), rows);
    assert.throws(() => proof(rows));
    c.value.release();
  }
  const c = client(() => Promise.resolve(1));
  Object.freeze(c.value);
  const release = c.value.release;
  strictEqual(attachContractLoadPgLease(c.value, release), release);
  strictEqual(c.value.release, release);
});
test('duplicate callbacks remain delivered and reject detail ownership, no synthetic callback or retry', async () => {
  let calls = 0;
  const c = client((...args: any[]) => {
      args.at(-1)(null, {});
      args.at(-1)(null, {});
    }),
    rows: Record<string, unknown>[] = [];
  attachContractLoadPgLease(c.value, c.value.release);
  await trace(
    'duplicate',
    () =>
      load(async () =>
        c.value.query('SECRET', () => {
          calls++;
        }),
      ),
    rows,
  );
  assert.equal(calls, 2);
  assert.throws(() => proof(rows), /PG_OWNERSHIP/);
  c.value.release();
});
