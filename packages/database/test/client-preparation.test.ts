import { rejects } from 'node:assert/strict';
import { assert, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Pool, type PoolClient } from 'pg';
import { withDataPathTrace } from '@fdp/observability';
import { createPrismaClient } from '../src/client.js';
import {
  observeDatabaseClientPreparation,
  markDatabaseAdapterReady,
  markDatabaseDriverDispatch,
} from '../src/client-preparation.js';

test('preparation distinguishes driver dispatch, no-driver settlement and original failure without leaking data', async () => {
  const rows: Record<string, unknown>[] = [];
  let tick = 0;
  const trace = (id: string, work: () => Promise<unknown>) =>
    withDataPathTrace(
      { gatewayRequestId: id },
      work,
      (r) => rows.push(r),
      () => tick,
    );
  await trace('dispatch', () =>
    observeDatabaseClientPreparation(async () => {
      tick = 10;
      markDatabaseAdapterReady();
      tick = 90;
      markDatabaseDriverDispatch();
      tick = 150;
      return 42;
    }),
  );
  assert.deepEqual(
    rows.map((r) => [r.phase, r.durationMs, r.completionBoundary]),
    [
      ['db-client-after-adapter', 80, 'DRIVER_DISPATCH'],
      ['db-client-prepare', 90, 'DRIVER_DISPATCH'],
    ],
  );
  await trace('settled', () => observeDatabaseClientPreparation(async () => 42));
  const error = Object.assign(Error('secret SQL password'), { code: 'P2024' });
  await rejects(
    trace('failed', () =>
      observeDatabaseClientPreparation(async () => {
        markDatabaseAdapterReady();
        throw error;
      }),
    ),
    (e) => e === error,
  );
  assert.equal(rows.find((r) => r.gatewayRequestId === 'settled')?.completionBoundary, 'OPERATION_SETTLED');
  assert.equal(rows.find((r) => r.gatewayRequestId === 'failed')?.completionBoundary, 'OPERATION_FAILED');
  assert.notInclude(JSON.stringify(rows), 'secret SQL password');
  const count = rows.length;
  await observeDatabaseClientPreparation(async () => {
    markDatabaseAdapterReady();
    markDatabaseDriverDispatch();
    return 1;
  });
  assert.equal(rows.length, count);
});

test('simultaneous trace preparation remains owned by its operation, with no sibling premature completion', async () => {
  const rows: Record<string, unknown>[] = [];
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const first = withDataPathTrace(
    { gatewayRequestId: 'first' },
    () =>
      observeDatabaseClientPreparation(async () => {
        markDatabaseAdapterReady();
        await hold;
        markDatabaseDriverDispatch();
      }),
    (r) => rows.push(r),
  );
  await withDataPathTrace(
    { gatewayRequestId: 'second' },
    async () => {
      await observeDatabaseClientPreparation(async () => {
        markDatabaseDriverDispatch();
      });
      await observeDatabaseClientPreparation(async () => {
        markDatabaseDriverDispatch();
      });
    },
    (r) => rows.push(r),
  );
  assert.isFalse(rows.some((r) => r.gatewayRequestId === 'first'));
  release();
  await first;
  assert.equal(rows.filter((r) => r.phase === 'db-client-prepare' && r.gatewayRequestId === 'first').length, 1);
  assert.equal(rows.filter((r) => r.phase === 'db-client-prepare' && r.gatewayRequestId === 'second').length, 1);
});

test('same-trace nested extra operation cannot dispatch the outer preparation prematurely', async () => {
  const rows: Record<string, unknown>[] = [];
  await withDataPathTrace(
    {},
    () =>
      observeDatabaseClientPreparation(async () => {
        markDatabaseAdapterReady();
        await observeDatabaseClientPreparation(async () => markDatabaseDriverDispatch());
        assert.equal(rows.length, 0);
        markDatabaseDriverDispatch();
      }),
    (r) => rows.push(r),
  );
  assert.equal(rows.length, 2);
  assert.isTrue(rows.every((r) => r.completionBoundary === 'DRIVER_DISPATCH'));
});

