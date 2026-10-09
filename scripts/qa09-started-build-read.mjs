import { createHash } from 'node:crypto';
import { validatePlan, PROJECT } from './qa09-ten-device-db.mjs';
import { safeOperationError, transientFixtureRead } from './qa09-operation-observation.mjs';
const hash = (v) => createHash('sha256').update(v).digest('hex');
export function validateStartedPreparation(prep, buildId) {
  validatePlan(prep.plan);
  if (
    !new RegExp(`^${PROJECT}:[a-f0-9-]{36}$`).test(buildId ?? '') ||
    !/^[a-f0-9]{64}$/.test(prep.sourceHash ?? '') ||
    hash(prep.project.source.buildspec) !== prep.buildspecHash ||
    prep.project.name !== PROJECT
  )
    throw Error('FIXTURE_BUILD_BINDING_MISMATCH');
  const vars = prep.project.environment.environmentVariables;
  if (
    vars.filter((x) => x.name === 'QA09_FIXTURE_HASH').length !== 1 ||
    vars.filter((x) => x.name === 'QA09_FIXTURE_PLAN_B64').length !== 1 ||
    vars.find((x) => x.name === 'QA09_FIXTURE_HASH').value !== prep.sourceHash ||
    vars.find((x) => x.name === 'QA09_FIXTURE_PLAN_B64').value !==
      Buffer.from(JSON.stringify(prep.plan)).toString('base64')
  )
    throw Error('FIXTURE_BUILD_BINDING_MISMATCH');
}
export function verifyStartedBuild(build, prep, buildId) {
  validateStartedPreparation(prep, buildId);
  const vars = build?.environment?.environmentVariables ?? [];
  const expected = prep.project.environment.environmentVariables.filter((x) =>
    ['QA09_FIXTURE_HASH', 'QA09_FIXTURE_PLAN_B64'].includes(x.name),
  );
  if (!build) throw Error('FIXTURE_BUILD_NOT_FOUND');
  if (
    build.id !== buildId ||
    build.buildspec !== prep.project.source.buildspec ||
    build.sourceType !== 'NO_SOURCE' ||
    build.serviceRole !== prep.project.serviceRole ||
    JSON.stringify(build.vpcConfig) !== JSON.stringify(prep.project.vpcConfig) ||
    expected.some(
      (x) =>
        vars.filter((v) => v.name === x.name).length !== 1 ||
        !vars.some((v) => v.name === x.name && v.value === x.value && v.type === x.type),
    )
  )
    throw Error('FIXTURE_BUILD_BINDING_MISMATCH');
  if (!['IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'].includes(build.status))
    throw Error('FIXTURE_BUILD_NOT_VERIFIED');
  return build;
}
// This function has no mutation dependency. Each call may read only the exact known ID.
export async function readStartedFixtureBuild(
  prep,
  buildId,
  read,
  {
    observations = [],
    onObservation = () => {},
    now = () => Date.now(),
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxPolls = 103,
    timeoutMs = 1020000,
    maxReadRecoveries = 2,
  } = {},
) {
  validateStartedPreparation(prep, buildId);
  if (
    !Number.isInteger(maxPolls) ||
    maxPolls < 1 ||
    maxPolls > 103 ||
    timeoutMs < 1 ||
    timeoutMs > 1020000 ||
    !Number.isInteger(maxReadRecoveries) ||
    maxReadRecoveries < 0 ||
    maxReadRecoveries > 2
  )
    throw Error('INVALID_STARTED_BUILD_READ_BUDGET');
  const started = now();
  let recoveries = 0;
  for (let poll = 1; poll <= maxPolls && now() - started <= timeoutMs; poll++) {
    let build;
    const row = { poll, buildId, startedAt: new Date().toISOString(), result: 'RUNNING' };
    observations.push(row);
    onObservation(row);
    try {
      build = verifyStartedBuild(await read(buildId), prep, buildId);
      row.result = 'PASS';
      row.status = build.status;
      row.phase = build.phase;
    } catch (error) {
      row.result = 'FAIL';
      row.failure = safeOperationError(error);
      onObservation(row);
      if (!transientFixtureRead(error) || recoveries >= maxReadRecoveries || now() - started >= timeoutMs) throw error;
      recoveries++;
      await pause(2000);
      continue;
    }
    onObservation(row);
    if (build.status === 'SUCCEEDED')
      return {
        build,
        observations,
        readRecoveries: recoveries,
        readGate: recoveries ? 'RECOVERED' : 'PASS',
        originalReadGate: recoveries ? 'FAIL' : 'PASS',
      };
    if (build.status !== 'IN_PROGRESS') throw Error('FIXTURE_BUILD_NOT_VERIFIED');
    if (poll < maxPolls && now() - started < timeoutMs) await pause(10000);
  }
  throw Error('BUILD_TIMEOUT');
}
export const STARTED_BUILD_QUERY =
  'builds[0].{id:id,status:buildStatus,phase:currentPhase,startTime:startTime,endTime:endTime,serviceRole:serviceRole,vpcConfig:vpcConfig,buildspec:source.buildspec,sourceType:source.type,environment:environment,logs:logs}';
