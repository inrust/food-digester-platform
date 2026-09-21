import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Deliberately synth/diff only: this local approval does not authorize deployment.
const operation = process.argv[2] ?? 'synth';
if (!['synth', 'diff'].includes(operation))
  throw new Error('Only synth/diff allowed; deployment requires separate approval');
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
const built = spawnSync('pnpm', ['--filter', '@fdp/infra', 'build'], { stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const identity = spawnSync(
  'aws',
  ['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--region', config.deploymentRegion, '--output', 'json'],
  { encoding: 'utf8' },
);
if (identity.status !== 0 || JSON.parse(identity.stdout).Account !== config.deploymentAccount)
  throw new Error('AWS account identity mismatch or SSO unavailable');
const args = ['--filter', '@fdp/infra', 'exec', 'cdk', operation, '--profile', 'esgiot-infra'];
if (operation === 'diff') args.push('--no-change-set');
for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${value}`);
const result = spawnSync('pnpm', args, {
  stdio: 'inherit',
  env: { ...process.env, AWS_REGION: config.deploymentRegion },
});
process.exitCode = result.status ?? 1;
