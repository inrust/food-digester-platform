import { test, assert, vi } from 'vitest';
import { rejects } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Pool } from 'pg';
import { withDataPathTrace } from '@fdp/observability';
import {
  observeContractLoad,
  markContractLoadModelEntry,
  observeContractLoadDriver,
} from '../src/contract-load-observation.js';
import { createPrismaClient } from '../src/client.js';

test('load partitions delayed model entry, planning, driver and result without changing value', async () => {
  let clock = 0;
  const rows: Record<string, unknown>[] = [],
    value = {};
  await withDataPathTrace(
    { gatewayRequestId: 'load' },
    () =>
      observeContractLoad(async () => {
        clock += 7;
        markContractLoadModelEntry('Contract', 'findFirst');
        clock += 31;
        const returned = await observeContractLoadDriver(async () => {
          clock += 13;
          return value;
        }, true);
        clock += 5;
        assert.strictEqual(returned, value);
        return returned;
      }),
    (r) => rows.push(r),
    () => clock,
  );
  assert.deepEqual(
    rows.filter((r) => r.event === 'data-path.phase.completed').map((r) => [r.phase, r.durationMs]),
    [
      ['contract-load-delegate', 7],
      ['contract-load-orm-prepare', 31],
      ['contract-load-driver-query', 13],
      ['contract-load-result', 5],
      ['contract-load', 56],
    ],
  );
  assert.include(rows.at(-1), { modelEntries: 1, driverDispatches: 1, transactional: true });
});

test('concurrent load scopes preserve errors and do not capture unrelated/raw queries', async () => {
  const rows: Record<string, unknown>[] = [],
    failure = new Error('SECRET_SENTINEL');
  const run = (id: string, fail: boolean) =>
    withDataPathTrace(
      { gatewayRequestId: id },
      () =>
        observeContractLoad(async () => {
          markContractLoadModelEntry(undefined, '$queryRaw');
          markContractLoadModelEntry('Contract', 'findFirst');
          await Promise.resolve();
          return observeContractLoadDriver(async () => {
            await Promise.resolve();
            if (fail) throw failure;
            return id;
          }, true);
        }),
      (r) => rows.push(r),
    );
  const results = await Promise.allSettled([run('a', false), run('b', true)]);
  assert.deepEqual(results[0], { status: 'fulfilled', value: 'a' });
  assert.strictEqual((results[1] as PromiseRejectedResult).reason, failure);
  assert.isFalse(JSON.stringify(rows).includes('SECRET_SENTINEL'));
  for (const id of ['a', 'b']) {
    const owned = rows.filter((r) => r.gatewayRequestId === id);
    assert.include(owned.at(-1), { modelEntries: 1, driverDispatches: 1, transactional: true });
    assert.equal(owned.find((r) => r.phase === 'contract-load')?.outcome, id === 'a' ? 'PASS' : 'FAIL');
  }
  const before = rows.length;
  await observeContractLoadDriver(async () => 'outside', false);
  assert.equal(rows.length, before);
});

test('multiple dispatches remain visible and no retry or exception is invented', async () => {
  const rows: Record<string, unknown>[] = [];
  await withDataPathTrace(
    {},
    () =>
      observeContractLoad(async () => {
        markContractLoadModelEntry('Contract', 'findFirst');
        await observeContractLoadDriver(async () => 1, true);
        await observeContractLoadDriver(async () => 2, true);
      }),
    (r) => rows.push(r),
  );
  assert.equal(rows.at(-1)?.driverDispatches, 2);
});

test('real Prisma transaction model query reaches its own adapter and preserves commit/release', async () => {
  const rows: Record<string, unknown>[] = [],
    release = vi.fn();
  const id = '00000000-0000-4000-8000-000000000001';
  const driver = Object.assign(new EventEmitter(), {
    release,
    query: vi.fn(async (config: { text: string }) =>
      config.text.startsWith('SELECT')
        ? { rows: [[id]], fields: [{ name: 'id', dataTypeID: 2950 }], rowCount: 1 }
        : { rows: [], fields: [], rowCount: 0 },
    ),
  });
  const connect = vi.spyOn(Pool.prototype, 'connect').mockResolvedValue(driver as never);
  const rawQuery = vi
    .spyOn(Pool.prototype, 'query')
    .mockResolvedValue({ rows: [[1]], fields: [{ name: 'value', dataTypeID: 23 }], rowCount: 1 } as never);
  const client = createPrismaClient('postgresql://local:local@localhost:5432/test');
  try {
    const row = await withDataPathTrace(
      { gatewayRequestId: 'real-model' },
      async () => {
        assert.deepEqual(await client.$queryRawUnsafe('SELECT 1 AS value'), [{ value: 1 }]);
        return client.$transaction((tx) =>
          observeContractLoad(() => tx.contract.findFirst({ where: { id }, select: { id: true } })),
        );
      },
      (r) => rows.push(r),
    );
    assert.deepEqual(row, { id });
    assert.include(
      rows.find((r) => r.event === 'data-path.contract-load.ownership'),
      {
        modelEntries: 1,
        driverDispatches: 1,
        transactional: true,
      },
    );
    assert.equal(rows.filter((r) => r.phase === 'contract-load-driver-query').length, 1);
    assert.equal(rows.filter((r) => r.phase === 'db-first-query').length, 1);
    assert.equal(connect.mock.calls.length, 1);
    assert.equal(release.mock.calls.length, 1);
    assert.isFalse(JSON.stringify(rows).includes('postgresql'));
    assert.isFalse(JSON.stringify(rows).includes(id));
    const failure = new Error('PRIVATE_AFTER_MODEL');
    await rejects(
      client.$transaction((tx) =>
        observeContractLoad(async () => {
          await tx.contract.findFirst({ where: { id }, select: { id: true } });
          throw failure;
        }),
      ),
      (error) => error === failure,
    );
    assert.equal(release.mock.calls.length, 2);
    assert.isTrue(driver.query.mock.calls.some(([config]) => config.text === 'ROLLBACK'));
  } finally {
    await client.$disconnect();
    connect.mockRestore();
    rawQuery.mockRestore();
  }
});
