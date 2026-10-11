import { validateCpuProfile, attributeCpuSamples } from './qa09-contract-cpu-proof.mjs';
import { validateContractAwaitCheckpoint } from './qa09-contract-load-detail-proof.mjs';
import { validateContractPublicBoundaries } from './qa09-contract-public-proof.mjs';
import { entryOutputPhases } from './qa09-contract-entry-output-proof.mjs';

export const dispatchCases = Object.freeze({
  'default-off': {},
  reference: {},
  'boundary-on': {},
  'profile-on': { profile: true },
  'checkpoint-cpu': { profile: true, control: 'checkpoint-phase-setup' },
  'checkpoint-output-cpu': { profile: true, control: 'checkpoint-output-return' },
  'pre-driver-cpu': { profile: true, control: 'engine-dispatch-gap' },
  'driver-setup-cpu': { profile: true, control: 'repository-driver-setup' },
  'prefix-output-cpu': { profile: true, control: 'repository-driver-setup' },
  'public-bridge-cpu': { profile: true, control: 'observer-public-bridge' },
  'pre-driver-reject': { failure: 'pre-driver' },
  'public-reject': { failure: 'public' },
  'pg-reject': { failure: 'pg' },
  'validation-reject': { failure: 'validation' },
  'update-reject': { failure: 'update' },
  'audit-reject': { failure: 'audit' },
});
export const dispatchMarks = Object.freeze([
  'checkpoint',
  'checkpoint-phase-ready',
  'checkpoint-return',
  'dispatch',
  'public-bridge-enter',
  'callback-enter',
  'adapter-port-enter',
]);
const names = [
  'checkpoint-phase-setup',
  'checkpoint-output-return',
  'engine-dispatch-gap',
  'repository-driver-setup',
  'observer-public-bridge',
  'adapter-entry-wrapper',
];
const demand = (v, code) => {
  if (!v) throw Error(code);
};
const safe = (v) => Number.isSafeInteger(v) && v >= 0;

