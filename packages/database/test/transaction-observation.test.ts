import { rejects } from 'node:assert/strict';
import { assert, test } from 'vitest';
import { withDataPathTrace } from '@fdp/observability';
import { withTransaction, type DbClient } from '../src/transaction.js';

for (const fault of ['none', 'open', 'callback', 'finish'])
  test('observed root transaction preserves ownership and ' + fault + ' outcome', async () => {
    const rows: Record<string, unknown>[] = [];
    const error = Object.assign(new Error('private SQL'), { code: 'VERSION_CONFLICT' });
    let calls = 0,
      callbacks = 0;
    const tx = {};
    const root = {
      $connect() {},
      async $transaction(fn: (t: typeof tx) => Promise<number>, options: unknown) {
        calls++;
        assert.deepEqual(options, { timeout: 3000 });
        if (fault === 'open') throw error;
        const value = await fn(tx);
        if (fault === 'finish') throw error;
        return value;
      },
    } as unknown as DbClient;
    const work = () =>
      withDataPathTrace(
        { gatewayRequestId: 'gw-1' },
        () =>
          withTransaction(
            root,
            async (actual) => {
              callbacks++;
              assert.strictEqual(actual, tx);
              if (fault === 'callback') throw error;
              return 42;
            },
            { timeout: 3000 },
            true,
          ),
        (row) => rows.push(row),
      );
    if (fault === 'none') assert.equal(await work(), 42);
    else await rejects(work(), (e) => e === error);
    assert.equal(calls, 1);
    assert.equal(callbacks, fault === 'open' ? 0 : 1);
    const phase = (p: string) => rows.filter((r) => r.phase === p);
    assert.equal(phase('db-transaction').length, 1);
    assert.equal(phase('db-transaction-open').length, 1);
    assert.equal(phase('db-transaction-open')[0]!.outcome, fault === 'open' ? 'FAIL' : 'PASS');
    assert.equal(phase('db-transaction-finish').length, fault === 'open' ? 0 : 1);
    if (fault === 'callback') assert.equal(phase('db-transaction-callback')[0]!.errorCode, 'VERSION_CONFLICT');
    assert.notInclude(JSON.stringify(rows), 'private SQL');
  });
test('nested transaction remains nested without misleading acquisition or commit logs', async () => {
  const rows: unknown[] = [];
  const tx = {} as DbClient;
  const result = await withDataPathTrace(
    {},
    () =>
      withTransaction(
        tx,
        async (actual) => {
          assert.strictEqual(actual, tx);
          return 9;
        },
        undefined,
        true,
      ),
    (r) => rows.push(r),
  );
  assert.equal(result, 9);
  assert.equal(rows.length, 0);
});
