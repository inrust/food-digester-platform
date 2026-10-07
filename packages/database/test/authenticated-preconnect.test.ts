import { rejects } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Pool, type PoolClient } from 'pg';
import { assert, test, vi } from 'vitest';
import { withDataPathTrace } from '@fdp/observability';
import { AuthenticatedPreconnect } from '../src/authenticated-preconnect.js';
import { createAdminPreconnectCandidate } from '../src/client.js';
import { ObservedPgPool } from '../src/observed-pg.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

for (const engineFails of [false, true])
  for (const checkoutFails of [false, true])
    test(`both branches settle, original errors/retry: engine=${engineFails}, checkout=${checkoutFails}`, async () => {
      const ownership = new AuthenticatedPreconnect();
      const engine = deferred<void>(),
        checkout = deferred<void>();
      const engineError = Error('engine private'),
        checkoutError = Error('checkout private');
      const pool = { prepareAuthenticatedConnection: vi.fn(() => checkout.promise) };
      let settled = false;
      const first = ownership.prepare(async () => {
        ownership.adapterReady(pool);
        await engine.promise;
      });
      assert.strictEqual(
        ownership.prepare(async () => assert.fail('second engine')),
        first,
      );
      const result = first.then(
        () => {
          settled = true;
          return undefined;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await Promise.resolve();
      await Promise.resolve();
      if (engineFails) engine.reject(engineError);
      else engine.resolve();
      await Promise.resolve();
      await Promise.resolve();
      assert.isFalse(settled);
      if (checkoutFails) checkout.reject(checkoutError);
      else checkout.resolve();
      assert.strictEqual(await result, engineFails ? engineError : checkoutFails ? checkoutError : undefined);
      assert.equal(pool.prepareAuthenticatedConnection.mock.calls.length, 1);
      if (engineFails || checkoutFails) {
        pool.prepareAuthenticatedConnection.mockResolvedValueOnce(undefined);
        await ownership.prepare(async () => {});
        assert.equal(pool.prepareAuthenticatedConnection.mock.calls.length, 2);
      } else {
        await ownership.prepare(async () => assert.fail('cached engine'));
        assert.equal(pool.prepareAuthenticatedConnection.mock.calls.length, 1);
      }
    });

test('engine failure before adapter publication cannot leave a readiness waiter; original error retained', async () => {
  const ownership = new AuthenticatedPreconnect(),
    original = Error('before adapter');
  await rejects(
    ownership.prepare(async () => {
      throw original;
    }),
    /before adapter/,
  );
  await rejects(
    ownership.prepare(async () => {}),
    /PRECONNECT_ADAPTER_NOT_READY/,
  );
});

test('dispose during pending checkout invalidates readiness; recreated pool gets independent preparation', async () => {
  const ownership = new AuthenticatedPreconnect(),
    checkout = deferred<void>();
  const pool = { prepareAuthenticatedConnection: () => checkout.promise };
  const first = ownership.prepare(async () => {
    ownership.adapterReady(pool);
  });
  const result = first.catch((error) => error);
  await Promise.resolve();
  await Promise.resolve();
  ownership.adapterDisposed(pool);
  checkout.resolve();
  assert.equal((await result).message, 'PRECONNECT_GENERATION_INVALIDATED');
  const next = { prepareAuthenticatedConnection: vi.fn().mockResolvedValue(undefined) };
  await ownership.prepare(async () => {
    ownership.adapterReady(next);
  });
  ownership.adapterDisposed(pool); // stale generation cannot dispose next
  await ownership.prepare(async () => assert.fail('next already ready'));
  assert.equal(next.prepareAuthenticatedConnection.mock.calls.length, 1);
});

test('same real Prisma client/adapter pool: no preconnect SQL, independent first checkout, lazy and transaction ownership, reconnect', async () => {
  vi.stubEnv('FDP_DB_POOL_MAX', '1');
  const release = vi.fn();
  const query = vi.fn((_config, _values, callback) => {
    const result = { rows: [[1]], fields: [{ name: 'value', dataTypeID: 23 }], rowCount: 1 };
    if (callback) return callback(undefined, result);
    return Promise.resolve(result);
  });
  const driver = Object.assign(new EventEmitter(), { release, query });
  const pools: Pool[] = [];
  const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (this: Pool, callback) {
    pools.push(this);
    if (callback) return callback(undefined, driver as unknown as PoolClient, release);
    return Promise.resolve(driver as unknown as PoolClient);
  });
  const end = vi.spyOn(Pool.prototype, 'end').mockResolvedValue();
  const { client, prepareAuthenticated } = createAdminPreconnectCandidate(
    'postgresql://unused:unused@localhost/offline',
  );
  const rows: Record<string, unknown>[] = [];
  try {
    const lazy = client.$queryRawUnsafe('SELECT 1 AS value');
    assert.equal(pools.length, 0);
    await withDataPathTrace(
      { gatewayRequestId: 'first' },
      async () => {
        await Promise.all([prepareAuthenticated(), prepareAuthenticated()]);
        assert.equal(pools.length, 1);
        assert.equal(query.mock.calls.length, 0);
        assert.equal(release.mock.calls.length, 1);
        assert.deepEqual(await lazy, [{ value: 1 }]);
        await client.$transaction([client.$queryRawUnsafe('SELECT 1 AS value')]);
        await client.$transaction(async (tx) => tx.$queryRawUnsafe('SELECT 1 AS value'));
      },
      (row) => rows.push(row),
    );
    assert.equal(new Set(pools).size, 1);
    assert.instanceOf(pools[0], ObservedPgPool);
    assert.equal(pools[0].options.max, 1);
    assert.equal(pools[0].options.connectionTimeoutMillis, 5000);
    assert.equal(rows.filter((row) => row.phase === 'db-authenticated-preconnect').length, 1);
    assert.equal(
      rows.find((row) => row.phase === 'db-authenticated-preconnect')?.completionBoundary,
      'OPERATION_SETTLED',
    );
    assert.equal(rows.filter((row) => row.phase === 'db-first-connection').length, 1);
    assert.equal(rows.filter((row) => row.phase === 'db-first-query').length, 1);
    await client.$disconnect();
    await prepareAuthenticated();
    assert.equal(new Set(pools).size, 2);
    assert.equal(end.mock.calls.length, 1);
  } finally {
    await client.$disconnect();
    connect.mockRestore();
    end.mockRestore();
    vi.unstubAllEnvs();
  }
});

test('checkout success releases exactly once; checkout rejection never releases; release failure is propagated', async () => {
  const pool = new ObservedPgPool({ max: 1, connectionTimeoutMillis: 5000 });
  const releaseError = Error('release failed'),
    checkoutError = Error('checkout failed');
  const release = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw releaseError;
    });
  const connect = vi
    .spyOn(Pool.prototype, 'connect')
    .mockResolvedValueOnce({ release } as never)
    .mockRejectedValueOnce(checkoutError)
    .mockResolvedValueOnce({ release } as never);
  try {
    await pool.prepareAuthenticatedConnection();
    await rejects(pool.prepareAuthenticatedConnection(), /checkout failed/);
    await rejects(pool.prepareAuthenticatedConnection(), /release failed/);
    assert.equal(release.mock.calls.length, 2);
  } finally {
    connect.mockRestore();
    await pool.end();
  }
});

