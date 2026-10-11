import { assert, test, vi } from 'vitest';
import { rejects, throws } from 'node:assert/strict';
import { ContractObserverCost, type ObserverPoint } from '../src/contract-observer-cost.js';
import {
  withDataPathTrace,
  beginContractObserverCost,
  captureDataPathBoundary,
  recordContractObserverBoundary,
  observeContractPublicCall,
  finishContractObserverCost,
} from '../src/index.js';
const ids = { gatewayRequestId: 'gateway', lambdaRequestId: 'lambda', operationId: 'updateContract' };
const points: [ObserverPoint, number][] = [
  ['CHECKPOINT', 1],
  ['CHECKPOINT_PHASE_READY', 2],
  ['CHECKPOINT_RETURN', 3],
  ['DRIVER_DISPATCH', 4],
  ['PUBLIC_BRIDGE_ENTER', 5],
  ['ADAPTER_CALL_RETURNED', 10],
  ['MODEL_EXTENSION_RESUMED', 11],
  ['OPERATION_END', 12],
];
function create(mutate: (p: typeof points) => void = () => {}) {
  let clock = 5;
  const state = new ContractObserverCost(
    () => ++clock,
    () => ({ user: 0, system: 0 }),
    true,
  );
  const list = points.map((p) => [...p] as [ObserverPoint, number]);
  mutate(list);
  for (const [p, t] of list) state.point(p, t);
  return state;
}
test('owned partitions conserve after-queue and prefix; summary remains opaque/bounded and includes observer overhead', () => {
  const state = create();
  const value = Promise.resolve(42);
  assert.strictEqual(
    state.publicCall(() => value),
    value,
  );
  const row = state.summary(ids, true),
    own = row.ownedBoundaries!;
  assert.equal(row.schemaVersion, 2);
  assert.equal(row.status, 'COMPLETE');
  assert.equal(own.seam, 'SELF_OWNED_CALL_SITES');
  assert.isTrue(own.includesObservationOverhead);
  assert.equal(
    own.segments.slice(0, 3).reduce((n, s) => n + s.wallUs, 0),
    own.afterQueueWallUs,
  );
  assert.equal(
    own.segments.slice(3, 5).reduce((n, s) => n + s.wallUs, 0),
    row.segments[0]!.wallUs,
  );
  assert.isAtMost(Buffer.byteLength(JSON.stringify(row)), 4096);
  assert.isUndefined((row as any).points);
  assert.isUndefined((own as any).cpuUs);
});
for (const point of ['CHECKPOINT', 'CHECKPOINT_PHASE_READY', 'CHECKPOINT_RETURN', 'PUBLIC_BRIDGE_ENTER'] as const) {
  for (const fault of ['missing', 'duplicate', 'reversed', 'invalid'] as const)
    test(`${point} ${fault} fails closed`, () => {
      const state = create((p) => {
        if (fault === 'missing')
          p.splice(
            p.findIndex(([name]) => name === point),
            1,
          );
        if (fault === 'duplicate') p.push([point, 1]);
        if (fault === 'reversed') p.find(([name]) => name === point)![1] = 100;
        if (fault === 'invalid') p.find(([name]) => name === point)![1] = NaN;
      });
      assert.equal(
        state.publicCall(() => 42),
        42,
      );
      const row = state.summary(ids, true);
      assert.equal(row.status, 'MISSING_BOUNDARY');
      assert.isTrue(row.segments.every((s) => s.unattributedWallUs === null));
    });
}
test('new bridge clocks fail safely; lazy ownership and original synchronous error are preserved', () => {
  for (const original of [undefined, null, Error('business')]) {
    const state = new ContractObserverCost(
      () => {
        throw Error('diagnostic');
      },
      process.cpuUsage,
      true,
    );
    let calls = 0;
    state.ownedPoint('PUBLIC_BRIDGE_ENTER');
    throws(
      () =>
        state.publicCall(() => {
          calls++;
          throw original;
        }),
      (e) => e === original,
    );
    assert.equal(calls, 1);
    assert.equal(state.summary(ids, true).status, 'PROBE_FAILED');
  }
  const state = create(),
    lazy = { then: vi.fn() };
  assert.strictEqual(
    state.publicCall(() => lazy),
    lazy,
  );
  assert.equal(lazy.then.mock.calls.length, 0);
});
test('asynchronous rejection identity, invalid ownership and late callbacks never create success', async () => {
  const state = create(),
    error = Error('original'),
    pending = Promise.reject(error);
  assert.strictEqual(
    state.publicCall(() => pending),
    pending,
  );
  await rejects(pending, (e) => e === error);
  const row = state.summary(ids, false);
  assert.equal(row.status, 'OWNERSHIP_INVALID');
  state.ownedPoint('CHECKPOINT');
  state.point('CHECKPOINT', 1000);
  assert.equal(state.summary(ids, false).ownedBoundaries!.afterQueueWallUs, row.ownedBoundaries!.afterQueueWallUs);
});
test('foreign trace, forged boundaries, one summary attempt and sink failure are closed in schema2', () => {
  let calls = 0;
  withDataPathTrace(
    ids,
    () => {
      const scope = beginContractObserverCost(true, true);
      withDataPathTrace({ gatewayRequestId: 'foreign' }, () =>
        recordContractObserverBoundary(scope, 'CHECKPOINT', captureDataPathBoundary()),
      );
      observeContractPublicCall(scope, () => 42);
      finishContractObserverCost(scope, true);
      finishContractObserverCost(scope, true);
    },
    (row) => {
      calls++;
      assert.equal(row.schemaVersion, 2);
      assert.equal(row.status, 'FOREIGN_SCOPE');
      throw Error('sink');
    },
  );
  assert.equal(calls, 1);
});
test('maximum IDs/64 intervals, reentrant and failed outputs preserve original delivery and never exceed bytes', () => {
  const state = create();
  let delivered = 0;
  state.publicCall(() => {
    for (let n = 0; n < 70; n++) state.output(() => delivered++);
  });
  assert.equal(delivered, 70);
  const row = state.summary(
    { gatewayRequestId: 'g'.repeat(128), lambdaRequestId: 'l'.repeat(128), operationId: 'o'.repeat(128) },
    true,
  );
  assert.equal(row.status, 'TRUNCATED');
  assert.equal(row.intervalRecords, 64);
  assert.isAtMost(Buffer.byteLength(JSON.stringify(row)), 4096);
  const nested = create();
  nested.output(() => nested.output(() => 42));
  assert.equal(nested.summary(ids, true).status, 'REENTRANT');
  const failed = create(),
    error = Error('output');
  throws(
    () =>
      failed.output(() => {
        throw error;
      }),
    (e) => e === error,
  );
  assert.equal(failed.summary(ids, true).status, 'OUTPUT_FAILED');
});

test('owned summary disabled mode has zero readings, allocation and output', () => {
  const clock = vi.fn(() => 0),
    cpu = vi.spyOn(process, 'cpuUsage'),
    rows: unknown[] = [];
  try {
    withDataPathTrace(
      ids,
      () => {
        const scope = beginContractObserverCost(false, true),
          lazy = { then: vi.fn() };
        assert.isUndefined(scope);
        recordContractObserverBoundary(scope, 'CHECKPOINT', undefined);
        assert.strictEqual(
          observeContractPublicCall(scope, () => lazy),
          lazy,
        );
        finishContractObserverCost(scope, true);
        assert.equal(lazy.then.mock.calls.length, 0);
      },
      (row) => rows.push(row),
      clock,
    );
    assert.equal(clock.mock.calls.length, 0);
    assert.equal(cpu.mock.calls.length, 0);
    assert.equal(rows.length, 0);
  } finally {
    cpu.mockRestore();
  }
});
