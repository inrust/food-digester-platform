import { test } from 'vitest';
import assert from 'node:assert/strict';
import process from 'node:process';
import { withDataPathTrace, captureDataPathBoundary, beginDataPathPhase } from '@fdp/observability';
import {
  observeDatabaseClientPreparation,
  markDatabaseAdapterReady,
  markDatabaseDriverDispatch,
} from '../src/client-preparation.js';
import { validateClientSplitPhases } from '../../../scripts/qa09-client-split-proof.mjs';

for (const delay of [17, 18, 20])
  for (const dispatch of ['synchronous', 'asynchronous'])
    test(`${dispatch} dispatch covers ${delay}ms CPU capture and 20ms logging overhead at shared boundaries`, async () => {
      let tick = 0,
        user = 0;
      const rows = [],
        RealDate = globalThis.Date,
        realCpu = process.cpuUsage;
      globalThis.Date = class extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [tick]));
        }
      };
      process.cpuUsage = () => {
        tick += delay;
        user += delay * 1000;
        return { user, system: 0 };
      };
      try {
        const value = await withDataPathTrace(
          { lambdaRequestId: 'lambda', gatewayRequestId: 'gateway', operationId: 'operation' },
          () =>
            observeDatabaseClientPreparation(async () => {
              markDatabaseAdapterReady();
              if (dispatch === 'asynchronous') await Promise.resolve();
              tick += 7;
              markDatabaseDriverDispatch();
              markDatabaseDriverDispatch();
              return 42;
            }),
          (r) => {
            rows.push(r);
            tick += 20;
          },
          () => tick,
        );
        assert.equal(value, 42);
        const result = validateClientSplitPhases(rows, true);
        assert.equal(result.observerSetupMs, delay);
        assert.equal(result.partitionResidualMs, 0);
        assert.equal(rows.find((r) => r.phase === 'db-client-prepare').startedAt, new RealDate(0).toISOString());
        assert.equal(rows.filter((r) => r.phase === 'db-client-prepare').length, 1);
        assert.equal(
          rows.find((r) => r.phase === 'db-client-prepare').completedAt,
          rows.find((r) => r.phase === 'db-client-await-dispatch').completedAt,
        );
        assert.ok(result.submitMs >= 20, 'setup log cost stays inside submit');
        if (dispatch === 'asynchronous') assert.ok(result.awaitDispatchMs >= 20, 'submit log cost stays inside await');
      } finally {
        process.cpuUsage = realCpu;
        globalThis.Date = RealDate;
      }
    });

test('foreign boundary cannot transplant trace clocks or CPU and repeated finish stays idempotent', () => {
  let boundary;
  const rows = [];
  withDataPathTrace(
    { gatewayRequestId: 'foreign' },
    () => {
      boundary = captureDataPathBoundary();
    },
    undefined,
    () => 9999,
  );
  withDataPathTrace(
    { gatewayRequestId: 'own' },
    () => {
      const finish = beginDataPathPhase('db-client-submit', { processCpu: true, startBoundary: boundary });
      finish(undefined, 'CALL_RETURNED', boundary);
      finish(undefined, 'CALL_RETURNED', boundary);
    },
    (r) => rows.push(r),
    () => 1,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gatewayRequestId, 'own');
  assert.equal(rows[0].durationMs, 0);
});

for (const mode of ['settled', 'sync-failed', 'async-failed'])
  test(`no-driver ${mode} shares final boundary and preserves result/error despite a failing log sink`, async () => {
    const rows = [];
    const original = Error('PRIVATE_INPUT');
    const work = () =>
      observeDatabaseClientPreparation(() => {
        if (mode === 'sync-failed') throw original;
        return mode === 'async-failed' ? Promise.reject(original) : Promise.resolve(42);
      });
    const pending = withDataPathTrace(
      { lambdaRequestId: 'lambda', gatewayRequestId: 'gateway', operationId: 'operation' },
      work,
      (r) => {
        rows.push(r);
        throw Error('sink failure');
      },
    );
    if (mode === 'settled') assert.equal(await pending, 42);
    else await assert.rejects(pending, (e) => e === original);
    const outer = rows.find((r) => r.phase === 'db-client-prepare'),
      wait = rows.find((r) => r.phase === 'db-client-await-dispatch');
    assert.equal(outer.completedAt, wait.completedAt);
    assert.equal(outer.completionBoundary, mode === 'settled' ? 'OPERATION_SETTLED' : 'OPERATION_FAILED');
    assert.ok(
      Math.abs(
        outer.durationMs -
          rows
            .filter((r) =>
              ['db-client-observer-setup', 'db-client-submit', 'db-client-await-dispatch'].includes(r.phase),
            )
            .reduce((sum, r) => sum + r.durationMs, 0),
      ) <= 1,
    );
    assert.throws(() => validateClientSplitPhases(rows, true));
    assert.equal(JSON.stringify(rows).includes('PRIVATE_INPUT'), false);
  });
