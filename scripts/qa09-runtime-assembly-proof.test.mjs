import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeAssemblyPhases } from './qa09-runtime-assembly-proof.mjs';
const rows = () =>
  [
    ['runtime-initialize', 0, 100],
    ['runtime-database-secret', 1, 30],
    ['runtime-license-secret', 2, 35],
    ['runtime-client-construct', 36, 70],
    ['runtime-route-assembly', 70, 99],
  ].map(([phase, a, b]) => ({
    phase,
    lambdaRequestId: 'invocation',
    gatewayRequestId: 'gateway',
    operationId: 'updateContract',
    outcome: 'PASS',
    errorCode: 'NONE',
    includesConnectionWait: false,
    durationMs: b - a,
    startedAt: new Date(a).toISOString(),
    completedAt: new Date(b).toISOString(),
    ...(['runtime-client-construct', 'runtime-route-assembly'].includes(phase)
      ? { processCpuScope: 'PROCESS_ALL_THREADS', processCpuUserUs: 10, processCpuSystemUs: 2 }
      : {}),
  }));
test('runtime assembly has ordered nested CPU intervals without additive initialization totals', () => {
  const p = validateRuntimeAssemblyPhases(rows());
  assert.equal(p.clientConstructMs, 34);
  assert.equal(p.routeAssemblyMs, 29);
  assert.equal(p.postSecretsIntervalMs, 65);
  assert.equal(p.unpartitionedPostSecretsIntervalMs, 2);
  assert.equal(validateRuntimeAssemblyPhases([]), null);
});
test('runtime proof rejects absent, duplicate, failed, foreign IDs, overlap, bad CPU and invalid durations', () => {
  for (const mutate of [
    (r) => r.pop(),
    (r) => r.push({ ...r[3] }),
    (r) => (r[3].outcome = 'FAIL'),
    (r) => (r[3].gatewayRequestId = 'foreign'),
    (r) => (r[3].startedAt = new Date(20).toISOString()),
    (r) => (r[4].completedAt = new Date(101).toISOString()),
    (r) => (r[3].processCpuUserUs = -1),
    (r) => (r[4].processCpuScope = 'JS_THREAD'),
    (r) => (r[3].durationMs = NaN),
  ]) {
    const r = rows();
    mutate(r);
    assert.throws(() => validateRuntimeAssemblyPhases(r));
  }
});
