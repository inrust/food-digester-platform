import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const demand = (ok, reason) => {
  if (!ok) throw Error(reason);
};
export function validateAccountReadTargetConfig(inputs, version, config, concurrency) {
  demand(
    inputs.gate === 'PASS' &&
      /^[a-f0-9]{40}$/.test(inputs.sourceCommit) &&
      version.gate === 'PASS' &&
      inputs.sourceCommit === version.sourceCommit,
    'ACCOUNT_READ_SOURCE_BINDING',
  );
  demand(inputs.accountReadCandidate === true || inputs.accountReadCandidate === false, 'ACCOUNT_READ_EXPLICIT_INPUT');
  demand(
    version.lambdaArtifacts?.length === 19 && version.lambdaArtifacts.every((a) => a.matches === true),
    'ACCOUNT_READ_19_ARTIFACTS',
  );
  const api = version.lambdaArtifacts.find((a) => a.name === 'fdp-test-api');
  demand(
    api && api.revisionId === config.revisionId && api.codeSha256 === config.codeSha256,
    'ACCOUNT_READ_API_REVISION_CODE_DRIFT',
  );
  demand(
    config.name === 'fdp-test-api' &&
      config.state === 'Active' &&
      config.update === 'Successful' &&
      config.envName === 'test' &&
      config.pool === '1' &&
      config.memory === 512 &&
      config.runtime === 'nodejs24.x' &&
      config.architecture === 'x86_64' &&
      concurrency.ReservedConcurrentExecutions === 12,
    'ACCOUNT_READ_ACTUAL_BUDGET',
  );
  demand(
    config.accountReadCandidate === String(inputs.accountReadCandidate) &&
      config.engineCpu === String(inputs.engineCpu) &&
      config.preconnect === String(inputs.authenticatedPreconnect),
    'ACCOUNT_READ_ACTUAL_MODE_DRIFT',
  );
  demand(
    !inputs.accountReadCandidate || (inputs.engineCpu === true && inputs.authenticatedPreconnect === true),
    'ACCOUNT_READ_ACTUAL_GUARD',
  );
  return {
    gate: 'PASS',
    scope: 'ACTUAL_ACCOUNT_READ_CONFIG_AND_VERSION_ONLY',
    sourceCommit: inputs.sourceCommit,
    runId: inputs.runId,
    config,
    concurrency,
    fullQa09Accepted: false,
    p95Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [inputFile, versionFile, out] = process.argv.slice(2);
  demand(process.argv.length === 5 && !existsSync(out), 'INPUT_VERSION_FRESH_OUTPUT_REQUIRED');
  const inputs = JSON.parse(readFileSync(inputFile)),
    version = JSON.parse(readFileSync(versionFile));
  demand(
    inputs.gate === 'PASS' && version.gate === 'PASS' && inputs.sourceCommit === version.sourceCommit,
    'ACCOUNT_READ_SOURCE_BINDING',
  );
  const read = (args) =>
    JSON.parse(
      execFileSync(
        'aws',
        [...args, '--profile', 'esgiot-readonly', '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'],
        { timeout: 45000, encoding: 'utf8' },
      ),
    );
  const config = read([
    'lambda',
    'get-function-configuration',
    '--function-name',
    'fdp-test-api',
    '--query',
    '{name:FunctionName,revisionId:RevisionId,codeSha256:CodeSha256,memory:MemorySize,state:State,update:LastUpdateStatus,runtime:Runtime,architecture:Architectures[0],envName:Environment.Variables.ENV_NAME,pool:Environment.Variables.FDP_DB_POOL_MAX,engineCpu:Environment.Variables.FDP_QA09_ENGINE_CPU_DIAGNOSIS,preconnect:Environment.Variables.FDP_QA09_AUTHENTICATED_PRECONNECT,accountReadCandidate:Environment.Variables.FDP_QA09_ACCOUNT_READ_CANDIDATE}',
  ]);
  const concurrency = read(['lambda', 'get-function-concurrency', '--function-name', 'fdp-test-api']);
  const result = {
    ...validateAccountReadTargetConfig(inputs, version, config, concurrency),
    bindings: [inputFile, versionFile].map((path) => ({
      path,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    })),
  };
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ gate: result.gate, scope: result.scope }));
}
