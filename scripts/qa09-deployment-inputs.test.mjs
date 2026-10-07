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
