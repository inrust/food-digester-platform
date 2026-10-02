import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DB_TARGET, compareMigrations, validateManifest } from './qa09-db-readonly-probe.mjs';
export function validateSnapshot(snapshot, preparation, buildId) {
  validateManifest(preparation.manifest);
  if (
    snapshot.kind !== 'fdp-qa09-db-readonly/v1' ||
    snapshot.buildId !== buildId ||
    !buildId.startsWith(DB_TARGET.project + ':') ||
    snapshot.sourceCommit !== preparation.manifest.sourceCommit ||
    snapshot.probeSha256 !== preparation.probeSha256 ||
    snapshot.identity?.read_only !== 'on' ||
    snapshot.identity?.database !== DB_TARGET.database ||
    snapshot.businessDataWrites !== false ||
    JSON.stringify(snapshot.target) !== JSON.stringify(DB_TARGET)
  )
    throw Error('UNVERIFIED_DB_SNAPSHOT');
  if (
    !Array.isArray(snapshot.migrations) ||
    JSON.stringify(snapshot.migrationComparison) !==
      JSON.stringify(compareMigrations(preparation.manifest.migrations, snapshot.migrations))
  )
    throw Error('MIGRATION_RESULT_MISMATCH');
  if (
    preparation.manifest.tables.some(
      (t) =>
        !['OBSERVED', 'MISSING'].includes(snapshot.counts?.[t]?.status) ||
        (snapshot.counts[t].status === 'OBSERVED'
          ? !/^\d+$/.test(snapshot.counts[t].count)
          : snapshot.counts[t].count !== null),
    )
  )
    throw Error('INVALID_TABLE_COUNTS');
  return snapshot;
}
function aws(args) {
  const r = spawnSync(
    'aws',
    [...args, '--profile', 'esgiot-readonly', '--region', DB_TARGET.region, '--output', 'json', '--no-cli-pager'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (r.status !== 0) throw Error('AWS_READ_FAILED');
  return JSON.parse(r.stdout);
}
export function main(preparationPath, buildId, output) {
  if (!output || !new RegExp(`^${DB_TARGET.project}:[a-f0-9-]{36}$`).test(buildId ?? ''))
    throw Error('INVALID_COLLECTOR_ARGUMENTS');
  const preparation = JSON.parse(readFileSync(preparationPath, 'utf8'));
  const identity = aws(['sts', 'get-caller-identity']);
  if (identity.Account !== DB_TARGET.accountId) throw Error('WRONG_TEST_ACCOUNT');
  const builds = aws([
    'codebuild',
    'batch-get-builds',
    '--ids',
    buildId,
    '--query',
    'builds[].{id:id,status:buildStatus,startTime:startTime,endTime:endTime,serviceRole:serviceRole,vpcConfig:vpcConfig,logs:logs,sourceType:source.type,buildspec:source.buildspec}',
  ]);
  const build = builds[0];
  if (
    build?.id !== buildId ||
    build.status !== 'SUCCEEDED' ||
    build.sourceType !== 'NO_SOURCE' ||
    build.buildspec !== preparation.project.source.buildspec ||
    build.serviceRole !== preparation.project.serviceRole ||
    JSON.stringify(build.vpcConfig) !== JSON.stringify(preparation.project.vpcConfig)
  )
    throw Error('BUILD_NOT_VERIFIED');
  const events = aws([
    'logs',
    'get-log-events',
    '--log-group-name',
    build.logs.groupName,
    '--log-stream-name',
    build.logs.streamName,
    '--start-from-head',
  ]);
  const frames = events.events.flatMap((e) => {
    try {
      const d = JSON.parse(e.message.trim());
      return d.kind === 'fdp-qa09-db-readonly/v1' ? [d] : [];
    } catch {
      return [];
    }
  });
  if (frames.length !== 1) throw Error('DB_RECEIPT_MISSING_OR_DUPLICATED');
  const snapshot = validateSnapshot(frames[0], preparation, buildId);
  const buildspecSha256 = createHash('sha256').update(build.buildspec).digest('hex');
  delete build.buildspec;
  build.buildspecSha256 = buildspecSha256;
  const receipt = {
    schemaVersion: '1.0',
    task: 'QA-09',
    execution: 'REAL_AWS_VPC_READ_ONLY',
    queryGate: 'PASS',
    migrationGate: snapshot.migrationComparison.status,
    schemaGate: preparation.manifest.tables.every((t) => snapshot.counts[t].status === 'OBSERVED') ? 'PASS' : 'BLOCKED',
    channel: {
      projectName: preparation.project.name,
      serviceRole: preparation.project.serviceRole,
      vpcConfig: preparation.project.vpcConfig,
      buildspecSha256: createHash('sha256').update(preparation.project.source.buildspec).digest('hex'),
      startBuildOverrides: false,
      applicationDeployment: false,
      databaseMigrationStarted: false,
    },
    build,
    manifest: preparation.manifest,
    snapshot,
  };
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(
    JSON.stringify({
      queryGate: receipt.queryGate,
      migrationGate: receipt.migrationGate,
      schemaGate: receipt.schemaGate,
      buildId,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  try {
    main(...process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
