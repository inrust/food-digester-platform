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

  // Lambda bundle 会解析工作区 package exports 到 dist；只构建 infra 会打入陈旧运行时代码。
  runWorkspaceBuild();

  const identity = spawnSync(
    'aws',
    [
      'sts',
      'get-caller-identity',
      '--profile',
      'esgiot-infra',
      '--region',
      config.deploymentRegion,
      '--output',
      'json',
    ],
    { encoding: 'utf8' },
  );
  if (identity.status !== 0 || JSON.parse(identity.stdout).Account !== config.deploymentAccount) {
    throw new Error('AWS account identity mismatch or SSO unavailable');
  }
  const args = ['--filter', '@fdp/infra', 'exec', 'cdk', operation, ...stacks, '--profile', 'esgiot-infra'];
  if (operation === 'diff') args.push('--no-change-set');
  if (operation === 'deploy') args.push('--require-approval', 'broadening');
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${value}`);
  const result = spawnSync('pnpm', args, {
    stdio: 'inherit',
    env: { ...process.env, AWS_REGION: config.deploymentRegion },
  });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
