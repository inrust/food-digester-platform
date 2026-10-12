import { validateStartedPreparation, verifyStartedBuild } from './qa09-started-build-read.mjs';
import { PROJECT } from './qa09-ten-device-db.mjs';
import { safeOperationError, transientFixtureRead } from './qa09-operation-observation.mjs';

export const UNKNOWN_START_READ_BUDGET = Object.freeze({
  totalTimeoutMs: 90000,
  cliTimeoutMs: 15000,
  inventoryLimit: 50,
  batchSize: 5,
  maxRecoveries: 2,
  maxCliInvocations: 14,
});

// Resolves only the identity of an existing Build. It never accepts SQL results or cleanup.
export function validateUnknownStart(original, prep) {
  validateStartedPreparation(prep, PROJECT + ':11111111-1111-1111-1111-111111111111');
  if (
    prep.project.serviceRole !== 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' ||
    prep.project.source.type !== 'NO_SOURCE'
  )
    throw Error('FIXTURE_BUILD_BINDING_MISMATCH');
  const starts = original.operations?.filter((x) => x.operation === 'start-build') ?? [];
  const started = Date.parse(starts[0]?.startedAt),
    finished = Date.parse(original.finishedAt);
  if (
    original.gate !== 'FAIL' ||
    original.build ||
    original.failure?.kind !== 'START_OUTCOME_UNCONFIRMED' ||
    original.sourceHash !== prep.sourceHash ||
    original.buildspecHash !== prep.buildspecHash ||
    starts.length !== 1 ||
    starts[0].result !== 'FAIL' ||
    !Number.isFinite(started) ||
    !Number.isFinite(finished) ||
    finished < started
  )
    throw Error('UNKNOWN_START_RECEIPT_REQUIRED');
  return { started, finished };
}

export function inspectUnknownStart(original, prep, builds, { truncated = false } = {}) {
  const { started, finished } = validateUnknownStart(original, prep);
  if (!Array.isArray(builds) || builds.length > 50 || typeof truncated !== 'boolean')
    throw Error('INVALID_UNKNOWN_START_INVENTORY');
  const exact = [],
    times = [],
    ids = new Set();
  for (const b of builds) {
    if (ids.has(b?.id)) throw Error('DUPLICATE_BUILD_INVENTORY_ID');
    ids.add(b?.id);
    const time = Date.parse(b?.startTime);
    if (!Number.isFinite(time)) throw Error('INVALID_BUILD_START_TIME');
    times.push(time);
    try {
      verifyStartedBuild(b, prep, b.id);
      exact.push(b);
    } catch (error) {
      if (!['FIXTURE_BUILD_BINDING_MISMATCH', 'FIXTURE_BUILD_NOT_FOUND'].includes(error.message)) throw error;
    }
  }
  const windowCovered = !truncated || (times.length > 0 && Math.min(...times) <= started - 120000);
  const result = {
    gate: 'UNKNOWN',
    scope: 'EXISTING_BUILD_IDENTITY_ONLY_NOT_EXECUTION_ACCEPTANCE',
    originalGate: 'FAIL',
    originalStartGate: 'UNKNOWN',
    scannedCount: builds.length,
    exactMatches: exact.length,
    windowCovered,
    writes: 0,
    restartAllowed: false,
    absenceProvesNonExecution: false,
    executionGate: 'NOT_ASSESSED',
    cleanupGate: 'NOT_ASSESSED',
  };
  if (!windowCovered) return { ...result, reason: 'INVENTORY_WINDOW_INCOMPLETE' };
  if (exact.length > 1) return { ...result, gate: 'BLOCKED', reason: 'AMBIGUOUS_EXACT_BUILDS' };
  if (!exact.length) return { ...result, reason: 'NO_EXACT_BUILD_OBSERVED' };
  const build = exact[0],
    time = Date.parse(build.startTime);
  if (time < started - 120000 || time > finished + 30000)
    return { ...result, gate: 'BLOCKED', reason: 'EXACT_BUILD_OUTSIDE_START_WINDOW' };
  return {
    ...result,
    gate: 'RESOLVED',
    reason: 'UNIQUE_EXACT_EXISTING_BUILD',
    buildId: build.id,
    status: build.status,
  };
}