test('candidate is rejected outside single pool; ordinary runtime does not call candidate factory', () => {
  vi.stubEnv('FDP_DB_POOL_MAX', '2');
  try {
    assert.throws(() => createAdminPreconnectCandidate('unused'), 'PRECONNECT_REQUIRES_POOL1');
  } finally {
    vi.unstubAllEnvs();
  }
});

test('early checkout failure is observed while engine stays pending; phase fails without claiming business checkout', async () => {
  const ownership = new AuthenticatedPreconnect(),
    engine = deferred<void>();
  const original = Error('private timeout');
  const pool = {
    prepareAuthenticatedConnection: async () => {
      throw original;
    },
  };
  let settled = false;
  const rows: Record<string, unknown>[] = [];
  const result = withDataPathTrace(
    { gatewayRequestId: 'early-failure' },
    async () => {
      try {
        await ownership.prepare(async () => {
          ownership.adapterReady(pool);
          await engine.promise;
        });
      } catch (error) {
        settled = true;
        return error;
      }
    },
    (row) => rows.push(row),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.isFalse(settled);
  assert.equal(rows.find((row) => row.phase === 'db-authenticated-preconnect')?.completionBoundary, 'OPERATION_FAILED');
  assert.isFalse(rows.some((row) => row.phase === 'db-first-connection'));
  assert.notInclude(JSON.stringify(rows), 'private timeout');
  engine.resolve();
  assert.strictEqual(await result, original);
});

test('pool disposal during checkout still releases a late successful client exactly once', async () => {
  const ownership = new AuthenticatedPreconnect(),
    checkout = deferred<PoolClient>();
  const pool = new ObservedPgPool({ max: 1, connectionTimeoutMillis: 5000 });
  const release = vi.fn();
  const connect = vi.spyOn(Pool.prototype, 'connect').mockReturnValue(checkout.promise as never);
  const end = vi.spyOn(Pool.prototype, 'end').mockResolvedValue();
  try {
    const result = ownership
      .prepare(async () => {
        ownership.adapterReady(pool);
      })
      .catch((error) => error);
    await new Promise((resolve) => setImmediate(resolve));
    ownership.adapterDisposed(pool);
    await pool.end();
    checkout.resolve({ release } as unknown as PoolClient);
    assert.equal((await result).message, 'PRECONNECT_GENERATION_INVALIDATED');
    assert.equal(release.mock.calls.length, 1);
  } finally {
    connect.mockRestore();
    end.mockRestore();
  }
});

test('prepared connection loss propagates the original business query failure without SQL retry', async () => {
  vi.stubEnv('FDP_DB_POOL_MAX', '1');
  const release = vi.fn(),
    original = Error('connection lost');
  const query = vi.fn((_config, _values, callback) => callback(original));
  const driver = Object.assign(new EventEmitter(), { release, query });
  const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation((callback) => {
    if (callback) return callback(undefined, driver as unknown as PoolClient, release);
    return Promise.resolve(driver as unknown as PoolClient);
  });
  const end = vi.spyOn(Pool.prototype, 'end').mockResolvedValue();
  const { client, prepareAuthenticated } = createAdminPreconnectCandidate(
    'postgresql://unused:unused@localhost/offline',
  );
  try {
    await prepareAuthenticated();
    assert.equal(query.mock.calls.length, 0);
    await rejects(client.$queryRawUnsafe('SELECT 1 AS value'));
    assert.equal(query.mock.calls.length, 1);
    assert.equal(connect.mock.calls.length, 2);
    assert.equal(release.mock.calls.length, 2);
  } finally {
    await client.$disconnect();
    connect.mockRestore();
    end.mockRestore();
    vi.unstubAllEnvs();
  }
});
