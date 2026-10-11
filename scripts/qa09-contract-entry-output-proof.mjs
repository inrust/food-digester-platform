import { summarizePublicCase } from './run-qa09-contract-public-runtime.mjs';
export const entryOutputCases = [
  'default-off',
  'reference-public',
  'entry-output',
  'slow-prefix-log',
  'slow-public-call',
  'slow-resume-log',
  'slow-terminal-log',
  'throw-prefix-log',
  'throw-resume-log',
  'reentrant-resume-log',
  'pg-reject',
  'validation-reject',
  'update-reject',
  'audit-reject',
];
export const entryOutputPhases = [
  'contract-load',
  'contract-load-delegate',
  'contract-load-orm-prepare',
  'contract-load-driver-query',
  'contract-load-result',
  'contract-load-orm-submit',
  'contract-load-orm-await',
  'contract-load-await-queue',
  'contract-load-await-after-queue',
  'contract-load-driver-before-pg',
  'contract-load-driver-pg',
  'contract-load-driver-after-pg',
  'contract-load-driver-submit',
  'contract-load-driver-await',
  'contract-load-pg-submit',
  'contract-load-pg-await',
  'contract-load-result-to-model',
  'contract-load-result-after-model',
];
const demand = (v, c) => {
  if (!v) throw Error(c);
};
const finite = (v) => Number.isFinite(v) && v >= 0;
function segment(name, lower, upper) {
  demand(finite(lower) && finite(upper) && upper >= lower, 'ENTRY_SEGMENT_ORDER');
  return { name, lower, upper, wallUs: upper - lower };
}
export function partitionEntryOutput(sample) {
  const snap = sample.entryOutput,
    active = snap.enabled;
  demand(
    Array.isArray(snap.intervals) &&
      snap.intervals.length <= 64 &&
      snap.diagnosticEmissions === 0 &&
      [snap.publicCalls, snap.overflow, snap.nestedOutputs, snap.foreignOutputs, snap.probeFailures].every(
        (v) => Number.isSafeInteger(v) && v >= 0,
      ),
    'ENTRY_OUTPUT_BUDGET',
  );
  const records = snap.intervals,
    ordinals = new Set();
  for (const r of records) {
    demand(
      ['PUBLIC_CALL', 'OUTPUT'].includes(r.kind) &&
        (r.kind !== 'OUTPUT' || entryOutputPhases.includes(r.phase)) &&
        Number.isSafeInteger(r.ordinal) &&
        r.ordinal >= 0 &&
        !ordinals.has(r.ordinal) &&
        finite(r.start) &&
        finite(r.end) &&
        r.end >= r.start &&
        finite(r.processCpuUs) &&
        typeof r.threw === 'boolean',
      'ENTRY_OUTPUT_INTERVAL',
    );
    ordinals.add(r.ordinal);
  }
  const calls = records.filter((r) => r.kind === 'PUBLIC_CALL'),
    outputs = records.filter((r) => r.kind === 'OUTPUT').toSorted((a, b) => a.start - b.start);
  demand(
    outputs.every((r, i) => i === 0 || r.start >= outputs[i - 1].end),
    'ENTRY_OUTPUT_DOUBLE_COUNT',
  );
  const expectedStatus = snap.overflow
    ? 'TRUNCATED'
    : snap.probeFailures
      ? 'PROBE_FAILED'
      : snap.foreignOutputs
        ? 'FOREIGN_SCOPE'
        : snap.nestedOutputs
          ? 'REENTRANT'
          : outputs.some((r) => r.threw)
            ? 'OUTPUT_FAILED'
            : 'COMPLETE';
  demand(snap.status === expectedStatus, 'ENTRY_OUTPUT_STATUS');
  if (!active) {
    demand(
      records.length === 0 &&
        snap.publicCalls === 0 &&
        snap.overflow === 0 &&
        snap.nestedOutputs === 0 &&
        snap.foreignOutputs === 0 &&
        snap.probeFailures === 0,
      'ENTRY_OUTPUT_OFF',
    );
    return { gate: 'OFF', records: 0, segments: [], outputRows: [], diagnosticEmissions: 0 };
  }
  if (snap.publicCalls === 1 && calls.length === 0 && ['PROBE_FAILED', 'TRUNCATED'].includes(snap.status)) {
    const result = {
      gate: 'EXPECTED_DEGRADED',
      status: snap.status,
      segments: [],
      outputRows: outputs.map((r) => ({ ...r, owner: 'UNRESOLVED' })),
      records: records.length,
      diagnosticEmissions: 0,
      cpuSubtractionAllowed: false,
      compilerOnlyAttribution: false,
    };
    result.proposedSummary = proposedEntryOutputSummary(snap, result);
    result.proposedSummaryBytes = Buffer.byteLength(JSON.stringify(result.proposedSummary));
    return result;
  }
  const spans = sample.spans,
    find = (phase) => {
      const hits = spans.filter((s) => s.phase === phase);
      demand(
        hits.length === 1 && hits[0].sharedEnd && finite(hits[0].start?.upper) && finite(hits[0].end?.lower),
        'ENTRY_SHARED_SPAN:' + phase,
      );
      return hits[0];
    };
  let segments = [];
  if (snap.publicCalls) {
    demand(snap.publicCalls === 1 && calls.length === 1, 'ENTRY_PUBLIC_OWNER');
    const driver = find('contract-load-driver-submit'),
      call = calls[0];
    segments = [
      segment('driver-prefix', driver.start.upper, call.start),
      segment('public-call', call.start, call.end),
      segment('driver-return-tail', call.end, driver.end.lower),
    ];
    demand(
      segments.reduce((n, s) => n + s.wallUs, 0) === driver.end.lower - driver.start.upper,
      'ENTRY_PARTITION_CONSERVATION',
    );
  } else demand(calls.length === 0, 'ENTRY_PUBLIC_MISSING');
  const resumed = spans.filter((s) => s.phase === 'contract-load-result-after-model');
  if (resumed.length) {
    const s = find('contract-load-result-after-model');
    segments.push(segment('after-model', s.start.upper, s.end.lower));
  }
  // Every original output is assigned once, or retained as ambiguous/outside. Never sum nested phases.
  const outputRows = outputs.map((r) => {
    const inside = segments.filter((s) => r.start >= s.lower && r.end <= s.upper);
    demand(inside.length <= 1, 'ENTRY_OUTPUT_MULTIPLE_OWNERS');
    const intersects = segments.some((s) => r.start < s.upper && r.end > s.lower);
    return {
      phase: r.phase,
      start: r.start,
      end: r.end,
      wallUs: r.end - r.start,
      processCpuUs: r.processCpuUs,
      threw: r.threw,
      owner: inside[0]?.name ?? (intersects ? 'AMBIGUOUS' : 'OUTSIDE'),
    };
  });
  for (const s of segments) {
    s.outputWallUs = outputRows.filter((r) => r.owner === s.name).reduce((n, r) => n + r.wallUs, 0);
    demand(s.outputWallUs <= s.wallUs, 'ENTRY_OUTPUT_OVERFLOW');
    s.unattributedWallUs = snap.status === 'COMPLETE' ? s.wallUs - s.outputWallUs : null;
  }
  const result = {
    gate: snap.status === 'COMPLETE' ? 'PASS' : 'EXPECTED_DEGRADED',
    status: snap.status,
    segments,
    outputRows,
    records: records.length,
    diagnosticEmissions: 0,
    cpuSubtractionAllowed: false,
    compilerOnlyAttribution: false,
  };
  result.proposedSummary = proposedEntryOutputSummary(snap, result);
  result.proposedSummaryBytes = Buffer.byteLength(JSON.stringify(result.proposedSummary));
  return result;
}
/** Full proposed event schema, built in memory only; never emits or mutates an original output. */
export function proposedEntryOutputSummary(snap, proof) {
  if (!snap.enabled) return null;
  demand(
    [snap.requestId, snap.lambdaRequestId].every((v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)),
    'ENTRY_SUMMARY_IDS',
  );
  const summary = {
    event: 'data-path.contract-load.observer-cost',
    schemaVersion: 1,
    proposedOnly: true,
    gatewayRequestId: snap.requestId,
    lambdaRequestId: snap.lambdaRequestId,
    status: snap.status,
    intervalRecords: proof.records,
    publicCalls: snap.publicCalls,
    overflow: snap.overflow,
    nestedOutputs: snap.nestedOutputs,
    foreignOutputs: snap.foreignOutputs,
    probeFailures: snap.probeFailures,
    segments: proof.segments.map((s) => ({
      name: s.name,
      wallUs: s.wallUs,
      outputWallUs: s.outputWallUs,
      unattributedWallUs: s.unattributedWallUs,
    })),
    outsideOutputs: proof.outputRows.filter((r) => r.owner === 'OUTSIDE').length,
    ambiguousOutputs: proof.outputRows.filter((r) => r.owner === 'AMBIGUOUS').length,
    unresolvedOutputs: proof.outputRows.filter((r) => r.owner === 'UNRESOLVED').length,
    cpuSubtractionAllowed: false,
    compilerOnlyAttribution: false,
  };
  demand(Buffer.byteLength(JSON.stringify(summary)) <= 4096, 'ENTRY_SUMMARY_BYTES');
  return summary;
}

