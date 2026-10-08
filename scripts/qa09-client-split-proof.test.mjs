import test from 'node:test';
import assert from 'node:assert/strict';
import { validateClientSplitPhases } from './qa09-client-split-proof.mjs';
const fixture = () =>
  [
    ['db-client-prepare', 0, 722, 'DRIVER_DISPATCH'],
    ['db-client-observer-setup', 0, 0, 'CALL_RETURNED'],
    ['db-client-submit', 0, 2, 'CALL_RETURNED'],
    ['db-client-await-dispatch', 2, 722, 'DRIVER_DISPATCH'],
  ].map(([phase, s, e, completionBoundary]) => ({
    phase,
    startedAt: new Date(s).toISOString(),
    completedAt: new Date(e).toISOString(),
    durationMs: e - s,
    completionBoundary,
    lambdaRequestId: 'lambda',
    gatewayRequestId: 'gateway',
    operationId: 'operation',
    outcome: 'PASS',
    errorCode: 'NONE',
    includesConnectionWait: false,
    processCpuScope: 'PROCESS_ALL_THREADS',
    processCpuUserUs: 40,
    processCpuSystemUs: 5,
  }));
test('partition preserves 722ms without treating CPU as exclusive scheduling or compiler time', () => {
  const x = validateClientSplitPhases(fixture(), true);
  assert.equal(x.submitMs, 2);
  assert.equal(x.awaitDispatchMs, 720);
  assert.equal(x.partitionResidualMs, 0);
  assert.equal(validateClientSplitPhases([], false), null);
  assert.throws(() => validateClientSplitPhases([], true), /REQUIRED/);
});
for (const [name, mutate] of [
  ['missing setup', (p) => p.splice(1, 1)],
  [
    'setup gap',
    (p) => {
      p[2].startedAt = new Date(18).toISOString();
      p[2].completedAt = new Date(20).toISOString();
      p[3].startedAt = new Date(20).toISOString();
      p[3].durationMs = 702;
    },
  ],
  ['setup wrong boundary', (p) => (p[1].completionBoundary = 'DRIVER_DISPATCH')],
  ['missing', (p) => p.pop()],
  ['duplicate', (p) => p.push(p[1])],
  ['foreign', (p) => (p[2].gatewayRequestId = 'other')],
  ['invalid CPU', (p) => (p[3].processCpuUserUs = -1)],
  ['no CPU', (p) => delete p[3].processCpuScope],
  ['wrong boundary', (p) => (p[3].completionBoundary = 'CALL_RETURNED')],
  ['failed', (p) => (p[3].outcome = 'FAIL')],
  ['gap', (p) => (p[3].startedAt = new Date(20).toISOString())],
  ['overlap', (p) => (p[3].startedAt = new Date(1).toISOString())],
  ['fake duration', (p) => (p[3].durationMs = 3)],
  ['connection claim', (p) => (p[3].includesConnectionWait = true)],
])
  test(`split rejects ${name}`, () => {
    const p = fixture();
    mutate(p);
    assert.throws(() => validateClientSplitPhases(p, true));
  });

for (const [outer, startGap, submit, wait] of [
  [737, 17, 20, 699],
  [498, 18, 20, 460],
  [40, 20, 20, 0],
])
  test(`target observer setup gap remains rejected: ${outer}ms/${startGap}ms`, () => {
    const p = fixture().filter((r) => r.phase !== 'db-client-observer-setup');
    p[0].completedAt = new Date(outer).toISOString();
    p[0].durationMs = outer;
    p[1].startedAt = new Date(startGap).toISOString();
    p[1].completedAt = new Date(outer - wait).toISOString();
    p[1].durationMs = submit;
    p[2].startedAt = new Date(outer - wait).toISOString();
    p[2].completedAt = new Date(outer).toISOString();
    p[2].durationMs = wait;
    assert.throws(() => validateClientSplitPhases(p, true), /CLIENT_SPLIT_UNIQUE/);
  });

for (const delay of [17, 18, 20])
  test(`explicit setup covers ${delay}ms without shifting original entrance`, () => {
    const p = fixture();
    p[1].completedAt = new Date(delay).toISOString();
    p[1].durationMs = delay;
    p[2].startedAt = new Date(delay).toISOString();
    p[2].completedAt = new Date(delay + 2).toISOString();
    p[3].startedAt = new Date(delay + 2).toISOString();
    p[3].durationMs -= delay;
    const result = validateClientSplitPhases(p, true);
    assert.equal(result.observerSetupMs, delay);
    assert.equal(result.partitionResidualMs, 0);
  });
