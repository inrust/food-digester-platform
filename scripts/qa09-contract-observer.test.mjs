import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContractObserverCost, contractObserverInputs } from './qa09-contract-observer-proof.mjs';
import { resolveDeploymentInputs, validateEngineInputPair } from './record-qa09-deployment-inputs.mjs';
import { validateAccountReadTargetConfig } from './qa09-account-read-config.mjs';
import { qa09RolloutContext } from './esgiot-cdk.mjs';
const sha = 'a'.repeat(40),
  hash = 'b'.repeat(64);
const env = {
  GITHUB_SHA: sha,
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_RUN_ID: '1',
  GITHUB_RUN_ATTEMPT: '1',
  QA09_EXPECTED_COMMIT: sha,
  QA09_REQUESTED_PHASE: 'immediate',
  FDP_QA09_ROLLOUT_PHASE: 'immediate',
  QA09_REQUESTED_ENGINE: 'true',
  QA09_REQUESTED_PRECONNECT: 'true',
  QA09_REQUESTED_ACCOUNT_READ: 'true',
  QA09_REQUESTED_CONTRACT_DETAIL: 'true',
  QA09_REQUESTED_CONTRACT_PUBLIC: 'true',
  QA09_REQUESTED_OBSERVER_COST: 'true',
};
function record() {
  return {
    exactLinked: true,
    requestId: 'gateway',
    lambda: [{ lambdaRequestId: 'lambda' }],
    gateway: [{ integrationRequestId: 'lambda' }],
    startMs: 10000,
    latencyMs: 10,
    contractObserverCost: [
      {
        event: 'data-path.contract-load.observer-cost',
        schemaVersion: 1,
        status: 'COMPLETE',
        gatewayRequestId: 'gateway',
        lambdaRequestId: 'lambda',
        operationId: 'updateContract',
        logTimestampMs: 10001,
        intervalRecords: 19,
        publicCalls: 1,
        publicOutcome: 'RETURNED',
        overflow: 0,
        nestedOutputs: 0,
        foreignOutputs: 0,
        probeFailures: 0,
        outsideOutputs: 12,
        ambiguousOutputs: 0,
        unresolvedOutputs: 0,
        processCpuScope: 'PROCESS_ALL_THREADS',
        cpuSubtractionAllowed: false,
        compilerOnlyAttribution: false,
        segments: ['driver-prefix', 'public-call', 'driver-return-tail', 'after-model'].map((name) => ({
          name,
          wallUs: 100,
          outputWallUs: 10,
          outputProcessCpuUs: 20,
          unattributedWallUs: 90,
        })),
      },
    ],
  };
}
test('summary and comparable observer inputs keep account native in both groups and restore all candidates off', () => {
  assert.equal(validateContractObserverCost(record(), true).gate, 'PASS');
  const p = contractObserverInputs(sha);
  assert.equal(p.r0.accountReadCandidate, true);
  assert.equal(p.r1.accountReadCandidate, true);
  assert.equal(p.r0.contractObserverCost, false);
  assert.equal(p.r1.contractObserverCost, true);
  assert.equal(p.restore.contractObserverCost, false);
  assert.equal(p.restore.accountReadCandidate, false);
  assert.throws(() => contractObserverInputs('short'));
});
for (const [name, mutate] of Object.entries({
  missing: (r) => (r.contractObserverCost = []),
  duplicate: (r) => r.contractObserverCost.push(r.contractObserverCost[0]),
  foreign: (r) => (r.contractObserverCost[0].lambdaRequestId = 'foreign'),
  gateway: (r) => (r.contractObserverCost[0].gatewayRequestId = 'foreign'),
  time: (r) => (r.contractObserverCost[0].logTimestampMs = 0),
  degraded: (r) => (r.contractObserverCost[0].status = 'OUTPUT_FAILED'),
  overbudget: (r) => (r.contractObserverCost[0].intervalRecords = 65),
  modelClaim: (r) => (r.contractObserverCost[0].compilerOnlyAttribution = true),
  conservation: (r) => (r.contractObserverCost[0].segments[0].unattributedWallUs = 99),
  missingSegment: (r) => r.contractObserverCost[0].segments.pop(),
  order: (r) => r.contractObserverCost[0].segments.reverse(),
  unsafeCpu: (r) => (r.contractObserverCost[0].segments[0].outputProcessCpuUs = NaN),
  link: (r) => (r.exactLinked = false),
}))
  test('strict observer rejects ' + name, () => {
    const r = record();
    mutate(r);
    assert.throws(() => validateContractObserverCost(r, true));
  });