/** Disjoint lower-bound intervals; boundary uncertainty is retained, never silently charged. */
export function partitionDispatch(sample, points = []) {
  const trace = sample.dispatch;
  demand(trace?.enabled === true && Array.isArray(trace.marks), 'DISPATCH_TRACE');
  const marks = trace.marks;
  demand(marks.length === 7 && marks.every((m, i) => m.name === dispatchMarks[i]), 'DISPATCH_MARKS');
  demand(
    marks.every(
      (m, i) =>
        m.requestId === trace.requestId &&
        ['lower', 'upper', 'cpuUserUs', 'cpuSystemUs'].every((k) => safe(m[k])) &&
        m.upper >= m.lower &&
        (!i ||
          (m.lower >= marks[i - 1].upper &&
            m.cpuUserUs >= marks[i - 1].cpuUserUs &&
            m.cpuSystemUs >= marks[i - 1].cpuSystemUs)),
    ),
    'DISPATCH_MARK_ORDER_OWNER',
  );
  const segments = names.map((name, i) => {
    const a = marks[i],
      b = marks[i + 1];
    return {
      name,
      lower: a.upper,
      upper: b.lower,
      wallLowerUs: b.lower - a.upper,
      processCpuUs: b.cpuUserUs + b.cpuSystemUs - a.cpuUserUs - a.cpuSystemUs,
      processCpuScope: 'PROCESS_ALL_THREADS_BETWEEN_TEST_PORT_READINGS',
    };
  });
  const intervals = sample.entryOutput.intervals;
  demand(
    Array.isArray(intervals) &&
      intervals.every(
        (r, i) =>
          ['OUTPUT', 'PUBLIC_CALL'].includes(r.kind) &&
          safe(r.ordinal) &&
          r.ordinal === i &&
          safe(r.start) &&
          safe(r.end) &&
          r.end >= r.start &&
          safe(r.processCpuUs) &&
          r.threw === false,
      ),
    'DISPATCH_INTERVAL',
  );
  demand(intervals.filter((r) => r.kind === 'PUBLIC_CALL').length === 1, 'DISPATCH_PUBLIC_ONCE');
  const outputs = intervals.filter((r) => r.kind === 'OUTPUT');
  demand(
    sample.entryOutput.status === 'COMPLETE' &&
      sample.entryOutput.publicCalls === 1 &&
      sample.entryOutput.requestId === trace.requestId &&
      sample.entryOutput.intervals.length <= 64 &&
      ['overflow', 'nestedOutputs', 'foreignOutputs', 'probeFailures'].every((k) => sample.entryOutput[k] === 0),
    'DISPATCH_OUTPUT_OWNER',
  );
  demand(
    outputs.every(
      (r, i) =>
        safe(r.ordinal) &&
        safe(r.start) &&
        safe(r.end) &&
        safe(r.processCpuUs) &&
        r.threw === false &&
        entryOutputPhases.includes(r.phase) &&
        r.end >= r.start &&
        (!i || (r.start >= outputs[i - 1].end && r.ordinal > outputs[i - 1].ordinal)),
    ),
    'DISPATCH_OUTPUT_ORDER',
  );
  const outputOwnership = outputs.map((r) => {
    const owners = segments.filter((s) => r.start >= s.lower && r.end <= s.upper);
    const overlap = segments.some((s) => r.start < s.upper && r.end > s.lower);
    return {
      ordinal: r.ordinal,
      owner: owners.length === 1 ? owners[0].name : owners.length > 1 || overlap ? 'AMBIGUOUS' : 'OUTSIDE',
      wallUs: r.end - r.start,
    };
  });
  const group = (start, end) => {
    const part = segments.slice(start, end),
      first = marks[start],
      last = marks[end];
    const boundaryUncertaintyUs = marks.slice(start, end + 1).reduce((s, m) => s + m.upper - m.lower, 0);
    const wallLowerUs = part.reduce((s, r) => s + r.wallLowerUs, 0);
    demand(wallLowerUs + boundaryUncertaintyUs === last.upper - first.lower, 'DISPATCH_CONSERVATION');
    return { wallLowerUs, boundaryUncertaintyUs, enclosingWallUs: last.upper - first.lower };
  };
  return {
    gate: 'OFFLINE_BOUNDARY_ONLY',
    segments,
    afterQueue: group(0, 3),
    driverPrefix: group(3, 6),
    outputOwnership,
    cpuSamples: attributeCpuSamples(
      points,
      segments.map((s) => ({
        phase: s.name,
        start: { lower: s.lower, upper: s.lower },
        end: { lower: s.upper, upper: s.upper },
        sharedEnd: true,
      })),
    ),
    cpuSubtractionAllowed: false,
    compilerOnlyAttribution: false,
  };
}

