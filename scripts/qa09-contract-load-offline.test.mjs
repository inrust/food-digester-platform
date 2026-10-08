import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOfflineCase } from './run-qa09-contract-load-offline.mjs';
function phases(index) {
  const ids = {
    lambdaRequestId: `lambda-${index}`,
    gatewayRequestId: `gateway-${index}`,
    operationId: 'updateContract',
  };
  const rows = [
    ['contract-load', 0, 40, undefined],
    ['contract-load-delegate', 0, 1, 'MODEL_EXTENSION_ENTERED'],
    ['contract-load-orm-prepare', 1, 3, 'DRIVER_DISPATCH'],
    ['contract-load-driver-query', 3, 36, 'OPERATION_SETTLED'],
    ['contract-load-result', 36, 40, 'OPERATION_SETTLED'],
  ].map(([phase, s, e, completionBoundary]) => ({
    ...ids,
    event: 'data-path.phase.completed',
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
  rows.push({
    ...ids,
    event: 'data-path.contract-load.ownership',
    modelEntries: 1,
    driverDispatches: 1,
    transactional: true,
  });
  return rows;
}
const fixture = () => ({
  gate: 'PASS',
  source: 'REAL_PRISMA_ADAPTER_CONTROLLED_PG_ONLY',
  case: 'raw-wait',
  accountRaw: true,
  accountMs: 1,
  poolMax: 1,
  targetEquivalent: false,
  compilerOnlyAttribution: false,
  serverExecutionIsolated: false,
  p95Accepted: false,
  fullQa09Accepted: false,
  delayMs: 30,
  resultCpuMs: 0,
  counts: { account: 1, checkout: 4, release: 4, dispose: 1, begin: 3, commit: 3, rollback: 0, contract: 3 },
  samples: Array.from({ length: 3 }, (_, index) => ({
    index,
    firstContractForClient: index === 0,
    expectedFailure: false,
    failure: false,
    phases: phases(index),
    marks: {
      publicQueryEntered: 0,
      publicQueryReturned: 1,
      adapterEntered: 3,
      pgEntered: 4,
      resultReady: 34,
      fieldsRead: 35,
      fieldsReady: 35,
      adapterSettled: 36,
    },
  })),
});
test('driver partition separates controlled wait and result access without causal claims', () => {
  const rows = summarizeOfflineCase(fixture());
  assert.equal(rows[0].durations.controlledPgMs, 30);
  assert.equal(rows[0].durations.adapterTotalMs, 33);
});
for (const [name, change, code] of [
  ['crossed boundary', (v) => (v.samples[0].marks.fieldsRead = 33), 'OFFLINE_BOUNDARY_ORDER'],
  ['nonfinite boundary', (v) => (v.samples[0].marks.resultReady = NaN), 'OFFLINE_BOUNDARY_ORDER'],
  ['missing boundary', (v) => delete v.samples[0].marks.pgEntered, 'OFFLINE_BOUNDARY_ORDER'],
  ['wrong sample order', (v) => (v.samples[1].index = 0), 'OFFLINE_SEQUENCE'],
  ['extra sample', (v) => v.samples.push(v.samples[0]), 'OFFLINE_SAMPLE_BUDGET'],
  ['hidden query retry', (v) => v.counts.contract++, 'OFFLINE_OWNERSHIP'],
  ['unreleased connection', (v) => v.counts.release--, 'OFFLINE_OWNERSHIP'],
  ['extra pool', (v) => (v.poolMax = 2), 'OFFLINE_SCOPE'],
  ['target equivalence', (v) => (v.targetEquivalent = true), 'OFFLINE_SCOPE'],
  ['compiler-only claim', (v) => (v.compilerOnlyAttribution = true), 'OFFLINE_SCOPE'],
  ['server-only claim', (v) => (v.serverExecutionIsolated = true), 'OFFLINE_SCOPE'],
  ['wrong controlled recipe', (v) => (v.delayMs = 132), 'OFFLINE_CONTROL_INPUT'],
  ['wrong account mode', (v) => (v.accountRaw = false), 'OFFLINE_CONTROL_INPUT'],
  ['unproved phases', (v) => (v.samples[0].phases = []), 'CONTRACT_LOAD_SPLIT_REQUIRED'],
])
  test(`reject ${name}`, () => {
    const v = fixture();
    change(v);
    assert.throws(() => summarizeOfflineCase(v), new RegExp(code));
  });
