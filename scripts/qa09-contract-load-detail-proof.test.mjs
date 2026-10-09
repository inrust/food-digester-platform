import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateContractLoadDetail, validateContractAwaitCheckpoint } from './qa09-contract-load-detail-proof.mjs';
import { contractDetailInputs, analyzeContractLoadDetailPair } from './analyze-qa09-contract-load-detail.mjs';
import { validateMatchedColdPair } from './qa09-matched-cold-inputs.mjs';
export function detailFixture() {
  const ids = { lambdaRequestId: 'lambda', gatewayRequestId: 'gateway', operationId: 'updateContract' };
  const phases = [
    ['contract-load', 0, 522, undefined],
    ['contract-load-delegate', 0, 10, 'MODEL_EXTENSION_ENTERED'],
    ['contract-load-orm-prepare', 10, 480, 'DRIVER_DISPATCH'],
    ['contract-load-driver-query', 480, 510, 'OPERATION_SETTLED'],
    ['contract-load-result', 510, 522, 'OPERATION_SETTLED'],
    ['contract-load-orm-submit', 10, 30, 'CALL_RETURNED'],
    ['contract-load-orm-await', 30, 480, 'DRIVER_DISPATCH'],
    ['contract-load-driver-before-pg', 480, 485, 'PG_DISPATCH'],
    ['contract-load-driver-pg', 485, 505, 'PG_SETTLED'],
    ['contract-load-driver-after-pg', 505, 510, 'OPERATION_SETTLED'],
  ].map(([phase, start, end, completionBoundary]) => ({
    ...ids,
    phase,
    startedAt: new Date(start).toISOString(),
    completedAt: new Date(end).toISOString(),
    durationMs: end - start,
    completionBoundary,
    outcome: 'PASS',
    errorCode: 'NONE',
    processCpuScope: 'PROCESS_ALL_THREADS',
    processCpuUserUs: 10,
    processCpuSystemUs: 0,
    includesConnectionWait: ['contract-load', 'contract-load-driver-query', 'contract-load-driver-pg'].includes(phase),
  }));
  return {
    phases,
    ownership: [
      {
        ...ids,
        modelEntries: 1,
        driverDispatches: 1,
        transactional: true,
        detailEnabled: true,
        pgQueries: 1,
        pgSettlements: 1,
      },
    ],
  };
}
test('public child proof retains legacy partition and never implies compiler/server/P95 attribution', () => {
  const { phases, ownership } = detailFixture();
  const p = validateContractLoadDetail(phases, ownership, true);
  assert.equal(p.gate, 'PASS');
  assert.equal(p.windowsMs['contract-load-orm-await'], 450);
  assert.equal(p.compilerOnlyAttribution, false);
  assert.equal(p.serverExecutionIsolated, false);
  assert.equal(p.p95Accepted, false);
  assert.equal(validateContractLoadDetail([], [], false), null);
  assert.throws(() => validateContractLoadDetail([], [], true), /REQUIRED/);
});
for (const [name, mutate] of [
  ['missing', (v) => v.phases.splice(8, 1)],
  ['duplicate', (v) => v.phases.push(v.phases[8])],
  ['foreign', (v) => (v.phases[8].gatewayRequestId = 'other')],
  ['failed', (v) => (v.phases[8].outcome = 'FAIL')],
  ['boundary', (v) => (v.phases[8].completionBoundary = 'OPERATION_SETTLED')],
  ['CPU', (v) => (v.phases[8].processCpuScope = 'PG_SERVER')],
  ['negative CPU', (v) => (v.phases[8].processCpuUserUs = -1)],
  ['fraction', (v) => (v.phases[8].durationMs = 1.5)],
  ['wait', (v) => (v.phases[8].includesConnectionWait = false)],
  ['wrong wait', (v) => (v.phases[7].includesConnectionWait = true)],
  ['gap', (v) => (v.phases[6].startedAt = new Date(36).toISOString())],
  ['overlap', (v) => (v.phases[6].startedAt = new Date(29).toISOString())],
  ['coverage', (v) => (v.phases[6].durationMs = 440)],
  ['invalid time', (v) => (v.phases[9].completedAt = 'bad')],
  ['off', (v) => (v.ownership[0].detailEnabled = false)],
  ['two pg', (v) => (v.ownership[0].pgQueries = 2)],
  ['unsettled', (v) => (v.ownership[0].pgSettlements = 0)],
  ['root', (v) => (v.ownership[0].transactional = false)],
])
  test('detail rejects ' + name, () => {
    const v = detailFixture();
    mutate(v);
    assert.throws(() => validateContractLoadDetail(v.phases, v.ownership, true));
  });
