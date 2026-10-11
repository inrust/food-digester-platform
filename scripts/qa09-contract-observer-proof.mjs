import { entryOutputCases } from './qa09-contract-entry-output-proof.mjs';
const demand = (v, c) => {
  if (!v) throw Error(c);
};
const names = ['driver-prefix', 'public-call', 'driver-return-tail', 'after-model'];
const metric = (v) => Number.isSafeInteger(v) && v >= 0;
export const ownedBoundaryNames = [
  'checkpoint-phase-setup',
  'checkpoint-output-return',
  'after-checkpoint-to-dispatch',
  'repository-driver-setup',
  'observer-public-bridge',
  'public-callback-setup',
];
export function validateOwnedBoundaries(row) {
  const own = row.ownedBoundaries;
  demand(
    row.schemaVersion === 2 && own?.seam === 'SELF_OWNED_CALL_SITES' && own.includesObservationOverhead === true,
    'OWNED_SCHEMA_REQUIRED',
  );
  demand(
    Array.isArray(own.segments) &&
      JSON.stringify(own.segments.map((s) => s.name)) === JSON.stringify(ownedBoundaryNames) &&
      own.segments.every((s) => metric(s.wallUs)),
    'OWNED_SEGMENTS_REQUIRED',
  );
  demand(
    metric(own.afterQueueWallUs) &&
      own.segments.slice(0, 3).reduce((n, s) => n + s.wallUs, 0) === own.afterQueueWallUs &&
      own.segments.slice(3, 5).reduce((n, s) => n + s.wallUs, 0) === row.segments[0].wallUs &&
      own.segments[5].wallUs <= row.segments[1].wallUs,
    'OWNED_CONSERVATION',
  );
  return own;
}
export function validateOwnedPhaseWindow(row, phase) {
  const own = validateOwnedBoundaries(row);
  demand(
    phase?.phase === 'contract-load-await-after-queue' &&
      metric(phase.durationMs) &&
      Math.abs(own.afterQueueWallUs / 1000 - phase.durationMs) <= 1,
    'OWNED_PHASE_WINDOW',
  );
}
export function validateContractObserverCost(record, required = false, ownedBoundaries = false) {
  const rows = record.contractObserverCost ?? [];
  if (!required && rows.length === 0) return null;
  demand(record.exactLinked === true && rows.length === 1, 'OBSERVER_EXACT_UNIQUE');
  const row = rows[0],
    invocation = record.lambda?.[0]?.lambdaRequestId;
  demand(
    row.event === 'data-path.contract-load.observer-cost' &&
      [1, 2].includes(row.schemaVersion) &&
      row.status === 'COMPLETE',
    'OBSERVER_COMPLETE_REQUIRED',
  );
  demand(
    row.gatewayRequestId === record.requestId &&
      row.lambdaRequestId === invocation &&
      invocation === record.gateway?.[0]?.integrationRequestId &&
      row.operationId === 'updateContract',
    'OBSERVER_EXACT_IDS',
  );
  demand(
    Number.isSafeInteger(row.logTimestampMs) &&
      row.logTimestampMs >= record.startMs - 2000 &&
      row.logTimestampMs <= record.startMs + Math.max(record.latencyMs ?? 30000, 30000) + 2000,
    'OBSERVER_TIME',
  );
  demand(
    row.processCpuScope === 'PROCESS_ALL_THREADS' &&
      row.cpuSubtractionAllowed === false &&
      row.compilerOnlyAttribution === false,
    'OBSERVER_SCOPE',
  );
  demand(
    metric(row.intervalRecords) &&
      row.intervalRecords <= 64 &&
      row.publicCalls === 1 &&
      row.publicOutcome === 'RETURNED' &&
      ['overflow', 'nestedOutputs', 'foreignOutputs', 'probeFailures', 'ambiguousOutputs', 'unresolvedOutputs'].every(
        (k) => row[k] === 0,
      ) &&
      metric(row.outsideOutputs),
    'OBSERVER_BUDGET',
  );
  demand(
    Array.isArray(row.segments) && JSON.stringify(row.segments.map((s) => s.name)) === JSON.stringify(names),
    'OBSERVER_SEGMENTS',
  );
  for (const s of row.segments)
    demand(
      ['wallUs', 'outputWallUs', 'outputProcessCpuUs', 'unattributedWallUs'].every((k) => metric(s[k])) &&
        s.outputWallUs <= s.wallUs &&
        s.unattributedWallUs === s.wallUs - s.outputWallUs,
      'OBSERVER_CONSERVATION',
    );
  if (ownedBoundaries || row.schemaVersion === 2) validateOwnedBoundaries(row);
  demand(Buffer.byteLength(JSON.stringify(row)) <= 4096, 'OBSERVER_BYTES');
  return {
    gate: 'PASS',
    requestId: record.requestId,
    lambdaRequestId: invocation,
    segments: row.segments,
    ...(row.schemaVersion === 2 ? { ownedBoundaries: row.ownedBoundaries } : {}),
    compilerOnlyAttribution: false,
    p95Accepted: false,
  };
}
export function contractObserverInputs(sha) {
  demand(/^[a-f0-9]{40}$/.test(sha), 'OBSERVER_INPUT_SHA');
  const common = {
    expectedCommit: sha,
    rolloutPhase: 'immediate',
    engineCpuDiagnosis: true,
    authenticatedPreconnect: true,
    accountReadCandidate: true,
    contractLoadDetail: true,
    contractPublicBoundaries: true,
  };
  return {
    scope: 'OBSERVATION_ONLY_NO_TARGET_EXECUTION',
    r0: { ...common, contractObserverCost: false },
    r1: { ...common, contractObserverCost: true },
    restore: {
      ...common,
      authenticatedPreconnect: false,
      accountReadCandidate: false,
      contractLoadDetail: false,
      contractPublicBoundaries: false,
      contractObserverCost: false,
    },
    budget: {
      memoryMiB: 512,
      reservedConcurrency: 12,
      poolMax: 1,
      databaseRequired: 63,
      databaseAvailable: 70,
      businessConcurrency: 6,
      baselinePatchMax: 6,
      samplingPatchMax: 12,
    },
    sequence: ['R0', 'R0 cleanup and empty set', 'R1', 'R1 cleanup and empty set', 'off restore and 19 artifacts'],
    forcedYields: 0,
    extraQueries: 0,
    p95Accepted: false,
    fullQa09Accepted: false,
  };
}

