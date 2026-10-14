import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMinimumGate } from './qa09-a8-minimum-gate.mjs';
test('A8 cannot close a non-A2 required security or browser gap with an A2 deferral', () => {
  const rows = [
    {
      id: 'device.naturalActive',
      status: 'DEFERRED_FROM_MINIMUM_PHASE_NOT_ACCEPTED',
      authorizedExclusion: 'REL-A2-01',
    },
    { id: 'security', status: 'NO_TRUSTED_SIGNED_INVALID_CLAIMS_INPUT' },
    { id: 'browser', status: 'NOT_PROVEN' },
  ];
  assert.equal(summarizeMinimumGate(rows).minimumPhaseAccepted, false);
  assert.deepEqual(summarizeMinimumGate(rows).outstanding, ['security', 'browser']);
  assert.throws(() =>
    summarizeMinimumGate([
      {
        id: 'security',
        status: 'DEFERRED_FROM_MINIMUM_PHASE_NOT_ACCEPTED',
        authorizedExclusion: 'REL-A2-01',
      },
    ]),
  );
});
test('A8 rejects duplicate requirements and HTTP/free-form pass; full/release gates stay separate', () => {
  assert.throws(() => summarizeMinimumGate([{ id: 'x', status: 'PASS', proof: 'HTTP_ONLY' }]));
  assert.throws(() => summarizeMinimumGate([{ id: 'x' }, { id: 'x' }]));
  const r = summarizeMinimumGate([{ id: 'x', status: 'PASS', proof: 'SPECIALIZED_CHECKER_BOUND_CONTENT' }]);
  assert.equal(r.minimumPhaseAccepted, true);
  assert.equal(r.fullQa09Accepted, false);
  assert.equal(r.productionReady, false);
});
