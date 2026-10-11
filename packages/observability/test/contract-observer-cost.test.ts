import { assert, test, vi } from 'vitest';
import { throws } from 'node:assert/strict';
import { ContractObserverCost } from '../src/contract-observer-cost.js';
import {
  withDataPathTrace,
  beginContractObserverCost,
  recordContractObserverBoundary,
  observeContractPublicCall,
  finishContractObserverCost,
  captureDataPathBoundary,
  beginDataPathPhase,
} from '../src/index.js';
const ids = { gatewayRequestId: 'gateway', lambdaRequestId: 'lambda', operationId: 'updateContract' };
const create = () => {
  let time = 0;
  return { state: new ContractObserverCost(() => ++time), step: () => ++time };
};
for (const error of [Error('original'), null, undefined])
  test(`public bridge retains original synchronous error ${String(error)}`, () => {
    withDataPathTrace(ids, () => {
      const scope = beginContractObserverCost(true);
      throws(
        () =>
          observeContractPublicCall(scope, () => {
            throw error;
          }),
        (e) => e === error,
      );
    });
  });
test('disabled bridge keeps pending/lazy identity with zero diagnostic reads and no summary', () => {
  const clock = vi.fn(() => 0),
    cpu = vi.spyOn(process, 'cpuUsage'),
    rows: unknown[] = [];
  try {
    withDataPathTrace(
      ids,
      () => {
        const scope = beginContractObserverCost(false);
        const lazy = { then: vi.fn() };
        assert.strictEqual(
          observeContractPublicCall(scope, () => lazy),
          lazy,
        );
        recordContractObserverBoundary(scope, 'DRIVER_DISPATCH', undefined);
        finishContractObserverCost(scope, true);
        assert.equal(lazy.then.mock.calls.length, 0);
      },
      (r) => rows.push(r),
      clock,
    );
    assert.equal(clock.mock.calls.length, 0);
    assert.equal(cpu.mock.calls.length, 0);
    assert.equal(rows.length, 0);
  } finally {
    cpu.mockRestore();
  }
});
test('enabled call returns original lazy without consuming it', () => {
  const { state } = create(),
    lazy = { then: vi.fn() };
  assert.strictEqual(
    state.publicCall(() => lazy),
    lazy,
  );
  assert.equal(lazy.then.mock.calls.length, 0);
});
for (const fault of ['clock-before', 'clock-after', 'cpu-before', 'cpu-after', 'invalid-clock', 'invalid-cpu'])
  test(`observer measurement ${fault} never replaces business result/error`, () => {
    for (const fails of [false, true]) {
      let clockCalls = 0,
        cpuCalls = 0,
        calls = 0;
      const clock = () => {
        clockCalls++;
        if (fault === `clock-${clockCalls === 1 ? 'before' : 'after'}`) throw Error('probe');
        return fault === 'invalid-clock' ? NaN : clockCalls;
      };
      const cpu = () => {
        cpuCalls++;
        if (fault === `cpu-${cpuCalls === 1 ? 'before' : 'after'}`) throw Error('probe');
        return { user: fault === 'invalid-cpu' ? NaN : cpuCalls, system: 0 };
      };
      const state = new ContractObserverCost(clock, cpu),
        value = {},
        original = Error('original');
      const work = () => {
        calls++;
        if (fails) throw original;
        return value;
      };
      if (fails)
        throws(
          () => state.publicCall(work),
          (e) => e === original,
        );
      else assert.strictEqual(state.publicCall(work), value);
      assert.equal(calls, 1);
      const summary = state.summary(ids, true);
      assert.equal(summary.status, 'PROBE_FAILED');
      assert.equal(summary.publicOutcome, fails ? 'THREW' : 'RETURNED');
      assert.isAtLeast(summary.probeFailures, 1);
      assert.isTrue(summary.segments.every((s) => s.unattributedWallUs === null));
    }
  });