/** Offline real-runtime receipt replay; never turns controlled pg/console into target acceptance. */
export function validateObserverRuntimeReceipt(r) {
  demand(
    entryOutputCases.includes(r.case) &&
      r.kind === 'qa09-production-observer-controlled-runtime/v1' &&
      r.gate === 'PASS' &&
      r.targetEquivalent === false &&
      r.fullQa09Accepted === false &&
      r.p95Accepted === false &&
      r.profile === null &&
      r.poolMax === 1 &&
      r.forcedYields === 0,
    'OBSERVER_RUNTIME_SCOPE',
  );
  const failed = r.case.endsWith('reject'),
    n = failed ? 1 : 3,
    c = r.counts;
  demand(
    r.samples.length === n &&
      c.begin === n &&
      c.checkout === n + 1 &&
      c.release === c.checkout &&
      c.commit === (failed ? 0 : n) &&
      c.rollback === (failed ? 1 : 0) &&
      c.dispose === 1 &&
      c.pools === 1 &&
      c.network === 0 &&
      c.account === 1 &&
      c.load === (r.case === 'validation-reject' ? 0 : n) &&
      c.update === (failed && !['update-reject', 'audit-reject'].includes(r.case) ? 0 : n) &&
      c.readback === (failed && r.case !== 'audit-reject' ? 0 : n) &&
      c.audit === (failed && r.case !== 'audit-reject' ? 0 : n),
    'OBSERVER_RUNTIME_OWNERSHIP',
  );
  const summaries = r.samples.map((s, i) => {
    demand(s.failed === failed && (!failed || s.expectedFailureMatched === true), 'OBSERVER_RUNTIME_BUSINESS');
    const rows = s.observations.filter((o) => o.event === 'data-path.contract-load.observer-cost'),
      enabled = !['default-off', 'reference-public'].includes(r.case);
    demand(rows.length === (enabled ? 1 : 0), 'OBSERVER_RUNTIME_UNIQUE');
    if (!enabled) return { index: i, status: 'OFF' };
    const row = rows[0],
      expected = r.case.startsWith('throw-')
        ? 'OUTPUT_FAILED'
        : r.case === 'reentrant-resume-log'
          ? 'REENTRANT'
          : r.case === 'validation-reject'
            ? 'OWNERSHIP_INVALID'
            : 'COMPLETE';
    demand(
      row.gatewayRequestId === `entry-${r.case}-${i}` &&
        row.lambdaRequestId === `entry-L-${r.case}-${i}` &&
        row.operationId === 'updateContract' &&
        row.status === expected,
      'OBSERVER_RUNTIME_STATUS_IDS',
    );
    demand(
      metric(row.intervalRecords) &&
        row.intervalRecords <= 64 &&
        Buffer.byteLength(JSON.stringify(row)) <= 4096 &&
        row.cpuSubtractionAllowed === false &&
        row.compilerOnlyAttribution === false &&
        row.segments.every((s) =>
          expected === 'COMPLETE' ? s.unattributedWallUs === s.wallUs - s.outputWallUs : s.unattributedWallUs === null,
        ),
      'OBSERVER_RUNTIME_BUDGET',
    );
    if (expected === 'COMPLETE' && row.schemaVersion === 2) validateOwnedBoundaries(row);
    if (expected === 'COMPLETE')
      demand(
        row.publicCalls === 1 &&
          row.publicOutcome === 'RETURNED' &&
          JSON.stringify(row.segments.map((s) => s.name)) === JSON.stringify(names) &&
          row.segments.every(
            (s) =>
              ['wallUs', 'outputWallUs', 'outputProcessCpuUs', 'unattributedWallUs'].every((k) => metric(s[k])) &&
              s.outputWallUs <= s.wallUs,
          ),
        'OBSERVER_RUNTIME_COMPLETE',
      );
    return {
      index: i,
      status: row.status,
      intervalRecords: row.intervalRecords,
      summaryBytes: Buffer.byteLength(JSON.stringify(row)),
      segments: row.segments,
      ...(row.schemaVersion === 2 ? { ownedBoundaries: row.ownedBoundaries } : {}),
    };
  });
  return {
    gate: 'LOCAL_RUNTIME_PASS',
    case: r.case,
    counts: c,
    summaries,
    p95Accepted: false,
    fullQa09Accepted: false,
  };
}
