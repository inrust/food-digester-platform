import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { prepareProbe } from './prepare-qa09-db-readonly-probe.mjs';
import { PROJECT, validatePlan } from './qa09-ten-device-db.mjs';
import { readVerifiedFixtureFrame } from './qa09-db-frame-wait.mjs';
const hash = (v) => createHash('sha256').update(v).digest('hex');
function aws(args, profile = 'esgiot-infra') {
  const r = spawnSync(
    'aws',
    [...args, '--profile', profile, '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'],
    {
      encoding: 'utf8',
      timeout: ['get-log-events', 'batch-get-builds', 'batch-get-projects'].includes(args[1]) ? 150000 : 30000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, AWS_MAX_ATTEMPTS: '1' },
    },
  );
  if (r.status !== 0) {
    const code =
      r.stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] ??
      (r.error?.code === 'ETIMEDOUT' ? 'CLI_READ_TIMEOUT' : 'CLI_FAILED');
    throw Object.assign(Error('AWS_OPERATION_FAILED'), { code: `AWS_${args[1]}_${code}` });
  }
  return r.stdout ? JSON.parse(r.stdout) : null;
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
export async function runFixture(plan, evidencePath, onProgress = () => {}) {
  const prep = prepareFixture(plan);
  writeFileSync(evidencePath + '.preparation.json', JSON.stringify(prep, null, 2) + '\n');
  const identity = aws(['sts', 'get-caller-identity']);
  if (identity.Account !== '065986019555') throw Error('WRONG_ACCOUNT');
  const existing = aws(['codebuild', 'batch-get-projects', '--names', PROJECT]);
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
  const start = aws([
    'codebuild',
    'start-build',
    '--project-name',
    PROJECT,
    ...(reuseReviewedBuildspec
      ? [
          '--environment-variables-override',
          JSON.stringify(
            prep.project.environment.environmentVariables.filter((x) =>
              ['QA09_FIXTURE_HASH', 'QA09_FIXTURE_PLAN_B64'].includes(x.name),
            ),
          ),
        ]
      : []),
    '--query',
    'build.{id:id,status:buildStatus,startTime:startTime}',
  ]);
  writeFileSync(evidencePath, JSON.stringify({ gate: 'RUNNING', build: start }, null, 2) + '\n');
  let build;
  let phase;
  const deadline = Date.now() + 1020000;
  do {
    build = aws([
      'codebuild',
      'batch-get-builds',
      '--ids',
      start.id,
      '--query',
      'builds[0].{id:id,status:buildStatus,phase:currentPhase,startTime:startTime,endTime:endTime,serviceRole:serviceRole,vpcConfig:vpcConfig,buildspec:source.buildspec,sourceType:source.type,logs:logs}',
    ]);
    if (phase !== build.phase) {
      phase = build.phase;
      onProgress(plan.action + ': ' + phase);
    }
    if (build.status !== 'IN_PROGRESS') break;
    if (Date.now() > deadline) throw Error('BUILD_TIMEOUT');
    await new Promise((r) => setTimeout(r, 10000));
  } while (build.status === 'IN_PROGRESS');
  if (
    build.status !== 'SUCCEEDED' ||
    build.id !== start.id ||
    build.buildspec !== prep.project.source.buildspec ||
    build.sourceType !== 'NO_SOURCE' ||
    build.serviceRole !== prep.project.serviceRole ||
    JSON.stringify(build.vpcConfig) !== JSON.stringify(prep.project.vpcConfig)
  )
    throw Error('FIXTURE_BUILD_NOT_VERIFIED');
  let verified;
  try {
    verified = await readVerifiedFixtureFrame(
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
          'esgiot-readonly',
        ),
      { buildId: start.id, sourceHash: prep.sourceHash, prefix: plan.prefix, action: plan.action },
    );
  } catch (e) {
    delete build.buildspec;
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          gate: 'FAIL',
          build,
          sourceHash: prep.sourceHash,
          buildspecHash: prep.buildspecHash,
          finishedAt: new Date().toISOString(),
          failure: {
            code: e.code ?? e.message,
            kind: 'CLIENT_RESULT_READ_OR_VERIFICATION',
            observations: e.observations ?? [],
          },
        },
        null,
        2,
      ) + '\n',
    );
    throw e;
  }
  delete build.buildspec;
  const receipt = {
    gate: 'PASS',
    build,
    sourceHash: prep.sourceHash,
    buildspecHash: prep.buildspecHash,
    result: verified.frame,
    resultReadObservations: verified.observations,
  };
  writeFileSync(evidencePath, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
