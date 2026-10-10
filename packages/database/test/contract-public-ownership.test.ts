import { assert, test } from 'vitest';
import { rejects, throws } from 'node:assert/strict';
import { withDataPathTrace } from '@fdp/observability';
import { observeDatabaseClientPreparation } from '../src/client-preparation.js';
import {
  observeContractLoad,
  markContractLoadModelEntry,
  observeContractLoadSubmission,
  observeContractLoadDriver,
  beginContractLoadPgQuery,
  captureContractLoadModelResume,
} from '../src/contract-load-observation.js';
import { validateContractPublicBoundaries } from '../../../scripts/qa09-contract-public-proof.mjs';

test('existing await consumes lazy thenable once in first/reused/no-trace branches; observer cannot replace result/error', async () => {
  for (const traced of [false, true]) {
    let calls = 0,
      consumed = 0,
      notified = 0;
    const value = {},
      error = Error('original');
    const run = async () => {
      for (const fail of [false, false, true]) {
        const lazy = {
          then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
            consumed++;
            if (fail) reject(error);
            else resolve(value);
          },
        };
        const work = () => {
          calls++;
          return lazy as unknown as Promise<unknown>;
        };
        const settled = (e?: unknown) => {
          notified++;
          assert.equal(e, fail ? error : undefined);
          throw Error('observer');
        };
        if (fail) await rejects(observeDatabaseClientPreparation(work, settled), (e) => e === error);
        else assert.strictEqual(await observeDatabaseClientPreparation(work, settled), value);
      }
    };
    if (traced) await withDataPathTrace({}, run);
    else await run();
    assert.deepEqual([calls, consumed, notified], [3, 3, 3]);
  }
});
test('submission and enabled pg port preserve original lazy/Promise/callback values and failures', async () => {
  let consumed = 0;
  const lazy = {
      then() {
        consumed++;
      },
    },
    error = Error('original');
  await withDataPathTrace({}, () =>
    observeContractLoad(async () => {
      markContractLoadModelEntry('Contract', 'findFirst', true, true);
      assert.strictEqual(
        observeContractLoadSubmission(() => lazy),
        lazy,
      );
      assert.equal(consumed, 0);
      throws(
        () =>
          observeContractLoadSubmission(() => {
            throw error;
          }),
        (e) => e === error,
      );
    }),
  );

  const { attachContractLoadPgLease } = await import('../src/contract-load-pg-lease.js');
  for (const mode of ['promise', 'callback', 'reject', 'throw']) {
    const rows: Record<string, unknown>[] = [],
      value = {},
      receiver = {},
      token = {},
      error = Error('original');
    let calls = 0,
      releases = 0,
      pending: Promise<unknown> | undefined,
      callbackCalls = 0;
    const original = function (this: unknown, ...args: any[]) {
      calls++;
      assert.strictEqual(this, port);
      if (mode === 'throw') throw error;
      if (mode === 'callback') {
        args.at(-1).call(receiver, null, value);
        return token;
      }
      pending = mode === 'reject' ? Promise.reject(error) : Promise.resolve(value);
      return pending;
    };
    const port = Object.assign(Object.create({ query: original }), {
      release() {
        releases++;
      },
    });
    const release = port.release;
    attachContractLoadPgLease(port, release);
    const job = run(
      'port-' + mode,
      lazyDriver(() => {
        if (mode === 'callback') {
          assert.strictEqual(
            port.query('PRIVATE_SQL', function (this: unknown, e: unknown, v: unknown) {
              assert.strictEqual(this, receiver);
              assert.isNull(e);
              assert.strictEqual(v, value);
              callbackCalls++;
              return value;
            }),
            token,
          );
          return Promise.resolve(value);
        }
        const p = port.query('PRIVATE_SQL');
        assert.strictEqual(p, pending);
        return p;
      }),
      rows,
    );
    if (['reject', 'throw'].includes(mode)) await rejects(job, (e) => e === error);
    else assert.strictEqual(await job, value);
    assert.equal(calls, 1);
    assert.equal(releases, 0);
    assert.equal(callbackCalls, mode === 'callback' ? 1 : 0);
    if (mode === 'promise') assert.equal(proof(rows)?.gate, 'PASS');
    else assert.throws(() => proof(rows));
    port.release();
    assert.equal(releases, 1);
    assert.strictEqual(port.query, original);
    assert.strictEqual(port.release, release);
    assert.isUndefined(Object.getOwnPropertyDescriptor(port, 'query'));
    assert.notInclude(JSON.stringify(rows), 'PRIVATE_SQL');
  }
});
const run = (id: string, work: () => Promise<unknown>, rows: Record<string, unknown>[], loggerCostMs = 0) =>
  withDataPathTrace(
    { gatewayRequestId: id, lambdaRequestId: id, operationId: 'updateContract' },
    () =>
      observeContractLoad(async () => {
        markContractLoadModelEntry('Contract', 'findFirst', true, true);
        const resume = captureContractLoadModelResume('Contract', 'findFirst');
        // work is a lazy thenable: the production wrapper's existing await owns the sole consumption.
        return observeDatabaseClientPreparation(() => observeContractLoadSubmission(work), resume);
      }),
    (row) => {
      const until = performance.now() + loggerCostMs;
      while (performance.now() < until) {
        /* controlled logger overhead */
      }
      rows.push(row);
    },
  );
