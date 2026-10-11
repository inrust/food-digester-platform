import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observerPlanDefaults, buildEntryOutputTargetPlan } from './qa09-contract-entry-output-plan.mjs';
test('design adopts only two proven seams; new flag/target wiring remain unimplemented and default off', () => {
  const p = buildEntryOutputTargetPlan();
  assert.equal(p.flag.default, false);
  assert.equal(p.flag.implemented, false);
  assert.equal(p.readyToDeploy, false);
  assert.equal(p.executesAws, false);
  assert.equal(p.compilerOnlyAttribution, false);
  assert.deepEqual(
    p.sequence.map((s) => s.observerCost).filter((v) => v !== undefined),
    [false, true, false],
  );
  assert.equal(p.sequence[0].accountReadCandidate, p.sequence[2].accountReadCandidate);
});
for (const [name, override] of Object.entries({
  production: { environment: 'prod' },
  pool: { poolMax: 2 },
  memory: { memoryMiB: 1024 },
  concurrency: { reservedConcurrency: 13 },
  records: { intervalRecordsMax: 65 },
  bytes: { summaryBytesMax: 4097 },
  summaries: { summaryRecordsMax: 2 },
  database: { databaseStaticConnections: 71 },
  available: { databaseAvailableConnections: 71 },
  requests: { samplingPatchMax: 13 },
  privateProfiler: { inspectorSessions: 1 },
  extraRead: { extraQueries: 1 },
  await: { extraAwaits: 1 },
  yield: { forcedYields: 1 },
  missingPublic: { publicBoundaries: false },
  missingDetail: { detailed: false },
  missingEngine: { engine: false },
  missingPreconnect: { preconnect: false },
  accountConfounder: { accountReadCandidate: false },
}))
  test(`reject unreviewed ${name} input`, () =>
    assert.throws(() => buildEntryOutputTargetPlan(override), /OBSERVER_PLAN_FIXED_BUDGET/));
test('unknown controls and mutation cannot widen the fixed plan', () => {
  assert.throws(() => buildEntryOutputTargetPlan({ iamChange: true }), /OBSERVER_PLAN_UNKNOWN_INPUT/);
  assert.throws(() => {
    observerPlanDefaults.poolMax = 2;
  }, TypeError);
});