test('fresh planner preserves fixed budget, demands both detail modes, never dispatches', () => {
  const p = contractDetailInputs('a'.repeat(40));
  assert.equal(p.gate, 'PREPARED_OFFLINE_TARGET_NOT_RUN');
  assert.equal(p.requireContractLoadDetail, true);
  assert.equal(p.r0.contractLoadDetail, true);
  assert.equal(p.r1.contractLoadDetail, true);
  const a = { ...p.r0 },
    b = { ...p.r1, contractLoadDetail: false };
  assert.throws(() => validateMatchedColdPair(a, b), /DETAIL_MODE_DRIFT/);
  assert.throws(() => contractDetailInputs('short'));
});
test('legacy manifests cannot be promoted to detailed target proof', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa09-detail-'));
  try {
    const a = join(root, 'a.json'),
      b = join(root, 'b.json');
    writeFileSync(a, '{}');
    writeFileSync(b, '{}');
    assert.throws(() => analyzeContractLoadDetailPair(a, b), /EXPLICIT_DETAIL_MANIFEST/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hosted detail input byte binding is explicit and rejects run, mode, budget, context and hash drift', async () => {
  const { validateContractDetailDeployment } = await import('./qa09-matched-cold-inputs.mjs');
  const fixture = () => {
    const inputs = { ...contractDetailInputs('a'.repeat(40)).r0 };
    return [
      inputs,
      { contractLoadDetail: 'true' },
      {
        gate: 'PASS',
        event: 'workflow_dispatch',
        sourceCommit: inputs.sourceCommit,
        runId: '1',
        engineCpu: true,
        authenticatedPreconnect: true,
        accountReadCandidate: false,
        contractLoadDetail: true,
        rolloutPhase: 'immediate',
        context: {
          enableQa09ContractLoadDetail: true,
          enableQa09EngineCpuDiagnosis: true,
          enableQa09AuthenticatedPreconnect: true,
          enableQa09AccountReadCandidate: false,
          enableQa09Capacity: true,
          enableImmediateCommandPublish: true,
        },
      },
      { runId: '1', bindings: { 'qa09-deployment-inputs.json': 'b'.repeat(64) } },
      'qa09-deployment-inputs.json',
      'b'.repeat(64),
    ];
  };
  validateContractDetailDeployment(...fixture());
  for (const mutate of [
    (v) => delete v[0].contractLoadDetail,
    (v) => (v[1].contractLoadDetail = 'false'),
    (v) => (v[2].event = 'push'),
    (v) => (v[2].sourceCommit = 'c'.repeat(40)),
    (v) => (v[2].runId = '2'),
    (v) => (v[2].contractLoadDetail = false),
    (v) => (v[2].engineCpu = false),
    (v) => (v[2].authenticatedPreconnect = false),
    (v) => (v[2].accountReadCandidate = true),
    (v) => (v[2].rolloutPhase = 'capacity'),
    (v) => (v[2].context.enableQa09ContractLoadDetail = false),
    (v) => (v[2].context.enableQa09Capacity = false),
    (v) => (v[2].context.enableImmediateCommandPublish = false),
    (v) => (v[3].bindings['qa09-deployment-inputs.json'] = 'c'.repeat(64)),
    (v) => (v[5] = 'not-a-hash'),
  ]) {
    const v = fixture();
    mutate(v);
    assert.throws(() => validateContractDetailDeployment(...v));
  }
});

function checkpointFixture() {
  const v = detailFixture(),
    parent = v.phases.find((p) => p.phase === 'contract-load-orm-await');
  v.phases.push(
    {
      ...parent,
      phase: 'contract-load-await-queue',
      completedAt: new Date(35).toISOString(),
      durationMs: 5,
      completionBoundary: 'MICROTASK_CHECKPOINT',
    },
    { ...parent, phase: 'contract-load-await-after-queue', startedAt: new Date(35).toISOString(), durationMs: 445 },
  );
  return v;
}
test('checkpoint splits public await only and rejects legacy target promotion', () => {
  const v = checkpointFixture(),
    proof = validateContractAwaitCheckpoint(v.phases, v.ownership, true);
  assert.equal(proof.gate, 'PASS');
  assert.equal(proof.windowsMs['contract-load-await-after-queue'], 445);
  assert.equal(proof.compilerOnlyAttribution, false);
  assert.equal(proof.p95Accepted, false);
  assert.equal(validateContractAwaitCheckpoint([], [], false), null);
  const old = detailFixture();
  assert.throws(() => validateContractAwaitCheckpoint(old.phases, old.ownership, true), /REQUIRED/);
});
for (const [name, mutate] of [
  ['missing', (v) => v.phases.pop()],
  ['duplicate', (v) => v.phases.push(v.phases.at(-1))],
  ['foreign', (v) => (v.phases.at(-1).lambdaRequestId = 'other')],
  ['failure', (v) => (v.phases.at(-1).outcome = 'FAIL')],
  ['CPU', (v) => (v.phases.at(-1).processCpuScope = 'COMPILER_ONLY')],
  ['negative', (v) => (v.phases.at(-1).processCpuUserUs = -1)],
  ['boundary', (v) => (v.phases.at(-2).completionBoundary = 'DRIVER_DISPATCH')],
  ['wait', (v) => (v.phases.at(-1).includesConnectionWait = true)],
  ['gap', (v) => (v.phases.at(-1).startedAt = new Date(41).toISOString())],
  ['overlap', (v) => (v.phases.at(-1).startedAt = new Date(34).toISOString())],
  ['coverage', (v) => (v.phases.at(-1).durationMs -= 6)],
  ['invalid time', (v) => (v.phases.at(-1).completedAt = 'bad')],
])
  test('checkpoint rejects ' + name, () => {
    const v = checkpointFixture();
    mutate(v);
    assert.throws(() => validateContractAwaitCheckpoint(v.phases, v.ownership, true));
  });
test('await planner holds native candidate off and old manifests cannot satisfy new proof', async () => {
  const { contractAwaitInputs, analyzeContractAwaitPair } = await import('./analyze-qa09-contract-await.mjs');
  const p = contractAwaitInputs('a'.repeat(40));
  assert.equal(p.requireContractAwaitCheckpoint, true);
  assert.equal(p.contractReadCandidate, false);
  assert.equal(p.r0.contractLoadDetail, true);
  assert.equal(p.r1.contractLoadDetail, true);
  assert.equal(p.r0.poolMax, 1);
  const root = mkdtempSync(join(tmpdir(), 'qa09-await-'));
  try {
    const a = join(root, 'a.json'),
      b = join(root, 'b.json');
    writeFileSync(a, '{}');
    writeFileSync(b, '{}');
    assert.throws(() => analyzeContractAwaitPair(a, b), /EXPLICIT_AWAIT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