test('push always resolves observer false despite inherited true; manual true is recorded end to end', () => {
  assert.equal(
    resolveDeploymentInputs(
      { ...env, GITHUB_EVENT_NAME: 'push', FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'true', FDP_CONTRACT_OBSERVER_COST: 'true' },
      sha,
    ).contractObserverCost,
    false,
  );
  const r = resolveDeploymentInputs(env, sha);
  assert.equal(r.contractObserverCost, true);
  assert.equal(r.context.enableQa09ContractObserverCost, true);
  assert.throws(() => qa09RolloutContext({ FDP_CONTRACT_OBSERVER_COST: 'true' }));
});
for (const key of [
  'QA09_REQUESTED_PRECONNECT',
  'QA09_REQUESTED_ENGINE',
  'QA09_REQUESTED_CONTRACT_DETAIL',
  'QA09_REQUESTED_CONTRACT_PUBLIC',
])
  test('manual observer cannot bypass ' + key, () =>
    assert.throws(() => resolveDeploymentInputs({ ...env, [key]: 'false' }, sha)),
  );
test('pair binds all modes with only observer false/true; config requires actual observed switch even when off', () => {
  const receipts = [false, true].map((on, i) => ({
    ...resolveDeploymentInputs({ ...env, GITHUB_RUN_ID: String(i + 1), QA09_REQUESTED_OBSERVER_COST: String(on) }, sha),
    workflowSha256: hash,
    resolverSha256: hash,
    rolloutResolverSha256: hash,
    deploymentConfigSha256: hash,
  }));
  assert.equal(validateEngineInputPair(...receipts, { observerCost: true }).gate, 'PASS');
  for (const k of ['accountReadCandidate', 'contractLoadDetail', 'contractPublicBoundaries', 'authenticatedPreconnect'])
    assert.throws(() => validateEngineInputPair(receipts[0], { ...receipts[1], [k]: false }, { observerCost: true }));
  const input = receipts[1],
    version = {
      gate: 'PASS',
      sourceCommit: sha,
      lambdaArtifacts: Array.from({ length: 19 }, (_, i) => ({
        name: i === 0 ? 'fdp-test-api' : 'other' + i,
        matches: true,
        revisionId: 'revision',
        codeSha256: 'code',
      })),
    };
  const config = {
    name: 'fdp-test-api',
    revisionId: 'revision',
    codeSha256: 'code',
    state: 'Active',
    update: 'Successful',
    envName: 'test',
    pool: '1',
    memory: 512,
    runtime: 'nodejs24.x',
    architecture: 'arm64',
    accountReadCandidate: 'true',
    engineCpu: 'true',
    preconnect: 'true',
    contractLoadDetail: 'true',
    contractPublicBoundaries: 'true',
    contractObserverCost: 'true',
  };
  assert.equal(
    validateAccountReadTargetConfig(input, version, config, { ReservedConcurrentExecutions: 12 }).gate,
    'PASS',
  );
  for (const actual of [undefined, 'false'])
    assert.throws(() =>
      validateAccountReadTargetConfig(
        input,
        version,
        { ...config, contractObserverCost: actual },
        { ReservedConcurrentExecutions: 12 },
      ),
    );
});

