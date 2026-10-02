import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DB_TARGET } from './qa09-db-readonly-probe.mjs';
import { ALLOWED, RETIREMENT_PROJECT, validateApproval } from './qa09-retire-legacy-onboarding.mjs';
export function validateRetirementReceipt(result, preparation, buildId) {
  validateApproval(preparation.approval);
  const ids = (rows, key) => rows.map((r) => r[key]).sort();
  if (
    result.kind !== 'fdp-qa09-legacy-retirement/v1' ||
    result.gate !== 'PASS' ||
    result.buildId !== buildId ||
    !buildId.startsWith(RETIREMENT_PROJECT + ':') ||
    result.executorSha256 !== preparation.executorSha256 ||
    result.sourceCommit !== preparation.approval.sourceCommit ||
    result.snapshotArn !== preparation.approval.snapshot.DBSnapshotArn ||
    result.remainingLegacyRequests !== 0 ||
    JSON.stringify(result.deletedRequests) !== JSON.stringify(ids(ALLOWED, 'request_id')) ||
    JSON.stringify(result.deletedJobs) !== JSON.stringify(ids(ALLOWED, 'job_id'))
  )
    throw Error('RETIREMENT_NOT_VERIFIED');
  for (const table of [
    'devices',
    'device_certificates',
    'users',
    'user_roles',
    'user_scopes',
    'device_state_history',
    'device_latest_state',
    'audit_logs',
  ])
    if (
      !/^\d+$/.test(result.preservedTables?.[table]?.count) ||
      !/^[a-f0-9]{32}$/.test(result.preservedTables[table].digest)
    )
      throw Error('PRESERVATION_PROOF_MISSING');
  if (
    !Array.isArray(result.certificateIdentityRows) ||
    String(result.certificateIdentityRows.length) !== result.preservedTables.device_certificates.count
  )
    throw Error('CERTIFICATE_PROOF_MISSING');
  return result;
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
export function main(input, buildId, output) {
  if (!output || !new RegExp(`^${RETIREMENT_PROJECT}:[a-f0-9-]{36}$`).test(buildId ?? ''))
    throw Error('INVALID_ARGUMENTS');
  const prep = JSON.parse(readFileSync(input));
  validateApproval(prep.approval);
  if (aws(['sts', 'get-caller-identity']).Account !== DB_TARGET.accountId) throw Error('WRONG_TEST_ACCOUNT');
  const snapshot = aws([
    'rds',
    'describe-db-snapshots',
    '--db-snapshot-identifier',
    prep.approval.snapshot.DBSnapshotIdentifier,
    '--query',
    'DBSnapshots[0].{Status:Status,Encrypted:Encrypted,DBSnapshotArn:DBSnapshotArn,DBInstanceIdentifier:DBInstanceIdentifier,SnapshotCreateTime:SnapshotCreateTime}',
  ]);
  if (
    snapshot.Status !== 'available' ||
    snapshot.Encrypted !== true ||
    snapshot.DBSnapshotArn !== prep.approval.snapshot.DBSnapshotArn ||
    snapshot.DBInstanceIdentifier !== 'fdp-test-db'
  )
    throw Error('SNAPSHOT_NOT_VERIFIED');
  const build = aws([
    'codebuild',
    'batch-get-builds',
    '--ids',
    buildId,
    '--query',
    'builds[0].{id:id,status:buildStatus,startTime:startTime,endTime:endTime,serviceRole:serviceRole,vpcConfig:vpcConfig,sourceType:source.type,buildspec:source.buildspec,logs:logs}',
  ]);
  if (
    build.id !== buildId ||
    build.status !== 'SUCCEEDED' ||
    build.serviceRole !== prep.project.serviceRole ||
    build.sourceType !== 'NO_SOURCE' ||
    build.buildspec !== prep.project.source.buildspec ||
    JSON.stringify(build.vpcConfig) !== JSON.stringify(prep.project.vpcConfig) ||
    Date.parse(snapshot.SnapshotCreateTime) > Date.parse(build.startTime)
  )
    throw Error('BUILD_NOT_VERIFIED');
  const log = aws([
    'logs',
    'get-log-events',
    '--log-group-name',
    build.logs.groupName,
    '--log-stream-name',
    build.logs.streamName,
    '--start-from-head',
  ]);
  const frames = log.events.flatMap((e) => {
    try {
      const d = JSON.parse(e.message.trim());
      return d.kind === 'fdp-qa09-legacy-retirement/v1' ? [d] : [];
    } catch {
      return [];
    }
  });
  if (frames.length !== 1) throw Error('RETIREMENT_RECEIPT_COUNT');
  const result = validateRetirementReceipt(frames[0], prep, buildId);
  build.buildspecSha256 = createHash('sha256').update(build.buildspec).digest('hex');
  delete build.buildspec;
  const receipt = {
    schemaVersion: '1.0',
    task: 'QA-09',
    scope: 'APPROVED_LEGACY_RETIREMENT_ONLY',
    gate: 'PASS',
    snapshot,
    build,
    result,
    migrationGate: 'NOT RUN',
    fullQa09Accepted: false,
  };
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(
    JSON.stringify({
      gate: receipt.gate,
      buildId,
      deletedRequests: result.deletedRequests.length,
      deletedJobs: result.deletedJobs.length,
      preservedTables: Object.keys(result.preservedTables).length,
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