export function validateEntryOutputReceipt(r) {
  demand(
    r.kind === 'qa09-offline-public-entry-output/v1' &&
      entryOutputCases.includes(r.case) &&
      r.profile === null &&
      r.accountNative === true &&
      r.enabled === (r.case !== 'default-off') &&
      r.forcedYields === 0 &&
      r.targetEquivalent === false &&
      r.compilerOnlyAttribution === false &&
      r.p95Accepted === false &&
      r.fullQa09Accepted === false,
    'ENTRY_RECEIPT_SCOPE',
  );
  const legacy = structuredClone(r);
  legacy.kind = 'qa09-runtime-public-seams/v1';
  legacy.case = r.case === 'default-off' ? 'off' : r.case.endsWith('reject') ? r.case : 'on';
  for (const [i, s] of legacy.samples.entries())
    for (const row of s.observations) {
      demand(
        row.gatewayRequestId === `entry-${r.case}-${i}` && row.lambdaRequestId === `entry-L-${r.case}-${i}`,
        'ENTRY_TRACE_OWNER',
      );
      row.gatewayRequestId = `public-${legacy.case}-${i}`;
      row.lambdaRequestId = `public-${legacy.case}-${i}`;
    }
  const old = summarizePublicCase(legacy);
  return r.samples.map((s, i) => {
    demand(
      s.entryOutput.requestId === `entry-${r.case}-${i}` &&
        s.entryOutput.lambdaRequestId === `entry-L-${r.case}-${i}` &&
        s.entryOutput.enabled === !['default-off', 'reference-public'].includes(r.case),
      'ENTRY_OUTPUT_REQUEST',
    );
    demand(
      s.entryOutput.publicCalls === (s.entryOutput.enabled && r.case !== 'validation-reject' ? 1 : 0),
      'ENTRY_QUERY_OWNER',
    );
    const proof = partitionEntryOutput(s),
      throwing = r.case.startsWith('throw-');
    demand(s.delivered === s.observations.length - (throwing ? 1 : 0), 'ENTRY_DELIVERY_OWNER');
    demand(
      s.entryOutput.probeFailures === 0 &&
        s.entryOutput.overflow === 0 &&
        s.entryOutput.foreignOutputs === 0 &&
        s.entryOutput.nestedOutputs === (r.case === 'reentrant-resume-log' ? 1 : 0),
      'ENTRY_EXPECTED_STATUS',
    );
    demand(
      proof.gate ===
        (s.entryOutput.enabled
          ? throwing || r.case === 'reentrant-resume-log'
            ? 'EXPECTED_DEGRADED'
            : 'PASS'
          : 'OFF'),
      'ENTRY_CASE_GATE',
    );
    const control = {
      'slow-prefix-log': ['contract-load-await-after-queue', 'driver-prefix'],
      'slow-resume-log': ['contract-load-result-to-model', 'after-model'],
      'slow-terminal-log': ['contract-load-result-after-model', 'OUTSIDE'],
    }[r.case];
    if (control) {
      const hit = proof.outputRows.filter((v) => v.phase === control[0]);
      demand(hit.length === 1 && hit[0].owner === control[1] && hit[0].wallUs >= 19000, 'ENTRY_CONTROL_LOCATION');
    }
    if (r.case === 'slow-public-call')
      demand(proof.segments.find((s) => s.name === 'public-call')?.wallUs >= 19000, 'ENTRY_PUBLIC_CONTROL');
    return { index: i, transactionGate: old[i].gate, operationWallMs: s.windowsMs, proof };
  });
}
