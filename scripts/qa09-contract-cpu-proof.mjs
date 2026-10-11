import { summarizePublicCase } from './run-qa09-contract-public-runtime.mjs';
const base = {
  profile: true,
  waitMs: 0,
  checkpointCpuMs: 0,
  adapterCpuMs: 0,
  pgCpuMs: 0,
  fieldsCpuMs: 0,
  resumeCpuMs: 0,
};
export const cpuCases = Object.freeze({
  'default-off': { ...base, profile: false },
  'public-on': { ...base, profile: false },
  'profile-on': { ...base },
  'account-orm': { ...base },
  'checkpoint-cpu': { ...base, checkpointCpuMs: 20 },
  'adapter-submit-cpu': { ...base, adapterCpuMs: 20 },
  'pg-submit-cpu': { ...base, pgCpuMs: 20 },
  'fields-cpu': { ...base, fieldsCpuMs: 20 },
  'resume-log-cpu': { ...base, resumeCpuMs: 20 },
  'pg-wait': { ...base, waitMs: 30 },
  'pg-reject': { ...base },
  'validation-reject': { ...base },
  'update-reject': { ...base },
  'audit-reject': { ...base },
});
const demand = (v, code) => {
  if (!v) throw Error(code);
};
const finite = (v) => Number.isFinite(v) && v >= 0;
const bracket = (v) => v && finite(v.lower) && finite(v.upper) && v.upper >= v.lower;
function bucket(frame) {
  const u = frame.url,
    f = frame.functionName;
  if (u.includes('contract-cpu-probe')) return 'CONTROLLED_PROBE';
  if (u.includes('packages/observability/') || u.includes('contract-load-observation')) return 'OBSERVATION';
  if (u.includes('@prisma/adapter-pg') || u.includes('observed-pg')) return 'PUBLIC_ADAPTER';
  if (/prisma.*(runtime|client|query_compiler)|\.prisma\/client/.test(u)) return 'PRISMA_RUNTIME_LOCATION';
  if (u.startsWith('node:') || u.startsWith('internal/')) return 'NODE_INTERNAL';
  if (u.startsWith('apps/') || u.startsWith('packages/')) return 'REPOSITORY';
  if (['(idle)', '(garbage collector)', '(program)', '(root)'].includes(f) || !u) return 'NATIVE_IDLE_OR_UNRESOLVED';
  return 'OTHER_UNRESOLVED';
}
export function validateCpuProfile(p) {
  demand(
    p?.scope === 'V8_MAIN_ISOLATE_LOCATION_SAMPLES_NOT_CPU_TIME' &&
      p.intervalUs === 1000 &&
      p.clockToleranceUs === 100 &&
      /^[a-f0-9]{64}$/.test(p.originalSha256),
    'CPU_PROFILE_SCOPE',
  );
  demand(
    bracket(p.startBracket) &&
      bracket(p.stopBracket) &&
      finite(p.startTime) &&
      finite(p.endTime) &&
      p.startTime >= p.startBracket.lower - 100 &&
      p.startTime <= p.startBracket.upper + 100 &&
      p.endTime >= p.stopBracket.lower - 100 &&
      p.endTime <= p.stopBracket.upper + 100 &&
      p.endTime >= p.startTime,
    'CPU_CLOCK_ALIGNMENT',
  );
  demand(
    Array.isArray(p.nodes) &&
      p.nodes.length > 0 &&
      p.nodes.length <= 20000 &&
      Array.isArray(p.samples) &&
      p.samples.length > 0 &&
      p.samples.length <= 45000 &&
      p.samples.length === p.timeDeltas?.length &&
      Buffer.byteLength(JSON.stringify(p)) <= 8 * 1024 * 1024,
    'CPU_PROFILE_BUDGET',
  );
  const nodes = new Map();
  for (const n of p.nodes) {
    demand(
      Number.isInteger(n.id) &&
        !nodes.has(n.id) &&
        typeof n.callFrame?.url === 'string' &&
        !n.callFrame.url.startsWith('/') &&
        !n.callFrame.url.includes('://') &&
        typeof n.callFrame.functionName === 'string' &&
        n.callFrame.functionName.length <= 160,
      'CPU_PROFILE_NODE',
    );
    nodes.set(n.id, n.callFrame);
  }
  let at = p.startTime;
  const points = p.samples.map((id, i) => {
    demand(nodes.has(id) && finite(p.timeDeltas[i]), 'CPU_PROFILE_SAMPLE');
    at += p.timeDeltas[i];
    demand(at <= p.endTime + 1, 'CPU_PROFILE_SAMPLE_CLOCK');
    return { at, bucket: bucket(nodes.get(id)) };
  });
  return points;
}
export function attributeCpuSamples(points, spans) {
  const unique = new Set();
  return spans.map((s) => {
    demand(
      typeof s.phase === 'string' &&
        !unique.has(s.phase) &&
        bracket(s.start) &&
        bracket(s.end) &&
        s.end.lower >= s.start.upper,
      'CPU_SPAN_BOUNDARY',
    );
    unique.add(s.phase);
    const buckets = {},
      counts = { inside: 0, ambiguous: 0, outside: 0 };
    for (const p of points) {
      if (p.at - 100 >= s.start.upper && p.at + 100 <= s.end.lower) {
        counts.inside++;
        buckets[p.bucket] = (buckets[p.bucket] ?? 0) + 1;
      } else if (p.at + 100 >= s.start.lower && p.at - 100 <= s.end.upper) counts.ambiguous++;
      else counts.outside++;
    }
    demand(counts.inside + counts.ambiguous + counts.outside === points.length, 'CPU_SAMPLE_CONSERVATION');
    return { phase: s.phase, sharedEnd: s.sharedEnd, wallUs: s.end.lower - s.start.upper, ...counts, buckets };
  });
}
export function summarizeCpuCase(r) {
  demand(r.kind === 'qa09-offline-public-cpu/v1' && Object.hasOwn(cpuCases, r.case), 'CPU_SOURCE');
  const config = cpuCases[r.case];
  demand(
    JSON.stringify(r.config) === JSON.stringify(config) &&
      r.enabled === (r.case !== 'default-off') &&
      r.accountNative === (r.case !== 'account-orm'),
    'CPU_CONFIG',
  );
  demand(
    r.forcedYields === 0 &&
      r.targetEquivalent === false &&
      r.compilerOnlyAttribution === false &&
      r.modelCostShift === 'OBSERVATIONS_ONLY' &&
      r.p95Accepted === false &&
      r.fullQa09Accepted === false,
    'CPU_SCOPE',
  );
  for (const [i, s] of r.samples.entries()) {
    demand(
      Object.keys(s.windowsCpuUs).length === Object.keys(s.windowsMs).length &&
        Object.values(s.windowsCpuUs).every(finite),
      'CPU_OPERATION_COVERAGE',
    );
    const phases = s.observations.filter((p) => p.event === 'data-path.phase.completed');
    demand(s.spans.length > 0, 'CPU_SPAN_COVERAGE');
    for (const span of s.spans) {
      const matched = phases.filter((p) => p.phase === span.phase);
      demand(matched.length === 1 && bracket(span.start) && bracket(span.end), 'CPU_SPAN_LOG_OWNER');
      if (span.sharedEnd)
        demand(
          Math.abs(matched[0].durationMs * 1000 - (span.end.lower - span.start.upper)) <=
            2000 + span.start.upper - span.start.lower + span.end.upper - span.end.lower,
          'CPU_SPAN_WALL_MATCH',
        );
      if (config.profile)
        demand(
          span.start.lower >= r.profile.startTime - 100 && span.end.upper <= r.profile.endTime + 100,
          'CPU_SPAN_PROFILE_COVERAGE',
        );
    }
    if (i > 0)
      demand(
        Math.min(...s.spans.map((p) => p.start.lower)) >= Math.max(...r.samples[i - 1].spans.map((p) => p.end.upper)),
        'CPU_SAMPLE_SEQUENCE',
      );
    for (const row of s.observations)
      demand(
        row.lambdaRequestId === `cpu-${r.case}-${i}` && row.gatewayRequestId === `cpu-${r.case}-${i}`,
        'CPU_REQUEST_OWNER',
      );
  }
  // Reuse the existing transaction/error/phase proof; conversion only renames the offline request IDs.
  const legacy = structuredClone(r);
  legacy.kind = 'qa09-runtime-public-seams/v1';
  legacy.case =
    r.case === 'default-off'
      ? 'off'
      : ['pg-wait', 'fields-cpu', 'pg-reject', 'validation-reject', 'update-reject', 'audit-reject'].includes(r.case)
        ? r.case
        : 'on';
  legacy.accountNative = true;
  for (const [i, s] of legacy.samples.entries())
    for (const row of s.observations) {
      row.lambdaRequestId = `public-${legacy.case}-${i}`;
      row.gatewayRequestId = `public-${legacy.case}-${i}`;
    }
  const proof = summarizePublicCase(legacy);
  demand(
    r.probe.measurements.length === 2 &&
      r.probe.measurements[0].name === 'prepare' &&
      r.probe.measurements[1].name === 'account' &&
      r.probe.measurements.every((m) => finite(m.start) && m.end >= m.start && finite(m.processCpuUs)),
    'CPU_ACCOUNT_COVERAGE',
  );
  demand(r.probe.adapterReturns === r.counts.load + r.counts.readback + r.counts.audit, 'CPU_ADAPTER_RETURNS');
  const points = config.profile ? validateCpuProfile(r.profile) : [];
  demand(config.profile || r.profile === null, 'CPU_PROFILE_OFF');
  const control = Object.entries(config).find(([k, v]) => k.endsWith('CpuMs') && v > 0);
  demand(r.probe.controls.length === (control ? r.samples.length : 0), 'CPU_CONTROL_COUNT');
  const locationPhase = {
    checkpoint: 'contract-load-await-after-queue',
    'adapter-submit': 'contract-load-driver-submit',
    'pg-submit': 'contract-load-pg-submit',
    fields: 'contract-load-driver-await',
    'resume-log': 'contract-load-result-after-model',
  };
  const expectedControl = {
    'checkpoint-cpu': 'checkpoint',
    'adapter-submit-cpu': 'adapter-submit',
    'pg-submit-cpu': 'pg-submit',
    'fields-cpu': 'fields',
    'resume-log-cpu': 'resume-log',
  }[r.case];
  demand(new Set(r.probe.controls.map((c) => c.index)).size === r.probe.controls.length, 'CPU_CONTROL_DUPLICATE');
  for (const c of r.probe.controls) {
    demand(c.location === expectedControl, 'CPU_CONTROL_TYPE');
    demand(
      Number.isInteger(c.index) &&
        r.samples[c.index] &&
        c.requestId === `cpu-${r.case}-${c.index}` &&
        c.end - c.start >= 19000 &&
        finite(c.processCpuUs),
      'CPU_CONTROL_OWNER',
    );
    const span = r.samples[c.index].spans.find((s) => s.phase === locationPhase[c.location]);
    demand(span?.sharedEnd && span.start.upper <= c.start && span.end.lower >= c.end, 'CPU_CONTROL_LOCATION');
  }
  return {
    case: r.case,
    gate: 'PASS',
    measurements: r.probe.measurements,
    controls: r.probe.controls,
    profileSamples: points.length,
    samples: r.samples.map((s, i) => ({
      ...proof[i],
      windowsCpuUs: s.windowsCpuUs,
      cpu: attributeCpuSamples(points, s.spans),
    })),
    attribution: 'LEAF_LOCATION_COUNTS_NOT_CPU_TIME_OR_COMPILER_CAUSALITY',
  };
}
