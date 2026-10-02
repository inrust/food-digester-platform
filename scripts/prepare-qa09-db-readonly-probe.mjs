import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DB_TARGET, validateManifest } from './qa09-db-readonly-probe.mjs';
const hash = (data) => createHash('sha256').update(data).digest('hex');
export function prepareProbe(root = process.cwd(), cleanupPrefix) {
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const schema = readFileSync(resolve(root, 'packages/database/prisma/schema.prisma'), 'utf8');
  const tables = [...schema.matchAll(/@@map\("([a-z][a-z0-9_]*)"\)/g)].map((m) => m[1]).sort();
  const dir = resolve(root, 'packages/database/prisma/migrations');
  const migrations = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, checksum: hash(readFileSync(resolve(dir, d.name, 'migration.sql'))) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const manifest = {
    sourceCommit,
    schemaSha256: hash(schema),
    tables,
    migrations,
    ...(cleanupPrefix ? { cleanupPrefix } : {}),
  };
  validateManifest(manifest);
  const probe = readFileSync(resolve(root, 'scripts/qa09-db-readonly-probe.mjs'));
  const buildspec = {
    version: '0.2',
    phases: {
      install: {
        'runtime-versions': { nodejs: 24 },
        commands: [
          'mkdir -p /tmp/qa09-db-probe && cd /tmp/qa09-db-probe',
          'npm install --ignore-scripts --no-audit --no-fund --package-lock=false pg@8.23.0',
          'curl --fail --silent --show-error https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o rds-ca-bundle.pem',
          `node -e "require('node:fs').writeFileSync('probe.mjs', Buffer.from('${probe.toString('base64')}', 'base64'))"`,
        ],
      },
      build: { commands: ['cd /tmp/qa09-db-probe', 'node probe.mjs'] },
    },
  };
  const probeSha256 = hash(probe);
  const project = {
    name: DB_TARGET.project,
    description: 'QA-09 current test environment: fixed read-only database snapshot, no migrations',
    source: { type: 'NO_SOURCE', buildspec: JSON.stringify(buildspec) },
    artifacts: { type: 'NO_ARTIFACTS' },
    serviceRole: 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role',
    environment: {
      type: 'LINUX_CONTAINER',
      image: 'aws/codebuild/standard:7.0',
      computeType: 'BUILD_GENERAL1_SMALL',
      privilegedMode: false,
      environmentVariables: [
        { name: 'DB_SECRET_ARN', value: DB_TARGET.secretArn, type: 'PLAINTEXT' },
        {
          name: 'QA09_DB_MANIFEST_B64',
          value: Buffer.from(JSON.stringify(manifest)).toString('base64'),
          type: 'PLAINTEXT',
        },
        { name: 'QA09_DB_PROBE_SHA256', value: probeSha256, type: 'PLAINTEXT' },
      ],
    },
    vpcConfig: {
      vpcId: 'vpc-0d287fdfa0a4a06bd',
      subnets: ['subnet-0f52dca7a7253f7d1', 'subnet-0c1584eea5495f25a'],
      securityGroupIds: ['sg-081d9a3ee5f6011e9'],
    },
    logsConfig: {
      cloudWatchLogs: {
        status: 'ENABLED',
        groupName: 'fdp-test-app-MigrationRunnerLogsAA30B0B4-lzkIrNBXjMWf',
        streamName: 'qa09-readonly',
      },
    },
    timeoutInMinutes: 5,
    queuedTimeoutInMinutes: 5,
    concurrentBuildLimit: 1,
    autoRetryLimit: 0,
    tags: [
      { key: 'fdp:env', value: 'test' },
      { key: 'fdp:project', value: 'food-digester-platform' },
      { key: 'fdp:task', value: 'QA-09' },
    ],
  };
  return { manifest, probeSha256, project, request: { projectName: DB_TARGET.project } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output) throw Error('OUTPUT_PATH_REQUIRED');
  writeFileSync(output, JSON.stringify(prepareProbe(process.cwd(), process.argv[3]), null, 2) + '\n');
  console.log('Prepared only; no AWS build, migration or data write started.');
}