function lazyDriver(work: () => Promise<unknown>, transactional = true): () => Promise<unknown> {
  return () =>
    ({
      then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
        observeContractLoadDriver(work, transactional).then(resolve, reject);
      },
    }) as unknown as Promise<unknown>;
}
function proof(rows: Record<string, unknown>[]) {
  return validateContractPublicBoundaries(
    rows.filter((r) => r.event === 'data-path.phase.completed'),
    rows.filter((r) => r.event === 'data-path.contract-load.ownership'),
    true,
  );
}
test('concurrent lazy operations retain frame and shared partition coverage even with slow logger; late callback is inert', async () => {
  const rows: Record<string, unknown>[] = [],
    releases: (() => void)[] = [],
    late: (() => void)[] = [];
  const jobs = [0, 1].map((i) =>
    run(
      'owner-' + i,
      lazyDriver(() => {
        const pg = beginContractLoadPgQuery()!;
        pg.returned!();
        return new Promise((resolve) =>
          releases.push(() => {
            pg();
            late.push(pg);
            resolve(i);
          }),
        );
      }),
      rows,
      6,
    ),
  );
  await new Promise((r) => setImmediate(r));
  releases.reverse().forEach((r) => r());
  assert.deepEqual(await Promise.all(jobs), [0, 1]);
  for (const i of [0, 1]) assert.equal(proof(rows.filter((r) => r.gatewayRequestId === 'owner-' + i))?.gate, 'PASS');
  const n = rows.length;
  late.forEach((f) => f());
  assert.equal(rows.length, n);
});
for (const mode of ['root', 'duplicate-pg', 'duplicate-resume', 'sync-pg', 'sync-driver-throw'])
  test(`public ownership rejects ${mode} without replacement, retries or invented child`, async () => {
    const rows: Record<string, unknown>[] = [],
      error = Error('original');
    let calls = 0;
    const job = run(
      mode,
      lazyDriver(() => {
        calls++;
        if (mode === 'sync-driver-throw') throw error;
        const pg = beginContractLoadPgQuery()!;
        if (mode === 'sync-pg') {
          pg();
          pg.returned!();
        } else {
          pg.returned!();
          pg();
          if (mode === 'duplicate-pg') pg();
        }
        if (mode === 'duplicate-resume') captureContractLoadModelResume('Contract', 'findFirst')!();
        return Promise.resolve(42);
      }, mode !== 'root'),
      rows,
    );
    if (mode === 'sync-driver-throw') await rejects(job, (e) => e === error);
    else assert.equal(await job, 42);
    assert.equal(calls, 1);
    assert.throws(() => proof(rows));
    if (mode === 'sync-pg') assert.isFalse(rows.some((r) => r.phase === 'contract-load-pg-await'));
  });

test('enabled factory preserves real Prisma lazy batch and interactive commit/rollback ownership in one pool', async () => {
  const { vi } = await import('vitest');
  const { Pool } = await import('pg');
  const { EventEmitter } = await import('node:events');
  const { Socket } = await import('node:net');
  const { createAdminPreconnectCandidate } = await import('../src/client.js');
  const counts = { checkout: 0, release: 0, begin: 0, commit: 0, rollback: 0, queries: 0, dispose: 0 };
  const pools = new Set<unknown>();
  const driver = Object.assign(new EventEmitter(), {
    release() {
      counts.release++;
    },
    async query(q: { text: string }) {
      const sql = q.text.trim().toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(sql)) counts[sql as 'begin' | 'commit' | 'rollback']++;
      else counts.queries++;
      return { rows: [], fields: [], rowCount: 0 };
    },
  });
  const network = vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => {
    throw Error('NETWORK_FORBIDDEN');
  });
  const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (this: InstanceType<typeof Pool>) {
    pools.add(this);
    assert.equal(this.options.max, 1);
    counts.checkout++;
    return Promise.resolve(driver) as never;
  });
  const end = vi.spyOn(Pool.prototype, 'end').mockImplementation(async () => {
    counts.dispose++;
  });
  vi.stubEnv('FDP_DB_POOL_MAX', '1');
  const owner = createAdminPreconnectCandidate('postgresql://offline:offline@invalid.invalid:1/offline', true, true);
  try {
    assert.throws(
      () => createAdminPreconnectCandidate('postgresql://offline:offline@invalid.invalid:1/offline', false, true),
      /PUBLIC_BOUNDARIES_REQUIRE_DETAIL/,
    );
    const first = owner.client.contract.findFirst(),
      second = owner.client.contract.findFirst();
    assert.equal(counts.checkout, 0);
    assert.equal(counts.queries, 0);
    assert.deepEqual(await owner.client.$transaction([first, second]), [null, null]);
    const error = Error('original');
    await rejects(
      owner.client.$transaction(async (tx) => {
        assert.isNull(await tx.contract.findFirst());
        throw error;
      }),
      (e) => e === error,
    );
    await owner.client.$disconnect();
    assert.deepEqual(counts, { checkout: 2, release: 2, begin: 2, commit: 1, rollback: 1, queries: 3, dispose: 1 });
    assert.equal(pools.size, 1);
    assert.equal(network.mock.calls.length, 0);
  } finally {
    await owner.client.$disconnect();
    connect.mockRestore();
    end.mockRestore();
    network.mockRestore();
    vi.unstubAllEnvs();
  }
});
