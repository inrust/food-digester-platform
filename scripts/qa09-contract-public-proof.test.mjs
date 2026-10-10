import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateContractPublicBoundaries } from './qa09-contract-public-proof.mjs';
import { contractPublicInputs, analyzeContractPublicPair } from './analyze-qa09-contract-public.mjs';
import { validateMatchedColdPair, validateContractPublicDeployment } from './qa09-matched-cold-inputs.mjs';
function detailFixture() {
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

function fixture() {
  const v = detailFixture(),
    base = v.phases[0];
  const children = [
    ['contract-load-await-queue', 30, 35, 'MICROTASK_CHECKPOINT', false],
    ['contract-load-await-after-queue', 35, 480, 'DRIVER_DISPATCH', false],
    ['contract-load-driver-submit', 480, 486, 'ADAPTER_CALL_RETURNED', false],
    ['contract-load-driver-await', 486, 510, 'OPERATION_SETTLED', true],
    ['contract-load-pg-submit', 485, 486, 'PG_CALL_RETURNED', false],
    ['contract-load-pg-await', 486, 505, 'PG_SETTLED', true],
    ['contract-load-result-to-model', 510, 520, 'MODEL_EXTENSION_RESUMED', false],
    ['contract-load-result-after-model', 520, 522, 'OPERATION_SETTLED', false],
  ];
  for (const [phase, start, end, completionBoundary, includesConnectionWait] of children)
    v.phases.push({
      ...base,
      phase,
      startedAt: new Date(start).toISOString(),
      completedAt: new Date(end).toISOString(),
      durationMs: end - start,
      completionBoundary,
      includesConnectionWait,
    });
  Object.assign(v.ownership[0], {
    publicBoundariesEnabled: true,
    driverReturns: 1,
    pgReturns: 1,
    modelResumes: 1,
    modelResumeObserved: true,
  });
  return v;
}
test('public partitions and required absence remain strict; no compiler/server/P95 claim', () => {
  const v = fixture(),
    r = validateContractPublicBoundaries(v.phases, v.ownership, true);
  assert.equal(r.gate, 'PASS');
  assert.equal(r.afterQueueAttribution, 'UNRESOLVED_NO_STABLE_COMPILER_SEAM');
  assert.equal(r.p95Accepted, false);
  assert.equal(r.serverExecutionIsolated, false);
  assert.equal(validateContractPublicBoundaries([], []), null);
  assert.throws(() => validateContractPublicBoundaries([], [], true), /REQUIRED/);
});
for (const [name, mutate] of [
  ['missing', (v) => v.phases.pop()],
  ['duplicate', (v) => v.phases.push(v.phases.at(-1))],
  ['foreign', (v) => (v.phases.at(-1).lambdaRequestId = 'foreign')],
  ['failure', (v) => (v.phases.at(-1).outcome = 'FAIL')],
  ['boundary', (v) => (v.phases.at(-1).completionBoundary = 'DRIVER_DISPATCH')],
  ['cpu', (v) => (v.phases.at(-1).processCpuScope = 'SERVER')],
  ['negative', (v) => (v.phases.at(-1).processCpuUserUs = -1)],
  ['fraction', (v) => (v.phases.at(-1).durationMs = 1.5)],
  ['wait', (v) => (v.phases.at(-1).includesConnectionWait = true)],
  ['gap', (v) => (v.phases.at(-1).startedAt = new Date(526).toISOString())],
  ['overlap', (v) => (v.phases.at(-1).startedAt = new Date(519).toISOString())],
  ['coverage', (v) => (v.phases.at(-1).durationMs = 20)],
  ['time', (v) => (v.phases.at(-1).completedAt = 'bad')],
  ['off', (v) => (v.ownership[0].publicBoundariesEnabled = false)],
  ['model unsupported', (v) => (v.ownership[0].modelResumeObserved = false)],
  ['driver duplicate', (v) => (v.ownership[0].driverReturns = 2)],
  ['pg missing', (v) => (v.ownership[0].pgReturns = 0)],
  ['model duplicate', (v) => (v.ownership[0].modelResumes = 2)],
  ['root', (v) => (v.ownership[0].transactional = false)],
])
  test('public rejects ' + name, () => {
    const v = fixture();
    mutate(v);
    assert.throws(() => validateContractPublicBoundaries(v.phases, v.ownership, true));
  });
test('planner binds both public modes to fixed budget; legacy manifests cannot upgrade', () => {
  const p = contractPublicInputs('a'.repeat(40));
  assert.equal(p.requireContractPublicBoundaries, true);
  for (const u of [p.r0, p.r1]) {
    assert.equal(u.contractPublicBoundaries, true);
    assert.equal(u.poolMax, 1);
    assert.equal(u.memoryMiB, 512);
    assert.equal(u.reservedConcurrency, 12);
  }
  assert.equal(p.restore.contractPublicBoundaries, false);
  assert.equal(p.contractReadCandidate, false);
  assert.throws(() => contractPublicInputs('short'));
  assert.throws(() => validateMatchedColdPair(p.r0, { ...p.r1, contractPublicBoundaries: false }), /PUBLIC_MODE_DRIFT/);
  const dir = mkdtempSync(join(tmpdir(), 'qa09-public-'));
  try {
    const a = join(dir, 'a.json');
    writeFileSync(a, '{}');
    assert.throws(() => analyzeContractPublicPair(a, a), /EXPLICIT_PUBLIC/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('new public deployed proof cannot infer old missing fields as true', () => {
  const inputs = contractPublicInputs('a'.repeat(40)).r0;
  const fixture = () => [
    inputs,
    { contractLoadDetail: 'true', contractPublicBoundaries: 'true' },
    {
      gate: 'PASS',
      event: 'workflow_dispatch',
      sourceCommit: inputs.sourceCommit,
      runId: '1',
      engineCpu: true,
      authenticatedPreconnect: true,
      accountReadCandidate: false,
      contractLoadDetail: true,
      contractPublicBoundaries: true,
      rolloutPhase: 'immediate',
      context: {
        enableQa09ContractLoadDetail: true,
        enableQa09ContractPublicBoundaries: true,
        enableQa09EngineCpuDiagnosis: true,
        enableQa09AuthenticatedPreconnect: true,
        enableQa09AccountReadCandidate: false,
        enableQa09Capacity: true,
        enableImmediateCommandPublish: true,
      },
    },
    { runId: '1', bindings: { 'inputs.json': 'b'.repeat(64) } },
    'inputs.json',
    'b'.repeat(64),
  ];
  validateContractPublicDeployment(...fixture());
  for (const mutate of [
    (v) => (v[0] = { ...v[0], contractPublicBoundaries: undefined }),
    (v) => (v[1].contractPublicBoundaries = 'false'),
    (v) => delete v[2].contractPublicBoundaries,
    (v) => (v[2].context.enableQa09ContractPublicBoundaries = false),
    (v) => (v[3].bindings['inputs.json'] = 'c'.repeat(64)),
  ]) {
    const v = fixture();
    mutate(v);
    assert.throws(() => validateContractPublicDeployment(...v));
  }
});

test('public matrix summary rejects ownership/scope/control/trace tampering without executing runner', async () => {
  const { summarizePublicCase } = await import('./run-qa09-contract-public-runtime.mjs');
  const make = () => ({
    kind: 'qa09-runtime-public-seams/v1',
    gate: 'PASS',
    case: 'on',
    source: 'REAL_PRISMA_CONTROLLED_PG_NO_NETWORK',
    enabled: true,
    forcedYields: 0,
    native: false,
    accountNative: true,
    poolMax: 1,
    targetEquivalent: false,
    compilerOnlyAttribution: false,
    p95Accepted: false,
    fullQa09Accepted: false,
    auditReturnProjection: 'ID_ONLY_OFFLINE',
    delayMs: 0,
    resultCpuMs: 0,
    counts: {
      pools: 1,
      network: 0,
      account: 1,
      checkout: 4,
      release: 4,
      dispose: 1,
      begin: 3,
      commit: 3,
      rollback: 0,
      load: 3,
      update: 3,
      readback: 3,
      audit: 3,
    },
    samples: [0, 1, 2].map((i) => {
      const v = fixture();
      for (const p of [...v.phases, ...v.ownership])
        Object.assign(p, { gatewayRequestId: 'public-on-' + i, lambdaRequestId: 'public-on-' + i });
      return {
        index: i,
        firstForClient: i === 0,
        failed: false,
        windowsMs: { load: 522, update: 1, readback: 1, audit: 1 },
        observations: [
          ...v.phases.map((p) => ({ ...p, event: 'data-path.phase.completed' })),
          ...v.ownership.map((p) => ({ ...p, event: 'data-path.contract-load.ownership' })),
        ],
      };
    }),
  });
  assert.equal(summarizePublicCase(make()).length, 3);
  for (const mutate of [
    (r) => (r.forcedYields = 1),
    (r) => (r.targetEquivalent = true),
    (r) => (r.counts.pools = 2),
    (r) => (r.counts.release = 3),
    (r) => (r.counts.network = 1),
    (r) => (r.samples[0].observations.at(-1).gatewayRequestId = 'foreign'),
    (r) => (r.samples[1].index = 0),
    (r) => (r.delayMs = 30),
    (r) => {
      r.case = 'pg-wait';
      r.delayMs = 30;
      for (const s of r.samples)
        for (const p of s.observations)
          Object.assign(p, {
            gatewayRequestId: `public-pg-wait-${s.index}`,
            lambdaRequestId: `public-pg-wait-${s.index}`,
          });
    },
    (r) => {
      r.case = 'fields-cpu';
      r.resultCpuMs = 20;
      for (const s of r.samples)
        for (const p of s.observations)
          Object.assign(p, {
            gatewayRequestId: `public-fields-cpu-${s.index}`,
            lambdaRequestId: `public-fields-cpu-${s.index}`,
          });
    },
    (r) => (r.samples[1].observations.at(-1).modelResumes = 2),
  ]) {
    const r = make();
    mutate(r);
    assert.throws(() => summarizePublicCase(r));
  }
});

function correlationFixtures() {
  const make = (scope, audit) => ({
    scope,
    gate: 'PASS',
    sourceReceiptSha256: 'hash',
    sourceCommit: 'commit',
    prefix: 'prefix',
    logReadErrors: {},
    records: Array.from({ length: audit ? 10 : 6 }, (_, i) => {
      const id = (audit ? 'audit' : 'patch') + i,
        conflict = !audit && i % 2 === 1,
        op = audit ? (i ? 'getAuditLogDetail' : 'listAuditLogs') : 'updateContract';
      const row = {
        id,
        requestId: id,
        method: audit ? 'GET' : 'PATCH',
        operationId: op,
        status: conflict ? 409 : 200,
        responseReceived: true,
        exactLinked: true,
        gateway: [{ responseLatency: 20 }],
        lambda: [{ lambdaRequestId: id, operationId: op, elapsedMs: 10 }],
        phases: [],
      };
      const phase = (name, outcome = 'PASS', errorCode = 'NONE') =>
        row.phases.push({
          phase: name,
          durationMs: 1,
          outcome,
          errorCode,
          lambdaRequestId: id,
          gatewayRequestId: id,
          operationId: op,
        });
      phase('admin-authenticate');
      if (audit) {
        phase(i ? 'audit-detail-query' : 'audit-list-query');
        phase('audit-view');
      } else {
        phase('db-transaction-open');
        phase('contract-load');
        for (const name of [
          'contract-version-update',
          'db-transaction-callback',
          'db-transaction-finish',
          'db-transaction',
        ])
          phase(name, conflict ? 'FAIL' : 'PASS', conflict ? 'VERSION_CONFLICT' : 'NONE');
        if (conflict) phase('audit-failure-write');
        else {
          phase('contract-readback');
          phase('audit-success-write');
        }
      }
      return row;
    }),
  });
  return {
    patch: make('OWN_CONTRACT_PATCH_GATEWAY_LAMBDA_REQUEST_CORRELATION', false),
    audit: make('OWN_AUDIT_GET_GATEWAY_LAMBDA_REQUEST_CORRELATION', true),
  };
}

test('full phase checker wires public required proof and cannot silently accept a missing/foreign child', async () => {
  const { validatePhaseCorrelation } = await import('./check-qa09-contract-phases.mjs');
  const make = () => {
    const r = correlationFixtures();
    for (const row of r.patch.records) {
      const v = fixture();
      for (const p of [...v.phases, ...v.ownership])
        Object.assign(p, {
          lambdaRequestId: row.requestId,
          gatewayRequestId: row.requestId,
          operationId: 'updateContract',
        });
      row.phases = row.phases.filter((p) => p.phase !== 'contract-load').concat(v.phases);
      row.contractLoadOwnership = v.ownership;
    }
    return r;
  };
  const options = {
    contractLoadSplit: true,
    contractLoadDetail: true,
    contractAwaitCheckpoint: true,
    contractPublicBoundaries: true,
  };
  const r = make(),
    proof = validatePhaseCorrelation(r.patch, r.audit, options);
  assert.equal(proof.gate, 'PASS');
  assert.equal(proof.contractPublicBoundariesRequired, true);
  assert.equal(proof.p95Accepted, false);
  for (const mutate of [
    (r) => r.patch.records[0].phases.pop(),
    (r) => (r.patch.records[0].contractLoadOwnership[0].modelResumes = 2),
    (r) => (r.patch.records[0].phases.at(-1).gatewayRequestId = 'foreign'),
  ]) {
    const r = make();
    mutate(r);
    assert.throws(() => validatePhaseCorrelation(r.patch, r.audit, options));
  }
  assert.throws(
    () => validatePhaseCorrelation(r.patch, r.audit, { contractPublicBoundaries: true }),
    /PUBLIC_REQUIRES_AWAIT/,
  );
});
