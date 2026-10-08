import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKSPACE_BUILD_ARGS = ['build'];

export function parseOperationArgs(argv) {
  const operation = argv[0] ?? 'synth';
  if (!['synth', 'diff', 'deploy'].includes(operation)) {
    throw new Error('Only synth/diff/deploy allowed');
  }
  const stacks = argv.slice(1);
  if (stacks.some((stack) => !/^[A-Za-z][A-Za-z0-9-]*$/u.test(stack))) {
    throw new Error('Stack names must contain only letters, digits, and hyphens');
  }
  if (operation === 'deploy' && stacks.length === 0) {
    throw new Error('Deploy requires at least one explicit stack name');
  }
  return { operation, stacks };
}

export function runWorkspaceBuild(run = spawnSync) {
  const built = run('pnpm', WORKSPACE_BUILD_ARGS, { stdio: 'inherit' });
  if (built.status !== 0) throw new Error(`Workspace build failed (exit ${built.status ?? 'unknown'})`);
}

export function deploymentAuthArgs(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true') {
    if (env.AWS_PROFILE) throw new Error('GitHub Actions deployment must use OIDC credentials, not AWS_PROFILE');
    return [];
  }
  return ['--profile', 'esgiot-infra'];
}

export function qa09RolloutContext(env = process.env) {
  const phase = env.FDP_QA09_ROLLOUT_PHASE ?? 'baseline';
  if (!['baseline', 'observability', 'capacity', 'immediate'].includes(phase))
    throw Error('INVALID_QA09_ROLLOUT_PHASE');
  const engineCpu = env.FDP_QA09_ENGINE_CPU_DIAGNOSIS;
  if (engineCpu !== undefined && !['true', 'false'].includes(engineCpu)) throw Error('INVALID_ENGINE_CPU_DIAGNOSIS');
  if (engineCpu === 'true' && !['capacity', 'immediate'].includes(phase))
    throw Error('ENGINE_CPU_DIAGNOSIS_REQUIRES_CAPACITY');
  const preconnect = env.FDP_QA09_AUTHENTICATED_PRECONNECT;
  if (preconnect !== undefined && !['true', 'false'].includes(preconnect))
    throw Error('INVALID_AUTHENTICATED_PRECONNECT');
  if (preconnect === 'true' && (engineCpu !== 'true' || !['capacity', 'immediate'].includes(phase)))
    throw Error('PRECONNECT_REQUIRES_CAPACITY_ENGINE');
  const accountRead = env.FDP_QA09_ACCOUNT_READ_CANDIDATE;
  if (accountRead !== undefined && !['true', 'false'].includes(accountRead))
    throw Error('INVALID_ACCOUNT_READ_CANDIDATE');
  if (accountRead === 'true' && preconnect !== 'true') throw Error('ACCOUNT_READ_REQUIRES_PRECONNECT_ENGINE_CAPACITY');
  const detail = env.FDP_QA09_CONTRACT_LOAD_DETAIL;
  if (detail !== undefined && !['true', 'false'].includes(detail)) throw Error('INVALID_CONTRACT_LOAD_DETAIL');
  if (detail === 'true' && preconnect !== 'true')
    throw Error('CONTRACT_LOAD_DETAIL_REQUIRES_PRECONNECT_ENGINE_CAPACITY');
  return {
    ...(detail !== undefined ? { enableQa09ContractLoadDetail: detail === 'true' } : {}),
    ...(accountRead !== undefined ? { enableQa09AccountReadCandidate: accountRead === 'true' } : {}),
    ...(preconnect !== undefined ? { enableQa09AuthenticatedPreconnect: preconnect === 'true' } : {}),
    ...(engineCpu !== undefined ? { enableQa09EngineCpuDiagnosis: engineCpu === 'true' } : {}),
    enableRequestObservability: phase !== 'baseline',
    enableQa09Capacity: ['capacity', 'immediate'].includes(phase),
    enableImmediateCommandPublish: phase === 'immediate',
  };
}

export function main(argv = process.argv.slice(2)) {
  const { operation, stacks } = parseOperationArgs(argv);
  const config = JSON.parse(readFileSync(new URL('../infra/environments/esgiot-test.json', import.meta.url), 'utf8'));
  for (const [key, envKey] of Object.entries({
    deviceApiCertificateArn: 'FDP_DEVICE_API_CERTIFICATE_ARN',
    publicApiCertificateArn: 'FDP_PUBLIC_API_CERTIFICATE_ARN',
    deviceApiTruststoreBucketName: 'FDP_TRUSTSTORE_BUCKET_NAME',
    deviceApiTruststoreVersion: 'FDP_TRUSTSTORE_VERSION',
  })) {
    const value = process.env[envKey];
    if (!value) throw new Error(`Missing deployment input: ${envKey}`);
    config[key] = value;
  }

  Object.assign(config, qa09RolloutContext());

  // Lambda bundle 会解析工作区 package exports 到 dist；只构建 infra 会打入陈旧运行时代码。
  runWorkspaceBuild();

  const authArgs = deploymentAuthArgs();

  const identity = spawnSync(
    'aws',
    ['sts', 'get-caller-identity', ...authArgs, '--region', config.deploymentRegion, '--output', 'json'],
    { encoding: 'utf8' },
  );
  if (identity.status !== 0 || JSON.parse(identity.stdout).Account !== config.deploymentAccount) {
    throw new Error('AWS account identity mismatch or deployment credentials unavailable');
  }
  const args = ['--filter', '@fdp/infra', 'exec', 'cdk', operation, ...stacks, ...authArgs];
  if (operation === 'diff') args.push('--no-change-set');
  if (operation === 'deploy') args.push('--require-approval', authArgs.length ? 'broadening' : 'never');
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${value}`);
  const result = spawnSync('pnpm', args, {
    stdio: 'inherit',
    env: { ...process.env, AWS_REGION: config.deploymentRegion },
  });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
