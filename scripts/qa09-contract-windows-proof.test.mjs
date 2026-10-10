import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowMarks, summarizeContractWindows } from './qa09-contract-windows-proof.mjs';
import { runContractWindows } from './run-qa09-contract-windows-offline.mjs';
function fixture() {
  const caseName = 'on',
    samples = [];
  for (let i = 0; i < 3; i++) {
    const id = `windows-${caseName}-${i}`,
      ids = { gatewayRequestId: id, lambdaRequestId: id, operationId: 'updateContract' };
    const defs = [
      ['contract-load', 0, 80],
      ['contract-load-delegate', 0, 10, 'MODEL_EXTENSION_ENTERED'],
      ['contract-load-orm-prepare', 10, 40, 'DRIVER_DISPATCH'],
      ['contract-load-orm-submit', 10, 15, 'CALL_RETURNED'],
      ['contract-load-orm-await', 15, 40, 'DRIVER_DISPATCH'],
      ['contract-load-await-queue', 15, 20, 'MICROTASK_CHECKPOINT'],
      ['contract-load-await-after-queue', 20, 40, 'DRIVER_DISPATCH'],
      ['contract-load-driver-query', 40, 65, 'OPERATION_SETTLED'],
      ['contract-load-driver-before-pg', 40, 45, 'PG_DISPATCH'],
      ['contract-load-driver-pg', 45, 55, 'PG_SETTLED'],
      ['contract-load-driver-after-pg', 55, 65, 'OPERATION_SETTLED'],
      ['contract-load-result', 65, 80, 'OPERATION_SETTLED'],
    ];
    const observations = defs.map(([phase, a, b, completionBoundary]) => ({
      ...ids,
      event: 'data-path.phase.completed',
      phase,
      startedAt: new Date(a).toISOString(),
      completedAt: new Date(b).toISOString(),
      durationMs: b - a,
      completionBoundary,
      outcome: 'PASS',
      errorCode: 'NONE',
      processCpuScope: 'PROCESS_ALL_THREADS',
      processCpuUserUs: 10,
      processCpuSystemUs: 0,
      includesConnectionWait: ['contract-load', 'contract-load-driver-query', 'contract-load-driver-pg'].includes(
        phase,
      ),
    }));
    observations.push({
      ...ids,
      event: 'data-path.contract-load.ownership',
      modelEntries: 1,
      driverDispatches: 1,
      transactional: true,
      detailEnabled: true,
      pgQueries: 1,
      pgSettlements: 1,
    });
    const times = [0, 12, 22, 24, 25, 41, 46, 47, 48, 54, 56, 57, 58, 64, 66, 68, 70, 79];
    const marks = windowMarks.map((name, j) => ({
      name,
      requestId: id,
      us: times[j] * 1000,
      wallMs: times[j],
      cpuUserUs: j,
      cpuSystemUs: 0,
      scope: 'PROCESS_ALL_THREADS',
    }));
    samples.push({
      index: i,
      firstForClient: i === 0,
      failed: false,
      expectedFailureMatched: false,
      windowsMs: { load: 80, update: 4, readback: 3, audit: 2 },
      observations,
      marks,
    });
  }
  return {
    kind: 'qa09-offline-contract-windows/v1',
    gate: 'PASS',
    case: caseName,
    enabled: true,
    control: {},
    poolMax: 1,
    fixedMicrotaskYields: 2,
    auditReturnProjection: 'ID_ONLY_OFFLINE',
    source: 'REAL_PRISMA_CONTROLLED_PG_NO_NETWORK',
    targetEquivalent: false,
    compilerOnlyAttribution: false,
    serverExecutionIsolated: false,
    p95Accepted: false,
    fullQa09Accepted: false,
    counts: {
      account: 1,
      checkout: 4,
      release: 4,
      dispose: 1,
      begin: 3,
      commit: 3,
      rollback: 0,
      load: 3,
      update: 3,
      readback: 3,
      audit: 3,
      networkAttempts: 0,
      pools: 1,
    },
    samples,
  };
}
test('complete public-port receipt retains strict parent proof and microsecond partitions', () => {
  const r = summarizeContractWindows(fixture());
  assert.equal(r.length, 3);
  assert.deepEqual(
    { totalUs: r[0].partitions.adapter.totalUs, segmentsUs: r[0].partitions.adapter.segmentsUs },
    { totalUs: 23000, segmentsUs: [7000, 10000, 6000] },
  );
  assert.deepEqual(
    { totalUs: r[0].partitions.result.totalUs, segmentsUs: r[0].partitions.result.segmentsUs },
    { totalUs: 15000, segmentsUs: [2000, 2000, 2000, 9000] },
  );
});
for (const [name, mutate] of [
  ['old source', (r) => delete r.kind],
  ['claims', (r) => (r.p95Accepted = true)],
  ['compiler', (r) => (r.compilerOnlyAttribution = true)],
  ['pool', (r) => (r.poolMax = 2)],
  ['scheduling', (r) => (r.fixedMicrotaskYields = 0)],
  ['control', (r) => (r.control = { pgWait: 30 })],
  ['missing', (r) => r.samples[0].marks.splice(5, 1)],
  ['duplicate', (r) => r.samples[0].marks.push(r.samples[0].marks[0])],
  ['foreign mark', (r) => (r.samples[0].marks[0].requestId = 'other')],
  ['foreign phase', (r) => (r.samples[0].observations[0].lambdaRequestId = 'other')],
  ['reverse', (r) => (r.samples[0].marks[7].us = 0)],
  ['fraction', (r) => (r.samples[0].marks[7].us = 1.5)],
  ['negative cpu', (r) => (r.samples[0].marks[7].cpuUserUs = -1)],
  ['missing wall', (r) => delete r.samples[0].marks[7].wallMs],
  ['wall outside', (r) => (r.samples[0].marks[17].wallMs = 99999)],
  ['incomplete pg', (r) => (r.samples[0].observations.at(-1).pgSettlements = 0)],
  ['sequence', (r) => (r.samples[1].firstForClient = true)],
  ['leak', (r) => (r.counts.release = 3)],
  ['extra pool', (r) => (r.counts.pools = 2)],
  ['retry', (r) => (r.counts.load = 4)],
  ['network', (r) => (r.counts.networkAttempts = 1)],
  ['missing downstream', (r) => delete r.samples[0].windowsMs.audit],
  ['cpu scope', (r) => (r.samples[0].marks[0].scope = 'THREAD_ONLY')],
  ['wrong phase boundary', (r) => (r.samples[0].observations[7].completionBoundary = 'PG_SETTLED')],
])
  test('strict offline receipt rejects ' + name, () => {
    const r = fixture();
    mutate(r);
    assert.throws(() => summarizeContractWindows(r));
  });
test('CPU partition uses counter differences and never sums nested windows', () => {
  const p = summarizeContractWindows(fixture())[0].partitions;
  assert.equal(p.adapter.cpuUserUs, 8);
  assert.deepEqual(p.adapter.segmentsCpuUserUs, [3, 4, 1]);
  assert.equal(p.result.cpuUserUs, 4);
});
test('injection must land in its named window, not only increase total load', () => {
  const r = fixture();
  r.case = 'await-cpu';
  r.control = { awaitCpu: 20 };
  r.samples.forEach((s, i) => {
    s.marks.forEach((m) => (m.requestId = `windows-await-cpu-${i}`));
    s.observations.forEach((p) => {
      p.gatewayRequestId = p.lambdaRequestId = `windows-await-cpu-${i}`;
    });
  });
  assert.throws(() => summarizeContractWindows(r), /INJECTION_LOCATION/);
});
test('runner refuses all existing directories before starting any process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa09-windows-'));
  try {
    assert.throws(() => runContractWindows(dir), /FRESH_DIRECTORY/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
