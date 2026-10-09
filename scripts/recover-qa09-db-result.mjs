import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readVerifiedFixtureFrame } from './qa09-db-frame-wait.mjs';
import { decodeFixtureFrames } from './qa09-db-log-frames.mjs';
import { validatePlan } from './qa09-ten-device-db.mjs';
import { fixtureAws } from './qa09-ten-device-bridge.mjs';
import { readStartedFixtureBuild, STARTED_BUILD_QUERY } from './qa09-started-build-read.mjs';
import { safeOperationError } from './qa09-operation-observation.mjs';
const [originalFile, output, capturedLogFile] = process.argv.slice(2);
if (!originalFile || !output || existsSync(output) || originalFile === output)
  throw Error('FRESH_RECOVERY_OUTPUT_REQUIRED');
const originalBytes = readFileSync(originalFile),
  original = JSON.parse(originalBytes),
  prepBytes = readFileSync(originalFile + '.preparation.json'),
  prep = JSON.parse(prepBytes);
validatePlan(prep.plan);
const id = original.build?.id;
if (!/^fdp-test-qa09-ten-device-fixtures:[a-f0-9-]{36}$/.test(id ?? '') || !/^[a-f0-9]{64}$/.test(prep.sourceHash))
  throw Error('ORIGINAL_BUILD_AND_SOURCE_REQUIRED');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const aws = (args) => fixtureAws(args, 'esgiot-readonly');
const source = readFileSync(new URL(import.meta.url));
const r = {
  task: 'QA-09',
  scope: 'EXACT_STARTED_BUILD_READ_ONLY_RESULT_RECOVERY',
  originalGate: original.gate,
  buildReadObservations: [],
  recoveredFrom: originalFile,
  recoveredFromSha256: sha(originalBytes),
  preparationSha256: sha(prepBytes),
  recoverySourceHash: sha(source),
  recoverySourceBase64: source.toString('base64'),
  dependencySources: [
    'qa09-ten-device-bridge.mjs',
    'qa09-started-build-read.mjs',
    'qa09-operation-observation.mjs',
    'qa09-db-frame-wait.mjs',
    'qa09-db-log-frames.mjs',
    'qa09-ten-device-db.mjs',
  ].map((name) => {
    const bytes = readFileSync(new URL('./' + name, import.meta.url));
    return { name, sha256: sha(bytes), sourceBase64: bytes.toString('base64') };
  }),
  startedAt: new Date().toISOString(),
  writes: 0,
  gate: 'RUNNING',
};
try {
  if (aws(['sts', 'get-caller-identity']).Account !== '065986019555') throw Error('WRONG_ACCOUNT');
  const read = await readStartedFixtureBuild(
    prep,
    id,
    (buildId) => aws(['codebuild', 'batch-get-builds', '--ids', buildId, '--query', STARTED_BUILD_QUERY]),
    {
      maxPolls: 6,
      timeoutMs: 90000,
      observations: r.buildReadObservations,
      onObservation: () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n'),
    },
  );
  const build = read.build;
  r.readGate = read.readGate;
  r.originalReadGate = read.originalReadGate;
  const expected = { buildId: id, sourceHash: prep.sourceHash, prefix: prep.plan.prefix, action: prep.plan.action };
  let frame;
  if (capturedLogFile) {
    const log = JSON.parse(readFileSync(capturedLogFile));
    r.capturedLogResponse = {
      path: capturedLogFile,
      sha256: sha(readFileSync(capturedLogFile)),
      scope: 'PRIOR_SUCCESSFUL_AWS_GET_LOG_EVENTS_RESPONSE_NOT_AN_INDEPENDENT_FRESH_READ',
    };
    const frames = decodeFixtureFrames(log.events);
    if (
      frames.length !== 1 ||
      Object.entries(expected).some(([key, value]) => frames[0][key] !== value) ||
      frames[0].gate !== 'PASS'
    )
      throw Error('FIXTURE_RESULT_NOT_VERIFIED');
    frame = frames[0];
  } else {
    const verified = await readVerifiedFixtureFrame(
      () =>
        aws([
          'logs',
          'get-log-events',
          '--log-group-name',
          build.logs.groupName,
          '--log-stream-name',
          build.logs.streamName,
          '--start-from-head',
        ]),
      expected,
    );
    frame = verified.frame;
    r.resultReadObservations = verified.observations;
    if (verified.observations.some((row) => row.errorCode)) {
      r.readGate = 'RECOVERED';
      r.originalReadGate = 'FAIL';
    }
  }
  delete build.buildspec;
  delete build.environment;
  Object.assign(r, {
    gate: 'PASS',
    build,
    sourceHash: prep.sourceHash,
    buildspecHash: prep.buildspecHash,
    result: frame,
  });
} catch (e) {
  r.gate = 'FAIL';
  r.failure = safeOperationError(e);
  r.errorCode = r.failure.code;
}
r.finishedAt = new Date().toISOString();
writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
console.log(JSON.stringify({ gate: r.gate, errorCode: r.errorCode, action: r.result?.action }));
process.exitCode = r.gate === 'PASS' ? 0 : 1;