// All dependencies are fixed reads. Recovery allowance is shared by every serial batch.
export async function readUnknownStart(
  original,
  prep,
  reads,
  {
    observations = [],
    onObservation = () => {},
    now = () => performance.now(),
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = UNKNOWN_START_READ_BUDGET.totalTimeoutMs,
  } = {},
) {
  validateUnknownStart(original, prep);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > UNKNOWN_START_READ_BUDGET.totalTimeoutMs)
    throw Error('INVALID_UNKNOWN_START_READ_BUDGET');
  const started = now();
  let recoveries = 0;
  async function read(operation, run, context = {}) {
    for (let attempt = 1; ; attempt++) {
      const remaining = Math.floor(timeoutMs - (now() - started));
      if (remaining < 1) throw Error('UNKNOWN_START_READ_TIMEOUT');
      const row = { operation, ...context, attempt, result: 'RUNNING' },
        tick = now();
      observations.push(row);
      onObservation(row);
      try {
        const allowance = Math.floor(timeoutMs - (now() - started));
        if (allowance < 1) throw Error('UNKNOWN_START_READ_TIMEOUT');
        const value = await run({ timeoutMs: Math.min(UNKNOWN_START_READ_BUDGET.cliTimeoutMs, allowance) });
        if (now() - started >= timeoutMs) throw Error('UNKNOWN_START_READ_TIMEOUT');
        row.result = 'PASS';
        return value;
      } catch (error) {
        row.result = 'FAIL';
        row.failure = safeOperationError(error);
        if (
          !transientFixtureRead(error) ||
          recoveries >= UNKNOWN_START_READ_BUDGET.maxRecoveries ||
          now() - started + 250 >= timeoutMs
        )
          throw error;
        recoveries++;
        await pause(250);
      } finally {
        row.durationMs = Math.max(0, Math.round(now() - tick));
        row.elapsedMs = Math.max(0, Math.round(now() - started));
        onObservation(row);
      }
    }
  }
  const identity = await read('sts:get-caller-identity', reads.identity);
  if (identity?.Account !== '065986019555') throw Error('WRONG_ACCOUNT');
  const inventory = await read('codebuild:list-builds-for-project', reads.list);
  const ids = inventory?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length > UNKNOWN_START_READ_BUDGET.inventoryLimit ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !new RegExp(`^${PROJECT}:[a-f0-9-]{36}$`).test(id))
  )
    throw Error('INVALID_UNKNOWN_START_INVENTORY');
  const builds = [];
  for (let offset = 0; offset < ids.length; offset += UNKNOWN_START_READ_BUDGET.batchSize) {
    const batch = ids.slice(offset, offset + UNKNOWN_START_READ_BUDGET.batchSize);
    const details = await read('codebuild:batch-get-builds', (limits) => reads.builds([...batch], limits), {
      batch: offset / UNKNOWN_START_READ_BUDGET.batchSize + 1,
      batchSize: batch.length,
    });
    if (
      !Array.isArray(details) ||
      details.length !== batch.length ||
      new Set(details.map((b) => b?.id)).size !== batch.length ||
      details.some((b) => !batch.includes(b?.id))
    )
      throw Error('UNKNOWN_START_INVENTORY_READ_INCOMPLETE');
    builds.push(...details);
  }
  const inspection = inspectUnknownStart(original, prep, builds, {
    truncated: !!inventory.NextToken || ids.length === UNKNOWN_START_READ_BUDGET.inventoryLimit,
  });
  if (now() - started >= timeoutMs) throw Error('UNKNOWN_START_READ_TIMEOUT');
  return {
    ...inspection,
    readBudget: { ...UNKNOWN_START_READ_BUDGET, totalTimeoutMs: timeoutMs },
    readBatchCount: Math.ceil(ids.length / UNKNOWN_START_READ_BUDGET.batchSize),
    readGate: recoveries ? 'RECOVERED' : 'PASS',
    originalReadGate: recoveries ? 'FAIL' : 'PASS',
    readRecoveries: recoveries,
  };
}
