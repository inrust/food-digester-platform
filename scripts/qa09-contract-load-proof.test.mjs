import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContractLoadSplit } from './qa09-contract-load-proof.mjs';
import { summarizeContractLoadRequest } from './analyze-qa09-contract-load.mjs';
function input() {
  const ids = { lambdaRequestId: 'lambda', gatewayRequestId: 'gateway', operationId: 'updateContract' };
  const phases = [
    ['contract-load', 0, 522, undefined],
    ['contract-load-delegate', 0, 10, 'MODEL_EXTENSION_ENTERED'],
    ['contract-load-orm-prepare', 10, 480, 'DRIVER_DISPATCH'],
    ['contract-load-driver-query', 480, 510, 'OPERATION_SETTLED'],
    ['contract-load-result', 510, 522, 'OPERATION_SETTLED'],
  ].map(([phase, s, e, completionBoundary]) => ({
    ...ids,
    phase,
    startedAt: new Date(s).toISOString(),
    completedAt: new Date(e).toISOString(),
    durationMs: e - s,
    completionBoundary,
    outcome: 'PASS',
    errorCode: 'NONE',
    processCpuScope: 'PROCESS_ALL_THREADS',
    processCpuUserUs: 10,
    processCpuSystemUs: 0,
    includesConnectionWait: ['contract-load', 'contract-load-driver-query'].includes(phase),
  }));
  return { phases, ownership: [{ ...ids, modelEntries: 1, driverDispatches: 1, transactional: true }] };
}
test('cold summary requires exact transactional physical proof and never copies payloads', () => {
  const v = input();
  for (const phase of ['admin-account-query', 'admin-account-hook'])
    v.phases.push({ ...v.phases[0], phase, durationMs: 10 });
  const c = {
    requestId: 'gateway',
    status: 409,
    exactLinked: true,
    phases: v.phases,
    contractLoadOwnership: v.ownership,
    lambda: [{ lambdaRequestId: 'lambda', elapsedMs: 1000 }],
    gateway: [{ integrationRequestId: 'lambda' }],
    platformReports: [{ lambdaRequestId: 'lambda', initDurationMs: 100 }],
    sql: 'SECRET_SENTINEL',
  };
  assert.equal(summarizeContractLoadRequest(c).ormPrepareMs, 470);
  assert.equal(JSON.stringify(summarizeContractLoadRequest(c)).includes('SECRET_SENTINEL'), false);
  c.platformReports[0].lambdaRequestId = 'other';
  assert.throws(() => summarizeContractLoadRequest(c), /EXACT_PHYSICAL/);
});
test('strict load split preserves 5ms coverage and only public boundary attribution', () => {
  const { phases, ownership } = input();
  const result = validateContractLoadSplit(phases, ownership, true);
  assert.equal(result.loadMs, 522);
  assert.equal(result.ormPrepareMs, 470);
  assert.equal(result.causalBenefit, 'NOT_ESTABLISHED');
  assert.equal(validateContractLoadSplit([], [], false), null);
  assert.throws(() => validateContractLoadSplit([], [], true), /REQUIRED/);
});
for (const [name, mutate] of [
  ['foreign request', (v) => (v.phases[2].lambdaRequestId = 'other')],
  ['duplicate', (v) => v.phases.push(v.phases[2])],
  ['missing model boundary', (v) => v.phases.splice(2, 1)],
  ['multiple SQL', (v) => (v.ownership[0].driverDispatches = 2)],
  ['root query', (v) => (v.ownership[0].transactional = false)],
  ['duplicate ownership', (v) => v.ownership.push(v.ownership[0])],
  ['CPU attribution', (v) => (v.phases[2].processCpuScope = 'COMPILER')],
  ['boundary guess', (v) => (v.phases[1].completionBoundary = 'CALL_RETURNED')],
  ['gap', (v) => (v.phases[2].startedAt = new Date(16).toISOString())],
  ['overlap', (v) => (v.phases[3].startedAt = new Date(470).toISOString())],
  ['failure', (v) => (v.phases[3].outcome = 'FAIL')],
  ['invalid wait', (v) => (v.phases[3].includesConnectionWait = false)],
])
  test('rejects ' + name, () => {
    const v = input();
    mutate(v);
    assert.throws(() => validateContractLoadSplit(v.phases, v.ownership, true));
  });
