import { assert, test } from 'vitest';
import { withDataPathTrace, beginDataPathPhase } from '@fdp/observability';
import { EntryOutputProbe } from './helpers/contract-entry-output-probe.js';
import { partitionEntryOutput } from '../../../scripts/qa09-contract-entry-output-proof.mjs';
const row = (phase = 'contract-load-result-to-model', gatewayRequestId = 'gateway', lambdaRequestId = 'lambda') => ({
  event: 'data-path.phase.completed',
  phase,
  gatewayRequestId,
  lambdaRequestId,
});
test('disabled public/output prototype returns original values and callback with zero timer/CPU calls', () => {
  const forbidden = () => {
    throw Error('OFF_MUST_NOT_MEASURE');
  };
  const probe = new EntryOutputProbe(false, forbidden, forbidden),
    token = {},
    output = () => token;
  probe.sample('gateway', 'lambda');
  assert.strictEqual(probe.wrapOutput(output), output);
  assert.strictEqual(
    probe.callPublic(() => token),
    token,
  );
  assert.equal(probe.snapshot().intervals.length, 0);
});
test('public synchronous port preserves lazy identity, one invocation and original throw without then consumption', async () => {
  const probe = new EntryOutputProbe(true);
  probe.sample('gateway', 'lambda');
  let calls = 0,
    consumed = 0;
  const value = {},
    lazy = {
      then(resolve: (v: unknown) => void) {
        consumed++;
        resolve(value);
      },
    };
  const pending = probe.callPublic(() => {
    calls++;
    return lazy;
  });
  assert.strictEqual(pending, lazy);
  assert.equal(consumed, 0);
  assert.strictEqual(await pending, value);
  assert.deepEqual([calls, consumed], [1, 1]);
  for (const error of [Error('original'), null, undefined]) {
    let caught = false;
    try {
      probe.callPublic(() => {
        throw error;
      });
    } catch (actual) {
      caught = true;
      assert.strictEqual(actual, error);
    }
    assert.isTrue(caught);
  }
});
test('output returns original bound value; nested delivery is preserved without nested measurement/emission', () => {
  const probe = new EntryOutputProbe(true);
  probe.sample('gateway', 'lambda');
  const token = {},
    receiver = {};
  let calls = 0;
  const output = probe.wrapOutput(
    function (this: unknown, r: Record<string, unknown>) {
      assert.strictEqual(this, receiver);
      calls++;
      if (r.phase === 'contract-load-result-to-model')
        assert.strictEqual(output(row('contract-load-result-after-model')), token);
      return token;
    }.bind(receiver),
  );
  assert.strictEqual(output(row()), token);
  const before = probe.snapshot();
  const after = probe.snapshot();
  assert.deepEqual(after, before);
  assert.equal(calls, 2);
  assert.equal(after.intervals.length, 1);
  assert.equal(after.nestedOutputs, 1);
  assert.equal(after.status, 'REENTRANT');
  assert.equal(after.diagnosticEmissions, 0);
});
test('throwing output is recorded once; original trace catch preserves business result/error and no retry', async () => {
  for (const fail of [false, true]) {
    const probe = new EntryOutputProbe(true);
    probe.sample('gateway', 'lambda');
    let outputs = 0;
    const businessError = Error('business-original'),
      value = {};
    const output = probe.wrapOutput(() => {
      outputs++;
      throw Error('output-original');
    });
    let actual: unknown;
    try {
      actual = await withDataPathTrace(
        { gatewayRequestId: 'gateway', lambdaRequestId: 'lambda' },
        async () => {
          beginDataPathPhase('contract-load-result-to-model')();
          if (fail) throw businessError;
          return value;
        },
        output,
      );
    } catch (error) {
      actual = error;
    }
    assert.strictEqual(actual, fail ? businessError : value);
    assert.equal(outputs, 1);
    assert.equal(probe.snapshot().status, 'OUTPUT_FAILED');
  }
});
test('foreign nested trace is delivered without attribution to outer request; distinct IDs are required', () => {
  const probe = new EntryOutputProbe(true);
  probe.sample('gateway', 'lambda');
  let deliveries = 0;
  const output = probe.wrapOutput(() => {
    deliveries++;
  });
  output(row());
  output(row('contract-load-result-to-model', 'gateway', 'different-lambda'));
  assert.equal(deliveries, 2);
  assert.equal(probe.snapshot().intervals.length, 1);
  assert.equal(probe.snapshot().foreignOutputs, 1);
  assert.equal(probe.snapshot().status, 'FOREIGN_SCOPE');
});
test('64-record reservation includes enclosing public call; overflow still delivers every original output', () => {
  const probe = new EntryOutputProbe(true);
  probe.sample('gateway', 'lambda');
  let deliveries = 0;
  const output = probe.wrapOutput(() => {
    deliveries++;
  });
  probe.callPublic(() => {
    for (let i = 0; i < 65; i++) output(row());
  });
  const snapshot = probe.snapshot(),
    call = snapshot.intervals.find((i) => i.kind === 'PUBLIC_CALL')!;
  assert.equal(deliveries, 65);
  assert.equal(snapshot.intervals.length, 64);
  assert.equal(snapshot.overflow, 2);
  assert.equal(snapshot.status, 'TRUNCATED');
  const p = partitionEntryOutput({
    entryOutput: snapshot,
    spans: [
      {
        phase: 'contract-load-driver-submit',
        sharedEnd: true,
        start: { upper: call.start - 1 },
        end: { lower: call.end + 1 },
      },
    ],
  });
  assert.equal(p.gate, 'EXPECTED_DEGRADED');
  assert.isTrue(p.segments.every((s: any) => s.unattributedWallUs === null));
});
test('phase allowlist stores no payload or private SQL; unknown events remain delivered unmeasured', () => {
  const probe = new EntryOutputProbe(true);
  probe.sample('gateway', 'lambda');
  let calls = 0;
  const output = probe.wrapOutput(() => {
    calls++;
  });
  output({ ...row('PRIVATE_SQL_PHASE'), payload: 'PRIVATE_PAYLOAD' });
  output({ ...row(), payload: 'PRIVATE_PAYLOAD' });
  assert.equal(calls, 2);
  assert.equal(probe.snapshot().intervals.length, 1);
  assert.notInclude(JSON.stringify(probe.snapshot()), 'PRIVATE_PAYLOAD');
  assert.notInclude(JSON.stringify(probe.snapshot()), 'PRIVATE_SQL_PHASE');
});
test('concurrent independent trace owners retain original Promise identity and do not cross-assign outputs', async () => {
  const jobs = ['first', 'second'].map((id) => {
    const probe = new EntryOutputProbe(true);
    probe.sample(id, id + '-lambda');
    const pending = Promise.resolve(id);
    const same = withDataPathTrace(
      { gatewayRequestId: id, lambdaRequestId: id + '-lambda' },
      () => {
        beginDataPathPhase('contract-load-result-to-model')();
        return pending;
      },
      probe.wrapOutput(() => {}),
    );
    assert.strictEqual(same, pending);
    return same.then((value) => ({ value, snapshot: probe.snapshot() })); // Test caller, never inside the probe.
  });
  const receipts = await Promise.all(jobs);
  for (const r of receipts) {
    assert.equal(r.snapshot.requestId, r.value);
    assert.equal(r.snapshot.foreignOutputs, 0);
    assert.equal(r.snapshot.intervals.length, 1);
  }
});