export function validateDispatchReceipt(r) {
  demand(
    r?.kind === 'qa09-offline-contract-dispatch/v1' && r.gate === 'PASS' && Object.hasOwn(dispatchCases, r.case),
    'DISPATCH_SOURCE',
  );
  const config = dispatchCases[r.case],
    failure = config.failure,
    n = failure ? 1 : 3;
  demand(
    JSON.stringify(r.dispatchConfig) === JSON.stringify(config) &&
      r.forcedYields === 0 &&
      r.extraQueries === 0 &&
      r.targetEquivalent === false &&
      r.compilerOnlyAttribution === false &&
      r.p95Accepted === false &&
      r.fullQa09Accepted === false &&
      r.poolMax === 1 &&
      r.source === 'REAL_PRISMA_CONTROLLED_PG_NO_NETWORK',
    'DISPATCH_SCOPE',
  );
  demand(r.enabled === (r.case !== 'default-off') && r.auditReturnProjection === 'ID_ONLY_OFFLINE', 'DISPATCH_CONFIG');
  const c = r.counts,
    beforeLoad = ['pre-driver', 'public', 'validation'].includes(failure);
  demand(
    r.samples.length === n &&
      c.pools === 1 &&
      c.network === 0 &&
      c.account === 1 &&
      c.checkout === n + 1 &&
      c.release === c.checkout &&
      c.dispose === 1 &&
      c.begin === n &&
      c.commit === (failure ? 0 : n) &&
      c.rollback === (failure ? 1 : 0) &&
      c.load === (beforeLoad ? 0 : n) &&
      c.update === (failure && !['update', 'audit'].includes(failure) ? 0 : n) &&
      c.readback === (failure && failure !== 'audit' ? 0 : n) &&
      c.audit === (failure && failure !== 'audit' ? 0 : n),
    'DISPATCH_TRANSACTION_OWNER',
  );
  const points = config.profile ? validateCpuProfile(r.profile) : [];
  demand(config.profile || r.profile === null, 'DISPATCH_PROFILE_OFF');
  return r.samples.map((s, i) => {
    const id = `dispatch-${r.case}-${i}`;
    demand(
      s.index === i &&
        s.firstForClient === (i === 0) &&
        s.failed === Boolean(failure) &&
        (!failure || s.expectedFailureMatched === true) &&
        s.dispatch.requestId === id &&
        s.observations.every(
          (row) => row.gatewayRequestId === id && row.lambdaRequestId === `dispatch-L-${r.case}-${i}`,
        ),
      'DISPATCH_REQUEST_OWNER',
    );
    const phases = s.observations.filter((row) => row.event === 'data-path.phase.completed');
    const ownership = s.observations.filter((row) => row.event === 'data-path.contract-load.ownership');
    demand(
      ownership.length === 1 &&
        ownership[0].modelEntries === 1 &&
        ownership[0].driverDispatches === (['pre-driver', 'validation'].includes(failure) ? 0 : 1),
      'DISPATCH_LOAD_OWNER',
    );
    if (['pre-driver', 'public', 'pg', 'validation'].includes(failure)) {
      demand(
        phases.some((p) => p.outcome === 'FAIL'),
        'DISPATCH_FAILURE_RETAINED',
      );
      return { gate: 'EXPECTED_FAILURE', completePartition: false };
    }
    if (r.case === 'default-off' || r.case === 'reference') {
      demand(
        s.dispatch.enabled === false && s.dispatch.marks.length === 0 && s.dispatch.controls.length === 0,
        'DISPATCH_DEFAULT_OFF',
      );
      return { gate: 'PASS_DISABLED' };
    }
    validateContractAwaitCheckpoint(phases, ownership, true);
    validateContractPublicBoundaries(phases, ownership, true);
    const proof = partitionDispatch(s, points);
    if (config.profile)
      demand(
        s.dispatch.marks.every((m) => m.lower >= r.profile.startTime - 100 && m.upper <= r.profile.endTime + 100),
        'DISPATCH_PROFILE_COVERAGE',
      );
    for (const [group, phase] of [
      ['afterQueue', 'contract-load-await-after-queue'],
      ['driverPrefix', 'contract-load-driver-before-pg'],
    ]) {
      const parent = phases.find((p) => p.phase === phase);
      demand(parent && proof[group].enclosingWallUs <= parent.durationMs * 1000 + 5000, 'DISPATCH_PARENT_BOUND');
    }
    demand(s.dispatch.controls.length === (config.control ? 1 : 0), 'DISPATCH_CONTROL_COUNT');
    for (const ctl of s.dispatch.controls) {
      const segment = proof.segments.find((s) => s.name === config.control);
      demand(
        ctl.location === config.control &&
          ctl.requestId === id &&
          ctl.start.lower >= segment.lower &&
          ctl.finish.upper <= segment.upper &&
          ctl.finish.lower - ctl.start.upper >= 19000,
        'DISPATCH_CONTROL_LOCATION',
      );
    }
    return { ...proof, expectedFailure: Boolean(failure) };
  });
}
