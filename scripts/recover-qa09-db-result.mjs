import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeFixtureFrames } from './qa09-db-log-frames.mjs';
import { validatePlan } from './qa09-ten-device-db.mjs';
const [originalFile, output, capturedLogFile] = process.argv.slice(2);
const originalBytes = readFileSync(originalFile),
  original = JSON.parse(originalBytes),
  prepBytes = readFileSync(originalFile + '.preparation.json'),
  prep = JSON.parse(prepBytes);
validatePlan(prep.plan);
const id = original.build?.id;
if (!/^fdp-test-qa09-ten-device-fixtures:[a-f0-9-]{36}$/.test(id ?? '') || !/^[a-f0-9]{64}$/.test(prep.sourceHash))
  throw Error('ORIGINAL_BUILD_AND_SOURCE_REQUIRED');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const aws = (args) => {
  const x = spawnSync(
    'aws',
    [
      ...args,
      '--profile',
      'esgiot-readonly',
      '--region',
      'ap-southeast-1',
      '--output',
      'json',
      '--no-cli-pager',
      '--cli-connect-timeout',
      '5',
      '--cli-read-timeout',
      '10',
    ],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (x.status !== 0)
    throw Object.assign(Error('RECOVERY_AWS_READ_FAILED'), {
      code: x.stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] ?? 'CLI_FAILED',
    });
  return JSON.parse(x.stdout);
};
const source = readFileSync(new URL(import.meta.url));
const r = {
  task: 'QA-09',
  scope: 'COMPLETED_BUILD_READ_ONLY_RESULT_RECOVERY',
  recoveredFrom: originalFile,
  recoveredFromSha256: sha(originalBytes),
  preparationSha256: sha(prepBytes),
  recoverySourceHash: sha(source),
  recoverySourceBase64: source.toString('base64'),
  startedAt: new Date().toISOString(),
  writes: 0,
  gate: 'RUNNING',
};
try {
  if (aws(['sts', 'get-caller-identity']).Account !== '065986019555') throw Error('WRONG_ACCOUNT');
  const build = aws([
    'codebuild',
    'batch-get-builds',
    '--ids',
    id,
    '--query',
    'builds[0].{id:id,status:buildStatus,phase:currentPhase,startTime:startTime,endTime:endTime,serviceRole:serviceRole,vpcConfig:vpcConfig,buildspec:source.buildspec,sourceType:source.type,logs:logs}',
  ]);
  if (
    build.status !== 'SUCCEEDED' ||
    build.id !== id ||
    build.serviceRole !== prep.project.serviceRole ||
    build.buildspec !== prep.project.source.buildspec ||
    build.sourceType !== 'NO_SOURCE' ||
    JSON.stringify(build.vpcConfig) !== JSON.stringify(prep.project.vpcConfig)
  )
    throw Error('COMPLETED_BUILD_NOT_BOUND');
  const log = capturedLogFile
    ? JSON.parse(readFileSync(capturedLogFile))
    : aws([
        'logs',
        'get-log-events',
        '--log-group-name',
        build.logs.groupName,
        '--log-stream-name',
        build.logs.streamName,
        '--start-from-head',
      ]);
  if (capturedLogFile)
    r.capturedLogResponse = {
      path: capturedLogFile,
      sha256: sha(readFileSync(capturedLogFile)),
      scope: 'PRIOR_SUCCESSFUL_AWS_GET_LOG_EVENTS_RESPONSE_NOT_AN_INDEPENDENT_FRESH_READ',
    };
  const frames = decodeFixtureFrames(log.events);
  if (
    frames.length !== 1 ||
    frames[0].buildId !== id ||
    frames[0].sourceHash !== prep.sourceHash ||
    frames[0].prefix !== prep.plan.prefix ||
    frames[0].action !== prep.plan.action ||
    frames[0].gate !== 'PASS'
  )
    throw Error('RECOVERED_FRAME_NOT_BOUND');
  delete build.buildspec;
  Object.assign(r, {
    gate: 'PASS',
    build,
    sourceHash: prep.sourceHash,
    buildspecHash: prep.buildspecHash,
    result: frames[0],
  });
} catch (e) {
  r.gate = 'FAIL';
  r.errorCode = e.code ?? e.message;
}
r.finishedAt = new Date().toISOString();
writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
console.log(JSON.stringify({ gate: r.gate, errorCode: r.errorCode, action: r.result?.action }));
process.exitCode = r.gate === 'PASS' ? 0 : 1;