test('public ORM extension preserves lazy batch/interactive transactions, disconnect ownership and query failure', async () => {
  const release = vi.fn();
  const driver = Object.assign(new EventEmitter(), {
    release,
    query: vi.fn((_config, _values, callback?: (error: Error | undefined, value?: unknown) => void) => {
      const result = { rows: [[1]], fields: [{ name: 'value', dataTypeID: 23 }], rowCount: 1 };
      if (callback) return callback(undefined, result);
      return Promise.resolve(result);
    }),
  });
  const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation((callback) => {
    if (callback) return callback(undefined, driver as unknown as PoolClient, release);
    return Promise.resolve(driver as unknown as PoolClient);
  });
  const client = createPrismaClient('postgresql://local:local@localhost:5432/test');
  const rows: Record<string, unknown>[] = [];
  try {
    const query = client.$queryRawUnsafe('SELECT 1 AS value');
    assert.equal(connect.mock.calls.length, 0, 'constructing a PrismaPromise must not eagerly connect');
    await withDataPathTrace(
      { gatewayRequestId: 'batch' },
      async () =>
        assert.deepEqual(await client.$transaction([query, client.$queryRawUnsafe('SELECT 1 AS value')]), [
          [{ value: 1 }],
          [{ value: 1 }],
        ]),
      (r) => rows.push(r),
    );
    await withDataPathTrace(
      { gatewayRequestId: 'interactive' },
      async () =>
        assert.deepEqual(await client.$transaction(async (tx) => tx.$queryRawUnsafe('SELECT 1 AS value')), [
          { value: 1 },
        ]),
      (r) => rows.push(r),
    );
    driver.query.mockImplementationOnce((_config, _values, callback) => {
      const result = { rows: [], fields: [], rowCount: 0 };
      if (callback) return callback(undefined, result);
      return Promise.resolve(result);
    });
    await withDataPathTrace(
      { gatewayRequestId: 'model' },
      async () => assert.equal(await client.user.findFirst({ where: { cognitoSub: 'test-sub' } }), null),
      (r) => rows.push(r),
    );
    assert.equal(
      rows.find((r) => r.gatewayRequestId === 'model' && r.phase === 'db-client-prepare')?.completionBoundary,
      'DRIVER_DISPATCH',
    );
    const beforeInvalid = connect.mock.calls.length;
    await rejects(
      withDataPathTrace(
        { gatewayRequestId: 'invalid' },
        async () => await client.user.findFirst({ where: { privateInvalidField: 'private-value' } } as never),
        (r) => rows.push(r),
      ),
    );
    assert.equal(connect.mock.calls.length, beforeInvalid, 'validation failures must not open a connection');
    assert.equal(
      rows.find((r) => r.gatewayRequestId === 'invalid' && r.phase === 'db-client-prepare')?.completionBoundary,
      'OPERATION_FAILED',
    );
    assert.notInclude(JSON.stringify(rows), 'privateInvalidField');
    driver.query.mockImplementationOnce((_config, _values, callback) => {
      const error = Object.assign(Error('private raw SQL'), { code: 'XX000' });
      if (callback) return callback(error);
      return Promise.reject(error);
    });
    await rejects(
      withDataPathTrace(
        { gatewayRequestId: 'failure' },
        async () => await client.$queryRawUnsafe('SELECT 1 AS value'),
        (r) => rows.push(r),
      ),
    );
    assert.equal(
      rows.find((r) => r.gatewayRequestId === 'failure' && r.phase === 'db-client-prepare')?.outcome,
      'PASS',
      'failure after driver dispatch is not preparation failure',
    );
    assert.equal(rows.find((r) => r.gatewayRequestId === 'failure' && r.phase === 'db-first-query')?.outcome, 'FAIL');
    assert.notInclude(JSON.stringify(rows), 'private raw SQL');
  } finally {
    await client.$disconnect();
    connect.mockRestore();
  }
});

test('public engine diagnostics has no checkout/SQL, then keeps model driver-dispatch phases distinct', async () => {
  const { observeDatabaseEnginePreparation } = await import('../src/client-preparation.js');
  const rows: Record<string, unknown>[] = [];
  const driver = Object.assign(new EventEmitter(), {
    query: vi.fn((_config, _values, callback) => {
      const result = { rows: [], fields: [], rowCount: 0 };
      if (callback) return callback(undefined, result);
      return Promise.resolve(result);
    }),
    release: vi.fn(),
  });
  const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation((callback) => {
    if (callback) return callback(undefined, driver as unknown as PoolClient, driver.release);
    return Promise.resolve(driver as unknown as PoolClient);
  });
  const client = createPrismaClient('postgresql://unused:unused@localhost/never-connect');
  try {
    await withDataPathTrace(
      { gatewayRequestId: 'engine-then-model' },
      async () => {
        await observeDatabaseEnginePreparation(() => client.$connect());
        assert.equal(connect.mock.calls.length, 0);
        assert.equal(driver.query.mock.calls.length, 0);
        assert.equal(await client.user.findFirst({ where: { cognitoSub: 'synthetic' } }), null);
      },
      (r) => rows.push(r),
    );
    assert.equal(connect.mock.calls.length, 1);
    assert.equal(driver.query.mock.calls.length, 1);
    assert.equal(driver.release.mock.calls.length, 1);
    assert.equal(rows.find((r) => r.phase === 'db-engine-after-adapter')?.completionBoundary, 'OPERATION_SETTLED');
    assert.equal(rows.find((r) => r.phase === 'db-client-prepare')?.completionBoundary, 'DRIVER_DISPATCH');
    assert.isFalse(rows.some((r) => r.phase === 'db-client-after-adapter'));
  } finally {
    await client.$disconnect();
    connect.mockRestore();
  }
});
