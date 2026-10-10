import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { prepareProbe } from './prepare-qa09-db-readonly-probe.mjs';
import { PROJECT, validatePlan } from './qa09-ten-device-db.mjs';
import { readVerifiedFixtureFrame } from './qa09-db-frame-wait.mjs';
import {
  classifySafeCliError,
  safeOperationError,
  readPreStartFixtureOperation,
} from './qa09-operation-observation.mjs';
import { readStartedFixtureBuild, STARTED_BUILD_QUERY } from './qa09-started-build-read.mjs';
const hash = (v) => createHash('sha256').update(v).digest('hex');
export const classifyFixtureCliError = classifySafeCliError;
export function fixtureAws(
  args,
  profile = 'esgiot-infra',
  { spawn = spawnSync, now = () => performance.now(), timeoutMs = 30000 } = {},
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('INVALID_FIXTURE_CLI_TIMEOUT');
  const started = now();
  const r = spawn(
    'aws',
    [
      ...args,
      '--profile',
      profile,
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
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, AWS_MAX_ATTEMPTS: '1' },
    },
  );
  const observation = {
    exitStatus: r.status,
    signal: r.signal ?? null,
    spawnErrorCode: r.error?.code ?? null,
    stderrBytes: Buffer.byteLength(r.stderr ?? ''),
    durationMs: Math.max(0, Math.round(now() - started)),
  };
  if (r.status !== 0)
    throw Object.assign(Error('AWS_OPERATION_FAILED'), {
      code: `AWS_${args[1]}_${classifyFixtureCliError(r.stderr, r.error)}`,
      cliObservation: observation,
    });
  try {
    return r.stdout ? JSON.parse(r.stdout) : null;
  } catch {
    throw Object.assign(Error('AWS_OPERATION_FAILED'), { code: 'CLI_INVALID_JSON', cliObservation: observation });
  }
}
export function prepareFixture(plan) {
  validatePlan(plan);
  const { project } = prepareProbe();
  const source = readFileSync(new URL('./qa09-ten-device-db.mjs', import.meta.url));
  const helper = readFileSync(new URL('./qa09-db-readonly-probe.mjs', import.meta.url));
  project.name = PROJECT;
  project.description = 'QA09 exact ten own test fixtures; fixed seed/read-only observation/cleanup';
  project.timeoutInMinutes = 15;
  project.logsConfig.cloudWatchLogs.streamName = 'qa09-ten-device';
  const spec = JSON.parse(project.source.buildspec);
  spec.phases.install.commands = spec.phases.install.commands.filter((c) => !c.startsWith('node -e'));
  for (const [name, code] of [
    ['fixture.mjs', source],
    ['qa09-db-readonly-probe.mjs', helper],
  ])
    spec.phases.install.commands.push(
      `node -e "require('node:fs').writeFileSync('${name}',require('node:zlib').gunzipSync(Buffer.from('${gzipSync(code).toString('base64')}','base64')))"`,
    );
  spec.phases.build.commands = ['cd /tmp/qa09-db-probe', 'node fixture.mjs'];
  project.source.buildspec = JSON.stringify(spec);
  if (Buffer.byteLength(project.source.buildspec) > 25600) throw Error('FIXTURE_BUILDSPEC_TOO_LARGE');
  project.environment.environmentVariables = [
    project.environment.environmentVariables[0],
    { name: 'QA09_FIXTURE_HASH', value: hash(source), type: 'PLAINTEXT' },
    { name: 'QA09_FIXTURE_PLAN_B64', value: Buffer.from(JSON.stringify(plan)).toString('base64'), type: 'PLAINTEXT' },
  ];
  return { plan, sourceHash: hash(source), buildspecHash: hash(project.source.buildspec), project };
}
export async function runFixture(plan, evidencePath, onProgress = () => {}, { logProfile = 'esgiot-readonly' } = {}) {
  if (!['esgiot-readonly', 'esgiot-infra'].includes(logProfile)) throw Error('INVALID_FIXTURE_READ_PROFILE');
  if ([evidencePath, evidencePath + '.preparation.json', evidencePath + '.started.json'].some(existsSync))
    throw Error('FRESH_FIXTURE_EVIDENCE_REQUIRED');
  const prep = prepareFixture(plan);
  writeFileSync(evidencePath + '.preparation.json', JSON.stringify(prep, null, 2) + '\n');
  const operations = [],
    buildReads = [],
    preStartReads = [];
  let start, build, readResult;
  let startAttempted = false;
  const persist = (gate, extra = {}) =>
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          gate,
          ...(start ? { build: build ? { ...build, buildspec: undefined, environment: undefined } : start } : {}),
          sourceHash: prep.sourceHash,
          buildspecHash: prep.buildspecHash,
          operations,
          buildReads,
          preStartReads,
          ...extra,
        },
        null,
        2,
      ) + '\n',
    );
  const aws = (args, profile = 'esgiot-infra', limits = {}) => {
    const row = {
      sequence: operations.length + 1,
      operation: args[1],
      profile,
      startedAt: new Date().toISOString(),
      result: 'RUNNING',
    };
    operations.push(row);
    persist('RUNNING');
    const tick = performance.now();
    try {
      const value = fixtureAws(args, profile, limits);
      row.result = 'PASS';
      return value;
    } catch (error) {
      row.result = 'FAIL';
      row.failure = safeOperationError(error);
      throw error;
    } finally {
      row.durationMs = Math.round(performance.now() - tick);
      persist('RUNNING');
    }
  };
  const preStartRead = async (args) => {
    const result = await readPreStartFixtureOperation(
      args[0] + ':' + args[1],
      (limits) => aws(args, 'esgiot-infra', limits),
      { observations: preStartReads, onObservation: () => persist('RUNNING') },
    );
    return result.value;
  };
  try {
    const identity = await preStartRead(['sts', 'get-caller-identity']);
    if (identity.Account !== '065986019555') throw Error('WRONG_ACCOUNT');
    const existing = await preStartRead(['codebuild', 'batch-get-projects', '--names', PROJECT]);
    if (existing.projects.length && existing.projects[0].serviceRole !== prep.project.serviceRole)
      throw Error('FIXTURE_PROJECT_ROLE_MISMATCH');
    const reuseReviewedBuildspec = existing.projects[0]?.source?.buildspec === prep.project.source.buildspec;
    const temp = mkdtempSync(join(tmpdir(), 'qa09-fixture-'));
    try {
      const file = join(temp, 'project.json');
      const projectInput = { ...prep.project };
      if (existing.projects.length) delete projectInput.serviceRole;
      writeFileSync(file, JSON.stringify(projectInput));
      if (!reuseReviewedBuildspec)
        aws([
          'codebuild',
          existing.projects.length ? 'update-project' : 'create-project',
          '--cli-input-json',
          'file://' + file,
        ]);
    } finally {
      rmSync(temp, { recursive: true });
    }
    startAttempted = true;
    start = aws([
      'codebuild',
      'start-build',
      '--project-name',
      PROJECT,
      '--environment-variables-override',
      JSON.stringify(
        prep.project.environment.environmentVariables.filter((x) =>
          ['QA09_FIXTURE_HASH', 'QA09_FIXTURE_PLAN_B64'].includes(x.name),
        ),
      ),
      '--query',
      'build.{id:id,status:buildStatus,startTime:startTime}',
    ]);
    writeFileSync(
      evidencePath + '.started.json',
      JSON.stringify(
        {
          gate: 'STARTED',
          build: start,
          sourceHash: prep.sourceHash,
          buildspecHash: prep.buildspecHash,
          preparationSha256: hash(readFileSync(evidencePath + '.preparation.json')),
        },
        null,
        2,
      ) + '\n',
    );
    persist('RUNNING');
    let phase;
    readResult = await readStartedFixtureBuild(
      prep,
      start.id,
      (id) => aws(['codebuild', 'batch-get-builds', '--ids', id, '--query', STARTED_BUILD_QUERY]),
      {
        observations: buildReads,
        onObservation: (row) => {
          if (row.phase && phase !== row.phase) {
            phase = row.phase;
            onProgress(plan.action + ': ' + phase);
          }
          persist('RUNNING');
        },
      },
    );
    build = readResult.build;
    const verified = await readVerifiedFixtureFrame(
      () =>
        aws(
          [
            'logs',
            'get-log-events',
            '--log-group-name',
            build.logs.groupName,
            '--log-stream-name',
            build.logs.streamName,
            '--start-from-head',
          ],
          logProfile,
        ),
      { buildId: start.id, sourceHash: prep.sourceHash, prefix: plan.prefix, action: plan.action },
    );
    const resultReadFailures = verified.observations.filter((row) => row.errorCode).length;
    const preStartReadFailures = preStartReads.filter((row) => row.result === 'FAIL').length;
    const recovered = readResult.readRecoveries || resultReadFailures || preStartReadFailures;
    persist('PASS', {
      result: verified.frame,
      resultReadObservations: verified.observations,
      resultReadProfile: logProfile,
      readGate: recovered ? 'RECOVERED' : 'PASS',
      originalReadGate: recovered ? 'FAIL' : 'PASS',
      preStartReadFailures,
      resultReadFailures,
      readRecoveries: readResult.readRecoveries,
    });
    return JSON.parse(readFileSync(evidencePath));
  } catch (error) {
    const unconfirmedStart =
      startAttempted &&
      !start &&
      /CLI_READ_TIMEOUT|CLI_NETWORK_ERROR|CLI_FAILED|CLI_INVALID_JSON|CLI_OUTPUT_LIMIT/.test(
        safeOperationError(error).code,
      );
    persist('FAIL', {
      finishedAt: new Date().toISOString(),
      failure: {
        ...safeOperationError(error),
        kind: start
          ? 'STARTED_BUILD_READ_OR_VERIFICATION'
          : unconfirmedStart
            ? 'START_OUTCOME_UNCONFIRMED'
            : 'PRE_START_OR_MUTATION_FAILURE',
        observations: error.observations ?? [],
        startedBuildMayStillRun:
          unconfirmedStart ||
          (!!start &&
            !['SUCCEEDED', 'FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'].includes(
              build?.status ?? buildReads.at(-1)?.status,
            )),
        recoveryAction: start
          ? 'EXACT_EXISTING_BUILD_READ_ONLY'
          : unconfirmedStart
            ? 'READ_ONLY_DIAGNOSTIC_REQUIRED_NO_RESTART'
            : 'NO_AUTOMATIC_START_RETRY',
      },
    });
    throw error;
  }
}
