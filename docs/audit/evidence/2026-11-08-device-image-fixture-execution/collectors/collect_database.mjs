/** Read only a known approved Build and its structured database frame; never start jobs. */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateSnapshot } from '../../../../../scripts/collect-qa09-db-readonly.mjs';
import { assertRedacted } from '../../../../../scripts/device-image-target-package.mjs';
const base = new URL('../', import.meta.url);
const previous = new URL('../../2026-11-08-device-image-fixture-preparation/', import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, base)));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const known = load('known-build.json');
const request = JSON.parse(readFileSync(new URL('readonly-db-start.request.json', previous)));
const source = JSON.parse(readFileSync(new URL('readonly-db-source.json', previous)));
const window = load('approved-preparation-window.json');
const metadata = load('current-readonly-observations.json');
const project = metadata.projects.data.projects.find((row) => row.name === request.projectName);
const aws = (args) => JSON.parse(execFileSync('aws', [...args, '--profile', 'esgiot-readonly', '--region', 'ap-southeast-1',
  '--output', 'json', '--no-cli-pager', '--cli-connect-timeout', '5', '--cli-read-timeout', '15'],
{ timeout: 30000, maxBuffer: 8*1024*1024, env: { ...process.env, AWS_MAX_ATTEMPTS:'1', AWS_PAGER:'' }, stdio:['ignore','pipe','pipe'] }));
const builds = aws(['codebuild','batch-get-builds','--ids',known.id,'--query',
  'builds[].{id:id,status:buildStatus,startTime:startTime,endTime:endTime,serviceRole:serviceRole,vpcConfig:vpcConfig,logs:logs,sourceType:source.type,buildspec:source.buildspec}']);
const build = builds[0];
if (builds.length !== 1 || build.id !== known.id || build.status !== 'SUCCEEDED' || build.sourceType !== 'NO_SOURCE' ||
  build.buildspec !== request.buildspecOverride || build.serviceRole !== project.serviceRole || !isDeepStrictEqual(build.vpcConfig,project.vpc))
  throw Error('BUILD_SOURCE_ROLE_OR_VPC_NOT_VERIFIED');
const frames = [],pages=[];
let token;
for (let i=0;i<20;i++) {
  const args=['logs','get-log-events','--log-group-name',build.logs.groupName,'--log-stream-name',build.logs.streamName,'--start-from-head','--limit','10000'];
  if (token) args.push('--next-token',token);
  const page = aws(args); pages.push({events:page.events.length});
  for (const event of page.events) {
    try { const v=JSON.parse(event.message.trim()); if(v.kind==='fdp-qa09-db-readonly/v1') frames.push(v); } catch { /* Non-frame build logs are not copied. */ }
  }
  if (token===page.nextForwardToken) break;
  token=page.nextForwardToken;
  if(i===19) throw Error('LOG_PAGINATION_INCOMPLETE');
}
if(frames.length!==1) throw Error('DATABASE_FRAME_MISSING_OR_DUPLICATED');
const snapshot=validateSnapshot(frames[0],{manifest:source.manifest,probeSha256:source.probeSha256},known.id);
assertRedacted(snapshot);
if(Date.parse(snapshot.executedAt)<Date.parse(window.startsAt)||Date.parse(snapshot.executedAt)>Date.parse(window.endsAt)) throw Error('SNAPSHOT_OUTSIDE_PREPARATION_WINDOW');
const schemaPassed=source.manifest.tables.every((table)=>snapshot.counts[table].status==='OBSERVED');
if(snapshot.migrationComparison.status!=='PASS'||!schemaPassed) throw Error('NATIVE_SCHEMA_OR_MIGRATION_BLOCKED');
writeFileSync(new URL('database-snapshot.json',base),JSON.stringify(snapshot,null,2)+'\n');
const result={status:'PASS_NATIVE_READ_ONLY_PREPARATION',sourceCommit:source.sourceCommit,buildId:known.id,
  capturedAt:new Date().toISOString(),snapshotAt:snapshot.executedAt,databaseReadOnly:snapshot.identity.read_only,
  businessDataWrites:snapshot.businessDataWrites,migrationsExpected:source.manifest.migrations.length,
  migrationsApplied:snapshot.migrations.filter((r)=>r.finished_at&&!r.rolled_back_at).length,
  migrationComparison:snapshot.migrationComparison,tables:source.manifest.tables.length,schemaPassed,
  sourceAndRoleAndVpcVerified:true,buildspecSha256:sha(build.buildspec),startBuildOverrides:true,
  exactApprovedRequestSha256:known.requestSha256,snapshotSha256:sha(readFileSync(new URL('database-snapshot.json',base))),
  pages,windowScope:'PREPARATION_ONLY_NOT_G4',g4:'NOT_RUN',databaseMigrationStarted:false,deploymentStarted:false};
writeFileSync(new URL('database-verification.json',base),JSON.stringify(result,null,2)+'\n');
process.stdout.write(JSON.stringify({status:result.status,migrations:result.migrationsApplied,tables:result.tables,buildId:known.id,g4:'NOT_RUN'})+'\n');
