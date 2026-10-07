import { rejects } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { assert, test, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { withDataPathTrace } from '@fdp/observability';
import { ObservedPgPool, ObservedPrismaPg } from '../src/observed-pg.js';
import { createPrismaClient } from '../src/client.js';

test('real Prisma engine and pg Pool.query preserve per-request phases and release with a controlled driver client', async () => {
  const release = vi.fn();
  const driver = Object.assign(new EventEmitter(), {
    release,
    query: vi.fn((_config, _values, callback) =>
      callback(undefined, {
        rows: [[1]],
        fields: [{ name: 'value', dataTypeID: 23 }],
        rowCount: 1,
      }),
    ),
  });
  const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation((callback) => {
    callback!(undefined, driver as unknown as PoolClient, release);
  });
  const client = createPrismaClient('postgresql://local:local@localhost:5432/test');
  const rows: Record<string, unknown>[] = [];
  try {
    for (const id of ['first', 'second'])
      await withDataPathTrace(
        { gatewayRequestId: id },
        async () => {
          assert.deepEqual(await client.$queryRawUnsafe('SELECT 1 AS value'), [{ value: 1 }]);
          assert.deepEqual(await client.$queryRawUnsafe('SELECT 1 AS value'), [{ value: 1 }]);
        },
        (r) => rows.push(r),
      );
    for (const id of ['first', 'second'])
      assert.deepEqual(
        rows.filter((r) => r.gatewayRequestId === id).map((r) => r.phase),
        id === 'first'
          ? [
              'db-client-submit',
              'db-adapter-connect',
              'db-client-await-dispatch',
              'db-client-after-adapter',
              'db-client-prepare',
              'db-first-connection',
              'db-first-query',
            ]
          : [
              'db-client-submit',
              'db-client-await-dispatch',
              'db-client-prepare',
              'db-first-connection',
              'db-first-query',
            ],
      );
    assert.equal(release.mock.calls.length, 4);
    assert.equal(connect.mock.calls.length, 4);
    assert.notInclude(JSON.stringify(rows), 'postgresql');
  } finally {
    await client.$disconnect();
    connect.mockRestore();
  }
});

test('checkout promise success/failure preserves client, error and budget without releasing ownership', async () => {
  const pool = new ObservedPgPool({ max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
  const release = vi.fn();
  const client = { release } as unknown as PoolClient;
  const error = new Error('private db credentials');
  const connect = vi
    .spyOn(Pool.prototype, 'connect')
    .mockResolvedValueOnce(client as never)
    .mockRejectedValueOnce(error);
  const rows: Record<string, unknown>[] = [];
  try {
    await withDataPathTrace(
      { gatewayRequestId: 'success' },
      async () => assert.strictEqual(await pool.connect(), client),
      (r) => rows.push(r),
    );
    await withDataPathTrace(
      { gatewayRequestId: 'failure' },
      async () => {
        try {
          await pool.connect();
          assert.fail('expected rejection');
        } catch (e) {
          assert.strictEqual(e, error);
        }
      },
      (r) => rows.push(r),
    );
    assert.equal(connect.mock.calls.length, 2);
    assert.equal(release.mock.calls.length, 0);
    assert.equal(pool.options.max, 1);
    assert.equal(pool.options.connectionTimeoutMillis, 5000);
    assert.deepEqual(
      rows.map((r) => r.outcome),
      ['PASS', 'FAIL'],
    );
    assert.notInclude(JSON.stringify(rows), 'private db credentials');
  } finally {
    connect.mockRestore();
    await pool.end();
  }
});

test('checkout callback preserves release and errors even when a pooled callback settles under another request', async () => {
  const pool = new ObservedPgPool();
  const client = {} as PoolClient,
    release = vi.fn(),
    error = new Error('private pool error');
  const rows: Record<string, unknown>[] = [];
  let settle!: (err: Error | undefined, c: PoolClient | undefined, done: typeof release) => void;
  const connect = vi.spyOn(Pool.prototype, 'connect').mockImplementation((cb) => {
    settle = cb!;
  });
  try {
    for (const failure of [false, true]) {
      const callback = vi.fn();
      withDataPathTrace(
        { gatewayRequestId: failure ? 'failure' : 'success' },
        () => {
          assert.equal(pool.connect(callback), undefined);
        },
        (r) => rows.push(r),
      );
      withDataPathTrace({ gatewayRequestId: 'unrelated' }, () =>
        settle(failure ? error : undefined, failure ? undefined : client, release),
      );
      assert.deepEqual(callback.mock.calls[0], [failure ? error : undefined, failure ? undefined : client, release]);
    }
    assert.equal(release.mock.calls.length, 0);
    assert.deepEqual(
      rows.map((r) => [r.gatewayRequestId, r.outcome]),
      [
        ['success', 'PASS'],
        ['failure', 'FAIL'],
      ],
    );
  } finally {
    connect.mockRestore();
    await pool.end();
  }
});

test('adapter first query logs once per request and disconnect owns each recreated pool', async () => {
  const query = vi.spyOn(Pool.prototype, 'query').mockResolvedValue({ rows: [], fields: [], rowCount: 0 } as never);
  const end = vi.spyOn(Pool.prototype, 'end').mockResolvedValue();
  const factory = new ObservedPrismaPg({ max: 1 });
  const rows: Record<string, unknown>[] = [];
  const sql = { sql: 'SELECT private-value', args: [], argTypes: [] };
  try {
    const a = await factory.connect(),
      b = await factory.connect();
    assert.notStrictEqual(a.underlyingDriver(), b.underlyingDriver());
    assert.instanceOf(a.underlyingDriver(), ObservedPgPool);
    await withDataPathTrace(
      { gatewayRequestId: 'first' },
      async () => {
        await a.queryRaw(sql);
        await a.executeRaw(sql);
      },
      (r) => rows.push(r),
    );
    const failure = new Error('private SQL failure');
    query.mockRejectedValueOnce(failure);
    await withDataPathTrace(
      { gatewayRequestId: 'second' },
      async () => {
        await rejects(() => a.queryRaw(sql));
      },
      (r) => rows.push(r),
    );
    assert.deepEqual(
      rows.map((r) => [r.phase, r.gatewayRequestId, r.outcome]),
      [
        ['db-first-query', 'first', 'PASS'],
        ['db-first-query', 'second', 'FAIL'],
      ],
    );
    assert.notInclude(JSON.stringify(rows), 'private');
    await a.dispose();
    await b.dispose();
    assert.equal(end.mock.calls.length, 2);
  } finally {
    query.mockRestore();
    end.mockRestore();
  }
});
