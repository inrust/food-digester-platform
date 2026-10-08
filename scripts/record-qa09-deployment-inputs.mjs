import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { qa09RolloutContext } from './esgiot-cdk.mjs';
const demand = (ok, reason) => {
  if (!ok) throw Error(reason);
};
export function resolveDeploymentInputs(env, sourceCommit) {
  demand(/^[a-f0-9]{40}$/.test(sourceCommit) && sourceCommit === env.GITHUB_SHA, 'EXACT_WORKFLOW_SHA_REQUIRED');
  demand(env.GITHUB_REF === 'refs/heads/main', 'DEPLOY_MAIN_ONLY');
  demand(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'DEPLOY_EVENT_REQUIRED');
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const phase = manual ? env.QA09_REQUESTED_PHASE : env.FDP_QA09_ROLLOUT_PHASE;
  const engine = manual ? env.QA09_REQUESTED_ENGINE : env.FDP_QA09_ENGINE_CPU_DIAGNOSIS;
  const preconnect = manual ? (env.QA09_REQUESTED_PRECONNECT ?? 'false') : 'false';
  const accountRead = manual ? (env.QA09_REQUESTED_ACCOUNT_READ ?? 'false') : 'false';
  const detail = manual ? (env.QA09_REQUESTED_CONTRACT_DETAIL ?? 'false') : 'false';
  demand(['true', 'false'].includes(detail), 'EXPLICIT_CONTRACT_DETAIL_MODE_REQUIRED');
  demand(['true', 'false'].includes(accountRead), 'EXPLICIT_ACCOUNT_READ_MODE_REQUIRED');
  demand(['true', 'false'].includes(preconnect), 'EXPLICIT_PRECONNECT_MODE_REQUIRED');
  if (manual) {
    demand(env.QA09_EXPECTED_COMMIT === sourceCommit, 'COMPARISON_SHA_DRIFT');
    demand(['capacity', 'immediate'].includes(phase) && phase === env.FDP_QA09_ROLLOUT_PHASE, 'COMPARISON_PHASE_DRIFT');
  }
  demand(['true', 'false'].includes(engine), 'EXPLICIT_ENGINE_MODE_REQUIRED');
  demand(typeof phase === 'string', 'EXPLICIT_PHASE_REQUIRED');
  const context = qa09RolloutContext({
    FDP_QA09_ROLLOUT_PHASE: phase,
    FDP_QA09_ENGINE_CPU_DIAGNOSIS: engine,
    FDP_QA09_AUTHENTICATED_PRECONNECT: preconnect,
    FDP_QA09_ACCOUNT_READ_CANDIDATE: accountRead,
    FDP_QA09_CONTRACT_LOAD_DETAIL: detail,
  });
  demand(
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? ''),
    'RUN_BINDING_REQUIRED',
  );
  return {
    gate: 'PASS',
    scope: 'RESOLVED_DEPLOYMENT_INPUTS_ONLY_NOT_TARGET_ACCEPTANCE',
    sourceCommit,
    event: env.GITHUB_EVENT_NAME,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    rolloutPhase: phase,
    engineCpu: engine === 'true',
    authenticatedPreconnect: preconnect === 'true',
    accountReadCandidate: accountRead === 'true',
    contractLoadDetail: detail === 'true',
    context,
    fullQa09Accepted: false,
    p95Accepted: false,
  };
}
export function validateEngineInputPair(off, on, { preconnect = false, accountRead = false } = {}) {
  for (const r of [off, on]) {
    demand(
      r.gate === 'PASS' &&
        r.event === 'workflow_dispatch' &&
        r.scope === 'RESOLVED_DEPLOYMENT_INPUTS_ONLY_NOT_TARGET_ACCEPTANCE' &&
        r.fullQa09Accepted === false &&
        r.p95Accepted === false,
      'MANUAL_INPUT_RECEIPT_REQUIRED',
    );
    const expected = resolveDeploymentInputs(
      {
        GITHUB_SHA: r.sourceCommit,
        GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_NAME: r.event,
        QA09_EXPECTED_COMMIT: r.sourceCommit,
        QA09_REQUESTED_PHASE: r.rolloutPhase,
        FDP_QA09_ROLLOUT_PHASE: r.rolloutPhase,
        QA09_REQUESTED_ENGINE: String(r.engineCpu),
        QA09_REQUESTED_PRECONNECT: String(r.authenticatedPreconnect ?? false),
        QA09_REQUESTED_ACCOUNT_READ: String(r.accountReadCandidate ?? false),
        QA09_REQUESTED_CONTRACT_DETAIL: String(r.contractLoadDetail ?? false),
        GITHUB_RUN_ID: r.runId,
        GITHUB_RUN_ATTEMPT: r.runAttempt,
      },
      r.sourceCommit,
    );
    const context = { ...r.context };
    // Immutable pre-detail receipts remain readable only as default-off, never as detailed proof.
    if (r.contractLoadDetail === undefined && context.enableQa09ContractLoadDetail === undefined)
      context.enableQa09ContractLoadDetail = false;
    demand(
      JSON.stringify(Object.entries(context).sort()) === JSON.stringify(Object.entries(expected.context).sort()),
      'RESOLVED_CONTEXT_DRIFT',
    );
  }
  demand(
    off.runId !== on.runId &&
      (accountRead
        ? off.engineCpu === true &&
          on.engineCpu === true &&
          off.authenticatedPreconnect === true &&
          on.authenticatedPreconnect === true &&
          off.accountReadCandidate === false &&
          on.accountReadCandidate === true
        : !off.accountReadCandidate &&
          !on.accountReadCandidate &&
          (preconnect
            ? off.engineCpu === true &&
              on.engineCpu === true &&
              off.authenticatedPreconnect === false &&
              on.authenticatedPreconnect === true
            : off.engineCpu === false &&
              on.engineCpu === true &&
              !off.authenticatedPreconnect &&
              !on.authenticatedPreconnect)),
    'DISTINCT_OFF_ON_RUNS_REQUIRED',
  );
  for (const k of [
    'sourceCommit',
    'rolloutPhase',
    'workflowSha256',
    'resolverSha256',
    'rolloutResolverSha256',
    'deploymentConfigSha256',
  ])
    demand(
      typeof off[k] === 'string' &&
        off[k] === on[k] &&
        (k === 'sourceCommit' || k === 'rolloutPhase' || /^[a-f0-9]{64}$/.test(off[k])),
      'PAIR_INPUT_DRIFT',
    );
  demand((off.contractLoadDetail ?? false) === (on.contractLoadDetail ?? false), 'PAIR_DETAIL_MODE_DRIFT');
  return {
    gate: 'PASS',
    scope: 'INPUT_COMPARABILITY_ONLY',
    comparison: accountRead ? 'R0_R1_ACCOUNT_READ_ONLY' : preconnect ? 'C0_C1_PRECONNECT_ONLY' : 'ENGINE_OFF_ON',
    sourceCommit: off.sourceCommit,
    offRunId: off.runId,
    onRunId: on.runId,
    targetVersionGate: 'NOT_EVALUATED',
    businessGate: 'NOT_EVALUATED',
    p95Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (['--pair', '--preconnect-pair', '--account-read-pair'].includes(process.argv[2])) {
    demand(process.argv.length === 6, 'PAIR_ARGUMENTS_REQUIRED');
    const files = process.argv.slice(3, 5),
      values = files.map((f) => JSON.parse(readFileSync(f)));
    const result = validateEngineInputPair(...values, {
      preconnect: process.argv[2] === '--preconnect-pair',
      accountRead: process.argv[2] === '--account-read-pair',
    });
    result.bindings = files.map((path) => ({
      path,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    }));
    writeFileSync(process.argv[5], JSON.stringify(result, null, 2) + '\n');
  } else {
    demand(process.argv.length === 3, 'OUTPUT_REQUIRED');
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const result = resolveDeploymentInputs(process.env, source);
    const hash = (path) => {
      const bytes = readFileSync(path);
      demand(bytes.equals(execFileSync('git', ['show', `${source}:${path}`])), 'DEPLOY_SOURCE_BYTES_DRIFT');
      return createHash('sha256').update(bytes).digest('hex');
    };
    result.workflowSha256 = hash('.github/workflows/deploy-test.yml');
    result.resolverSha256 = hash('scripts/record-qa09-deployment-inputs.mjs');
    result.rolloutResolverSha256 = hash('scripts/esgiot-cdk.mjs');
    result.deploymentConfigSha256 = createHash('sha256')
      .update(
        JSON.stringify({
          config: hash('infra/environments/esgiot-test.json'),
          references: [
            'FDP_DEVICE_API_CERTIFICATE_ARN',
            'FDP_PUBLIC_API_CERTIFICATE_ARN',
            'FDP_TRUSTSTORE_BUCKET_NAME',
            'FDP_TRUSTSTORE_VERSION',
            'FDP_TEST_DEPLOY_ROLE_ARN',
          ].map((k) => process.env[k] ?? ''),
        }),
      )
      .digest('hex');
    writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
    if (process.env.GITHUB_ENV)
      appendFileSync(
        process.env.GITHUB_ENV,
        `FDP_QA09_ROLLOUT_PHASE=${result.rolloutPhase}\nFDP_QA09_ENGINE_CPU_DIAGNOSIS=${result.engineCpu}\nFDP_QA09_AUTHENTICATED_PRECONNECT=${result.authenticatedPreconnect}\nFDP_QA09_ACCOUNT_READ_CANDIDATE=${result.accountReadCandidate}\nFDP_QA09_CONTRACT_LOAD_DETAIL=${result.contractLoadDetail}\n`,
      );
    console.log(
      JSON.stringify({
        gate: result.gate,
        sourceCommit: source,
        engineCpu: result.engineCpu,
        rolloutPhase: result.rolloutPhase,
      }),
    );
  }
}
