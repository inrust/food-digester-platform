import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveDeploymentInputs, validateEngineInputPair } from './record-qa09-deployment-inputs.mjs';
const sha = 'a'.repeat(40),
  hash = 'b'.repeat(64);
const env = {
  GITHUB_SHA: sha,
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1',
  QA09_EXPECTED_COMMIT: sha,
  QA09_REQUESTED_ENGINE: 'false',
  QA09_REQUESTED_PHASE: 'immediate',
  FDP_QA09_ROLLOUT_PHASE: 'immediate',
  FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'true',
};
const receipt = (on = false) => ({
  ...resolveDeploymentInputs({ ...env, GITHUB_RUN_ID: on ? '124' : '123', QA09_REQUESTED_ENGINE: String(on) }, sha),
  workflowSha256: hash,
  resolverSha256: hash,
  rolloutResolverSha256: hash,
  deploymentConfigSha256: hash,
});
test('explicit manual false overrides repository true and preserves capacity/immediate context', () => {
  assert.equal(receipt().engineCpu, false);
  assert.equal(receipt().context.enableImmediateCommandPublish, true);
  assert.equal(receipt().context.enableQa09Capacity, true);
  assert.equal(validateEngineInputPair(receipt(), receipt(true)).gate, 'PASS');
});
test('manual deployment rejects branch/SHA, missing mode, phase drift and unsupported events before cloud work', () => {
  for (const patch of [
    { GITHUB_REF: 'refs/heads/other' },
    { QA09_EXPECTED_COMMIT: 'c'.repeat(40) },
    { QA09_REQUESTED_ENGINE: '' },
    { QA09_REQUESTED_ENGINE: 'FALSE' },
    { QA09_REQUESTED_PHASE: 'capacity' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_RUN_ATTEMPT: '0' },
  ])
    assert.throws(() => resolveDeploymentInputs({ ...env, ...patch }, sha));
  assert.throws(() => resolveDeploymentInputs(env, 'c'.repeat(40)));
});
test('push keeps existing resolved defaults but cannot ignore explicit invalid input', () => {
  const p = resolveDeploymentInputs({ ...env, GITHUB_EVENT_NAME: 'push' }, sha);
  assert.equal(p.engineCpu, true);
  assert.throws(() =>
    resolveDeploymentInputs({ ...env, GITHUB_EVENT_NAME: 'push', FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'yes' }, sha),
  );
});
test('input pair gate never implies target acceptance and rejects SHA/config/context/duplicate run drift', () => {
  const p = validateEngineInputPair(receipt(), receipt(true));
  assert.equal(p.targetVersionGate, 'NOT_EVALUATED');
  assert.equal(p.p95Accepted, false);
  for (const mutate of [
    (r) => (r.sourceCommit = 'c'.repeat(40)),
    (r) => (r.deploymentConfigSha256 = 'd'.repeat(64)),
    (r) => (r.rolloutResolverSha256 = 'd'.repeat(64)),
    (r) => (r.context.enableQa09Capacity = false),
    (r) => (r.runId = '123'),
    (r) => (r.engineCpu = false),
    (r) => (r.event = 'push'),
  ]) {
    const r = receipt(true);
    mutate(r);
    assert.throws(() => validateEngineInputPair(receipt(), r));
  }
});
test('workflow records input receipt before verification/AWS and never interpolates manual input into shell', () => {
  const s = readFileSync('.github/workflows/deploy-test.yml', 'utf8');
  assert.match(s, /workflow_dispatch:/);
  assert.match(s, /inputs.engine_cpu_diagnosis/);
  assert.ok(s.indexOf('record-qa09-deployment-inputs.mjs') < s.indexOf('run: pnpm verify'));
  assert.ok(s.indexOf('record-qa09-deployment-inputs.mjs') < s.indexOf('configure-aws-credentials'));
  assert.match(s, /qa09-deployment-inputs-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
  assert.doesNotMatch(s, /run:.*\$\{\{ inputs\./);
});

test('C0/C1 same SHA and engine=true differ only preconnect; push cannot turn candidate on', () => {
  const c = (on) => ({
    ...receipt(true),
    ...resolveDeploymentInputs(
      {
        ...env,
        QA09_REQUESTED_ENGINE: 'true',
        QA09_REQUESTED_PRECONNECT: String(on),
        GITHUB_RUN_ID: on ? '126' : '125',
      },
      sha,
    ),
  });
  assert.equal(validateEngineInputPair(c(false), c(true), { preconnect: true }).comparison, 'C0_C1_PRECONNECT_ONLY');
  assert.equal(
    resolveDeploymentInputs({ ...env, GITHUB_EVENT_NAME: 'push', FDP_QA09_AUTHENTICATED_PRECONNECT: 'true' }, sha)
      .authenticatedPreconnect,
    false,
  );
  for (const mutate of [
    (r) => (r.engineCpu = false),
    (r) => (r.authenticatedPreconnect = false),
    (r) => (r.sourceCommit = 'c'.repeat(40)),
    (r) => (r.runId = '125'),
    (r) => (r.context.enableQa09AuthenticatedPreconnect = false),
    (r) => (r.deploymentConfigSha256 = 'c'.repeat(64)),
  ]) {
    const r = c(true);
    mutate(r);
    assert.throws(() => validateEngineInputPair(c(false), r, { preconnect: true }));
  }
  for (const patch of [
    { QA09_REQUESTED_ENGINE: 'false', QA09_REQUESTED_PRECONNECT: 'true' },
    { QA09_REQUESTED_PRECONNECT: 'yes' },
  ])
    assert.throws(() => resolveDeploymentInputs({ ...env, ...patch }, sha));
});

test('R0/R1 input pair binds same SHA and budget, differs only account read; push always off', () => {
  const r = (on) => ({
    ...receipt(true),
    ...resolveDeploymentInputs(
      {
        ...env,
        QA09_REQUESTED_ENGINE: 'true',
        QA09_REQUESTED_PRECONNECT: 'true',
        QA09_REQUESTED_ACCOUNT_READ: String(on),
        GITHUB_RUN_ID: on ? '128' : '127',
      },
      sha,
    ),
  });
  assert.equal(validateEngineInputPair(r(false), r(true), { accountRead: true }).comparison, 'R0_R1_ACCOUNT_READ_ONLY');
  assert.equal(
    resolveDeploymentInputs({ ...env, GITHUB_EVENT_NAME: 'push', FDP_QA09_ACCOUNT_READ_CANDIDATE: 'true' }, sha)
      .accountReadCandidate,
    false,
  );
  for (const patch of [
    { QA09_REQUESTED_ENGINE: 'false' },
    { QA09_REQUESTED_PRECONNECT: 'false' },
    { QA09_REQUESTED_ACCOUNT_READ: 'yes' },
  ])
    assert.throws(() =>
      resolveDeploymentInputs(
        {
          ...env,
          QA09_REQUESTED_ENGINE: 'true',
          QA09_REQUESTED_PRECONNECT: 'true',
          QA09_REQUESTED_ACCOUNT_READ: 'true',
          ...patch,
        },
        sha,
      ),
    );
  for (const mutate of [
    (v) => (v.accountReadCandidate = false),
    (v) => (v.authenticatedPreconnect = false),
    (v) => (v.context.enableQa09AccountReadCandidate = false),
    (v) => (v.sourceCommit = 'c'.repeat(40)),
    (v) => (v.deploymentConfigSha256 = 'c'.repeat(64)),
  ]) {
    const on = r(true);
    mutate(on);
    assert.throws(() => validateEngineInputPair(r(false), on, { accountRead: true }));
  }
  assert.match(readFileSync('.github/workflows/deploy-test.yml', 'utf8'), /inputs.account_read_candidate/);
});

test('detail is off on push, manual detail requires guarded preconnect and round trips both R inputs', () => {
  const make = (on) => ({
    ...receipt(true),
    ...resolveDeploymentInputs(
      {
        ...env,
        QA09_REQUESTED_ENGINE: 'true',
        QA09_REQUESTED_PRECONNECT: 'true',
        QA09_REQUESTED_ACCOUNT_READ: String(on),
        QA09_REQUESTED_CONTRACT_DETAIL: 'true',
        GITHUB_RUN_ID: on ? '132' : '131',
      },
      sha,
    ),
  });
  assert.equal(validateEngineInputPair(make(false), make(true), { accountRead: true }).gate, 'PASS');
  assert.equal(
    resolveDeploymentInputs({ ...env, GITHUB_EVENT_NAME: 'push', FDP_QA09_CONTRACT_LOAD_DETAIL: 'true' }, sha)
      .contractLoadDetail,
    false,
  );
  for (const patch of [
    { QA09_REQUESTED_CONTRACT_DETAIL: 'yes' },
    { QA09_REQUESTED_PRECONNECT: 'false' },
    { QA09_REQUESTED_ENGINE: 'false' },
  ])
    assert.throws(() =>
      resolveDeploymentInputs(
        {
          ...env,
          QA09_REQUESTED_ENGINE: 'true',
          QA09_REQUESTED_PRECONNECT: 'true',
          QA09_REQUESTED_CONTRACT_DETAIL: 'true',
          ...patch,
        },
        sha,
      ),
    );
  const mismatch = make(true);
  mismatch.contractLoadDetail = false;
  mismatch.context.enableQa09ContractLoadDetail = false;
  assert.throws(() => validateEngineInputPair(make(false), mismatch, { accountRead: true }), /DETAIL_MODE_DRIFT/);
  const oldOff = receipt(),
    oldOn = receipt(true);
  for (const r of [oldOff, oldOn]) {
    delete r.contractLoadDetail;
    delete r.context.enableQa09ContractLoadDetail;
  }
  assert.equal(validateEngineInputPair(oldOff, oldOn).gate, 'PASS');
  assert.match(readFileSync('.github/workflows/deploy-test.yml', 'utf8'), /inputs.contract_load_detail/);
});
