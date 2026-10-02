import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { prepareProbe } from './prepare-qa09-db-readonly-probe.mjs';
import { PROJECT, validatePlan } from './qa09-ten-device-db.mjs';
const hash = (v) => createHash('sha256').update(v).digest('hex');
function aws(args, profile = 'esgiot-infra') {
  const r = spawnSync(
    'aws',
    [...args, '--profile', profile, '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    const code = r.stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] ?? 'CLI_FAILED';
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
  project.logsConfig.cloudWatchLogs.streamName = 'qa09-ten-device';
  const spec = JSON.parse(project.source.buildspec);
  spec.phases.install.commands = spec.phases.install.commands.filter((c) => !c.startsWith('node -e'));
  for (const [name, code] of [
    ['fixture.mjs', source],
    ['qa09-db-readonly-probe.mjs', helper],
  ])
    spec.phases.install.commands.push(
      `node -e "require('node:fs').writeFileSync('${name}',Buffer.from('${code.toString('base64')}','base64'))"`,
    );
  spec.phases.build.commands = ['cd /tmp/qa09-db-probe', 'node fixture.mjs'];
  project.source.buildspec = JSON.stringify(spec);
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
  const temp = mkdtempSync(join(tmpdir(), 'qa09-fixture-'));
  try {
    const file = join(temp, 'project.json');
    const projectInput = { ...prep.project };
    if (existing.projects.length) delete projectInput.serviceRole;
    writeFileSync(file, JSON.stringify(projectInput));
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
    '--query',
    'build.{id:id,status:buildStatus,startTime:startTime}',
  ]);
  writeFileSync(evidencePath, JSON.stringify({ gate: 'RUNNING', build: start }, null, 2) + '\n');
  let build;
  let phase;
  const deadline = Date.now() + 420000;
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
  const log = aws(
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
  );
  const frames = log.events.flatMap((e) => {
    try {
      const v = JSON.parse(e.message);
      return v.kind === 'fdp-qa09-ten-device-db/v1' ? [v] : [];
    } catch {
      return [];
    }
  });
  if (
    frames.length !== 1 ||
    frames[0].buildId !== start.id ||
    frames[0].sourceHash !== prep.sourceHash ||
    frames[0].prefix !== plan.prefix ||
    frames[0].action !== plan.action ||
    frames[0].gate !== 'PASS'
  )
    throw Error('FIXTURE_RESULT_NOT_VERIFIED');
  delete build.buildspec;
  const receipt = {
    gate: 'PASS',
    build,
    sourceHash: prep.sourceHash,
    buildspecHash: prep.buildspecHash,
    result: frames[0],
  };
  writeFileSync(evidencePath, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