test('observer pair reuses closed receipt/cold budgets with account=true in both groups; incomplete stages cannot pass', async () => {
  const { validateMatchedColdPair } = await import('./qa09-matched-cold-inputs.mjs');
  const { observerTargetInputs } = await import('./analyze-qa09-contract-observer.mjs');
  const p = observerTargetInputs(sha),
    common = {
      source: 'TARGET_RECEIPT',
      provenanceGate: 'PASS',
      cleanupGate: 'PASS',
      phaseGate: 'PASS',
      connectionBudgetGate: 'PASS',
      artifactSetSha256: hash,
      lambdaCount: 19,
      coldProofGroup: 'BASELINE',
      naturalCold409Count: 1,
      platformInitDurationMs: 100,
      coldProofGate: 'PASS',
      clientSplitGate: 'PASS',
      firstCheckoutOwned: true,
    };
  const off = {
      ...p.r0,
      ...common,
      prefix: 'qa09-1111111111111111',
      runId: '1',
      startedAt: '2026-10-11T00:00Z',
      closedAt: '2026-10-11T01:00Z',
    },
    on = {
      ...p.r1,
      ...common,
      prefix: 'qa09-2222222222222222',
      runId: '2',
      startedAt: '2026-10-11T02:00Z',
      closedAt: '2026-10-11T03:00Z',
    };
  assert.equal(validateMatchedColdPair(off, on, { observerCost: true }).gate, 'INPUT_COMPATIBLE');
  for (const patch of [
    { accountReadCandidate: false },
    { contractObserverCost: false },
    { cleanupGate: 'PARTIAL' },
    { phaseGate: 'PARTIAL' },
    { naturalCold409Count: 0 },
    { artifactSetSha256: 'bad' },
    { startedAt: off.startedAt },
  ])
    assert.throws(() => validateMatchedColdPair(off, { ...on, ...patch }, { observerCost: true }));
  assert.throws(() => validateMatchedColdPair(off, on));
});

test('runtime receipt replay rejects business count/status/identity/budget forgery', async () => {
  const { validateObserverRuntimeReceipt } = await import('./qa09-contract-observer-proof.mjs');
  const rows = Array.from({ length: 3 }, (_, i) => ({
    failed: false,
    observations: [
      {
        ...record().contractObserverCost[0],
        gatewayRequestId: `entry-entry-output-${i}`,
        lambdaRequestId: `entry-L-entry-output-${i}`,
      },
    ],
  }));
  const r = {
    kind: 'qa09-production-observer-controlled-runtime/v1',
    gate: 'PASS',
    case: 'entry-output',
    targetEquivalent: false,
    fullQa09Accepted: false,
    p95Accepted: false,
    profile: null,
    poolMax: 1,
    forcedYields: 0,
    samples: rows,
    counts: {
      begin: 3,
      checkout: 4,
      release: 4,
      commit: 3,
      rollback: 0,
      dispose: 1,
      pools: 1,
      network: 0,
      account: 1,
      load: 3,
      update: 3,
      readback: 3,
      audit: 3,
    },
  };
  assert.equal(validateObserverRuntimeReceipt(r).gate, 'LOCAL_RUNTIME_PASS');
  for (const mutate of [
    (v) => v.counts.load++,
    (v) => (v.samples[0].failed = true),
    (v) => (v.samples[0].observations = []),
    (v) => (v.samples[0].observations[0].lambdaRequestId = 'foreign'),
    (v) => (v.samples[0].observations[0].intervalRecords = 65),
    (v) => (v.samples[0].observations[0].segments[0].unattributedWallUs = 99),
    (v) => (v.samples[0].observations[0].segments = []),
    (v) => (v.samples[0].observations[0].publicOutcome = 'THREW'),
    (v) => (v.targetEquivalent = true),
  ]) {
    const v = structuredClone(r);
    mutate(v);
    assert.throws(() => validateObserverRuntimeReceipt(v));
  }
});