for (const mode of ['clock-before', 'clock-after', 'cpu-before', 'cpu-after', 'invalid-clock'])
  test(`measurement failure ${mode} preserves one original work call and original business error`, () => {
    for (const businessFails of [false, true]) {
      let clocks = 0,
        cpus = 0,
        calls = 0;
      const clock = () => {
        clocks++;
        if ((mode === 'clock-before' && clocks === 1) || (mode === 'clock-after' && clocks === 2))
          throw Error('clock-probe');
        return mode === 'invalid-clock' ? NaN : clocks;
      };
      const cpu = (_start?: NodeJS.CpuUsage) => {
        cpus++;
        if ((mode === 'cpu-before' && cpus === 1) || (mode === 'cpu-after' && cpus === 2)) throw Error('cpu-probe');
        return { user: 1, system: 0 };
      };
      const probe = new EntryOutputProbe(true, clock, cpu);
      probe.sample('gateway', 'lambda');
      const original = Error('business'),
        value = {};
      let actual: unknown;
      try {
        actual = probe.callPublic(() => {
          calls++;
          if (businessFails) throw original;
          return value;
        });
      } catch (error) {
        actual = error;
      }
      assert.strictEqual(actual, businessFails ? original : value);
      assert.equal(calls, 1);
      assert.equal(probe.snapshot().probeFailures, 1);
      assert.equal(probe.snapshot().status, 'PROBE_FAILED');
      const proof = partitionEntryOutput({ entryOutput: probe.snapshot(), spans: [] });
      assert.equal(proof.gate, 'EXPECTED_DEGRADED');
      assert.equal(proof.segments.length, 0);
    }
  });