test('output errors, reentrancy and overflow preserve every original output delivery', () => {
  const { state } = create();
  let delivered = 0;
  state.publicCall(() => {
    for (let i = 0; i < 70; i++) state.output(() => delivered++);
  });
  assert.equal(delivered, 70);
  const s = state.summary(ids, true);
  assert.equal(s.status, 'TRUNCATED');
  assert.equal(s.intervalRecords, 64);
  const nested = create().state;
  assert.equal(
    nested.output(() => nested.output(() => 42)),
    42,
  );
  assert.equal(nested.summary(ids, true).status, 'REENTRANT');
  const fail = create().state,
    error = Error('output');
  throws(
    () =>
      fail.output(() => {
        throw error;
      }),
    (e) => e === error,
  );
  assert.equal(fail.summary(ids, true).status, 'OUTPUT_FAILED');
});
test('opaque bridge preserves original boundaries, one summary and terminal output outside ended window', () => {
  const rows: Record<string, unknown>[] = [],
    clock = (() => {
      let n = 0;
      return () => ++n;
    })();
  withDataPathTrace(
    ids,
    () => {
      const scope = beginContractObserverCost(true);
      const dispatch = captureDataPathBoundary();
      recordContractObserverBoundary(scope, 'DRIVER_DISPATCH', dispatch);
      beginDataPathPhase('contract-load-orm-prepare')();
      const pending = Promise.resolve(42);
      assert.strictEqual(
        observeContractPublicCall(scope, () => pending),
        pending,
      );
      recordContractObserverBoundary(scope, 'ADAPTER_CALL_RETURNED', captureDataPathBoundary());
      const resume = captureDataPathBoundary();
      recordContractObserverBoundary(scope, 'MODEL_EXTENSION_RESUMED', resume);
      beginDataPathPhase('contract-load-result-to-model')();
      recordContractObserverBoundary(scope, 'OPERATION_END', captureDataPathBoundary());
      beginDataPathPhase('contract-load-result-after-model')();
      finishContractObserverCost(scope, true);
      finishContractObserverCost(scope, true);
      assert.isUndefined(beginContractObserverCost(true));
    },
    (r) => rows.push(r),
    clock,
  );
  const summaries = rows.filter((r) => r.event === 'data-path.contract-load.observer-cost');
  assert.equal(summaries.length, 1);
  const s = summaries[0]!;
  assert.equal(s.status, 'COMPLETE');
  assert.equal(s.publicCalls, 1);
  assert.equal(s.outsideOutputs, 1);
  assert.equal(s.gatewayRequestId, 'gateway');
  assert.equal(s.lambdaRequestId, 'lambda');
  assert.isAtMost(Buffer.byteLength(JSON.stringify(s)), 4096);
  assert.isUndefined((s as any).sql);
  assert.isUndefined((s as any).boundary);
});
test('foreign trace/boundary degrades without attributing a child to parent or duplicating summary', () => {
  const rows: Record<string, unknown>[] = [];
  withDataPathTrace(
    ids,
    () => {
      const scope = beginContractObserverCost(true);
      withDataPathTrace({ gatewayRequestId: 'child', lambdaRequestId: 'child-lambda' }, () => {
        recordContractObserverBoundary(scope, 'DRIVER_DISPATCH', captureDataPathBoundary());
        const v = {};
        assert.strictEqual(
          observeContractPublicCall(scope, () => v),
          v,
        );
      });
      finishContractObserverCost(scope, true);
    },
    (r) => rows.push(r),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'FOREIGN_SCOPE');
  assert.equal(rows[0]!.publicCalls, 0);
});
test('missing boundaries, duplicate public ownership and invalid transaction never imply complete proof', () => {
  for (const mode of ['missing', 'duplicate', 'transaction']) {
    const state = create().state;
    state.publicCall(() => 0);
    if (mode === 'duplicate') state.publicCall(() => 0);
    const s = state.summary(ids, mode !== 'transaction');
    assert.notEqual(s.status, 'COMPLETE');
    assert.isTrue(s.segments.every((s) => s.unattributedWallUs === null));
  }
});

test('summary logger failure is attempted once and cannot replace business return or retry', () => {
  let summaries = 0;
  const result = withDataPathTrace(
    ids,
    () => {
      const scope = beginContractObserverCost(true);
      finishContractObserverCost(scope, false);
      finishContractObserverCost(scope, false);
      return 42;
    },
    (row) => {
      if (row.event === 'data-path.contract-load.observer-cost') {
        summaries++;
        throw Error('sink');
      }
    },
  );
  assert.equal(result, 42);
  assert.equal(summaries, 1);
});

test('maximum owner IDs and numeric readings keep summary bounded; opaque snapshots remain private', () => {
  const state = new ContractObserverCost(
    () => 1,
    () => ({ user: 0, system: 0 }),
  );
  for (const point of ['DRIVER_DISPATCH', 'ADAPTER_CALL_RETURNED', 'MODEL_EXTENSION_RESUMED', 'OPERATION_END'] as const)
    state.point(point, 1);
  state.publicCall(() => 0);
  const row = state.summary(
    { gatewayRequestId: 'g'.repeat(128), lambdaRequestId: 'l'.repeat(128), operationId: 'o'.repeat(128) },
    true,
  );
  assert.isAtMost(Buffer.byteLength(JSON.stringify(row)), 4096);
  assert.isUndefined((row as any).points);
  assert.isUndefined((row as any).intervals);
});
