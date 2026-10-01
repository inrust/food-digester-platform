import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLoadPlan, latencySummary, expectedAggregates, checkConsistency } from './reliability-plan.mjs';
import { validateReliability } from './run-reliability-suite.mjs';
function proof() {
  const plan = buildLoadPlan();
  return {
    task: 'QA-07',
    status: 'PASS',
    cleanup: 'PASS',
    prefix: 'QA07-123456ABCDEF',
    profile: 'quick',
    config: plan.config,
    deviceCount: 10,
    telemetrySeconds: 10,
    heartbeatSeconds: 60,
    historyHours: 24,
    historyExecutedSeconds: 480,
    uniqueTelemetry: 900,
    uniqueHeartbeat: 20,
    duplicatesInjected: 45,
    reorderedInjected: 18,
    burstMultiplier: 30,
    receipts: 920,
    archived: 900,
    archiveHashesVerified: 900,
    quarantined: 0,
    partialRetries: 1,
    sendRetries: 1,
    unresolvedGaps: 0,
    untrackedMissing: 0,
    pendingAfterRecovery: 0,
    replaySent: 2,
    replayFailed: 0,
    commandPublished: 10,
    duplicateCommandPublishes: 0,
    timeoutAudit: 1,
    consistency: { samples: 900, buckets: 250, duplicateBusinessRows: 0 },
    pauseVerified: true,
    manifestRetry: true,
    gapObserved: true,
    replayIdempotent: true,
    lateAckPreserved: true,
    gapRows: 18,
    backlogAtResume: 100,
    maxBacklog: 120,
    replaySkipped: 18,
    schedulerElapsedMs: 35000,
    telemetryLatency: { samples: 120, p95Ms: 100, maxMs: 100, valuesMs: Array(120).fill(100) },
    commandLatency: { samples: 10, p95Ms: 20, maxMs: 20, valuesMs: Array(10).fill(20) },
  };
}
test('quick has exact cadence, 24 historical hours, 30x burst, 5% duplicates and 2% delayed delivery', () => {
  const p = buildLoadPlan();
  assert.equal(p.uniqueTelemetry, 900);
  assert.equal(p.duplicates, 45);
  assert.equal(p.reordered, 18);
  for (let d = 0; d < 10; d++) {
    const normal = p.messages.filter((m) => m.device === d && m.stage === 'normal' && !m.duplicate);
    assert.deepEqual(
      normal
        .filter((m) => m.type === 'telemetry')
        .map((m) => m.occurred)
        .sort((a, b) => a - b),
      Array.from({ length: 12 }, (_, i) => i * 10),
    );
    assert.deepEqual(
      normal.filter((m) => m.type === 'heartbeat').map((m) => m.occurred),
      [0, 60],
    );
    assert.equal(p.messages.filter((m) => m.device === d && m.stage === 'burst' && !m.duplicate).length, 30);
  }
  assert.equal(
    new Set(p.messages.filter((m) => m.stage === 'history').map((m) => Math.floor((m.occurred + 86400) / 3600))).size,
    24,
  );
  const originals = p.messages.filter((m) => !m.duplicate);
  for (const m of p.messages.filter((m) => m.reordered)) {
    const next = originals.find((n) => n.device === m.device && n.type === m.type && n.seq === m.seq + 1);
    assert.ok(m.due > next.due);
  }
  for (const m of p.messages.filter((m) => m.duplicate)) {
    const original = originals.find((n) => n.id === m.id);
    assert.equal(original.seq, m.seq);
    assert.equal(original.occurred, m.occurred);
  }
});
test('full plan contains 86400 historical Telemetry samples for 10 devices at 10-second cadence', () => {
  const p = buildLoadPlan('full');
  assert.equal(p.historyExecutedSeconds, 86400);
  assert.equal(p.messages.filter((m) => m.stage === 'history' && !m.duplicate).length, 86400);
  assert.equal(p.uniqueTelemetry, 87300);
});
test('unknown profile fails closed', () => assert.throws(() => buildLoadPlan('unknown')));
test('P95 uses nearest rank and does not mutate input', () => {
  const values = Array.from({ length: 100 }, (_, i) => 100 - i);
  assert.deepEqual(latencySummary(values), { samples: 100, p95Ms: 95, maxMs: 100 });
  assert.equal(values[0], 100);
});
for (const samples of [[], [NaN], [Infinity], [-1]])
  test(`invalid latency ${String(samples)} rejected`, () => assert.throws(() => latencySummary(samples)));
test('independent checker verifies count average min max and UTC buckets', () => {
  const e = expectedAggregates([
    { type: 'telemetry', deviceId: 'a', ts: '2026-10-01T00:00:00Z', value: 2 },
    { type: 'telemetry', deviceId: 'a', ts: '2026-10-01T00:59:59Z', value: 8 },
  ]);
  assert.equal(e[0].avg, 5);
  assert.equal(checkConsistency(e, e).samples, 2);
  for (const patch of [{ sampleCount: 3 }, { avg: 6 }, { min: 0 }, { max: 99 }])
    assert.throws(() => checkConsistency(e, [{ ...e[0], ...patch }]));
  assert.throws(() => checkConsistency(e, []));
  assert.throws(() => checkConsistency(e, [e[0], e[0]]));
});
test('complete reliability proof passes', () => assert.equal(validateReliability([proof()]).status, 'PASS'));
for (const [name, mutate] of [
  ['missing trace', () => []],
  ['duplicate trace', (r) => [r, r]],
  ['failed cleanup', (r) => [{ ...r, cleanup: 'FAIL' }]],
  ['wrong profile', (r) => [{ ...r, profile: 'full' }]],
  ['wrong cadence', (r) => [{ ...r, telemetrySeconds: 20 }]],
  ['untracked loss', (r) => [{ ...r, untrackedMissing: 1 }]],
  ['duplicate business row', (r) => [{ ...r, consistency: { ...r.consistency, duplicateBusinessRows: 1 } }]],
  ['missing archive', (r) => [{ ...r, archived: 899 }]],
  ['missing reorder', (r) => [{ ...r, reorderedInjected: 0 }]],
  ['missing retry', (r) => [{ ...r, partialRetries: 0 }]],
  ['unresolved gap', (r) => [{ ...r, unresolvedGaps: 1 }]],
  ['worker not paused', (r) => [{ ...r, pauseVerified: false }]],
  ['no backlog', (r) => [{ ...r, backlogAtResume: 0 }]],
  ['unscoped replay', (r) => [{ ...r, replaySent: 3 }]],
  ['duplicate MQTT publish', (r) => [{ ...r, duplicateCommandPublishes: 1 }]],
  ['late ACK changed terminal state', (r) => [{ ...r, lateAckPreserved: false }]],
  ['telemetry P95 failed', (r) => [{ ...r, telemetryLatency: { ...r.telemetryLatency, p95Ms: 5001, maxMs: 5001 } }]],
  ['command P95 failed', (r) => [{ ...r, commandLatency: { ...r.commandLatency, p95Ms: 3001, maxMs: 3001 } }]],
  ['NaN P95', (r) => [{ ...r, telemetryLatency: { ...r.telemetryLatency, p95Ms: NaN } }]],
  ['missing latency samples', (r) => [{ ...r, telemetryLatency: { ...r.telemetryLatency, samples: 1 } }]],
])
  test(`Gate rejects ${name}`, () => assert.throws(() => validateReliability(mutate(proof()))));
