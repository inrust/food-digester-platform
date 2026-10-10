import { validateContractAwaitCheckpoint } from './qa09-contract-load-detail-proof.mjs';
export const windowCases = Object.freeze({
  off: {},
  on: {},
  'await-cpu': { awaitCpu: 20 },
  'await-wait': { awaitWait: 30 },
  'pg-submit': { pgSubmit: 20 },
  'pg-wait': { pgWait: 30 },
  'decode-cpu': { decodeCpu: 20 },
  'adapter-cpu': { adapterCpu: 20 },
  'result-cpu': { resultCpu: 20 },
  'caller-cpu': { callerCpu: 20 },
  'await-reject': { failure: 'await' },
  'pg-reject': { failure: 'pg' },
  'decode-reject': { failure: 'decode' },
  'result-reject': { failure: 'result' },
  'update-reject': { failure: 'update' },
  'audit-reject': { failure: 'audit' },
});
export const windowMarks = [
  'load-enter',
  'extension-enter',
  'await-enter',
  'await-exit',
  'extension-query-return',
  'adapter-enter',
  'pg-enter',
  'pg-return',
  'adapter-call-return',
  'pg-ready',
  'decode-enter',
  'decode-exit',
  'adapter-resume',
  'adapter-return',
  'extension-resume',
  'extension-return',
  'caller-resume',
  'load-return',
];
const demand = (v, code) => {
  if (!v) throw Error(code);
};
const partitions = {
  afterQueue: ['await-enter', 'await-exit', 'extension-query-return', 'adapter-enter'],
  adapter: ['adapter-enter', 'adapter-call-return', 'adapter-resume', 'adapter-return'],
  pg: ['pg-enter', 'pg-return', 'pg-ready'],
  result: ['adapter-return', 'extension-resume', 'extension-return', 'caller-resume', 'load-return'],
};
/** Test-only monotonic marks, not a target receipt loader. Never reconstruct historical phases. */
export function summarizeContractWindows(r) {
  demand(
    r?.kind === 'qa09-offline-contract-windows/v1' && r.gate === 'PASS' && Object.hasOwn(windowCases, r.case),
    'WINDOW_SOURCE',
  );
  const enabled = r.case !== 'off',
    control = windowCases[r.case],
    failure = control.failure,
    n = failure ? 1 : 3;
  demand(r.enabled === enabled && JSON.stringify(r.control) === JSON.stringify(control), 'WINDOW_CONTROL');
  demand(
    r.poolMax === 1 &&
      r.fixedMicrotaskYields === 2 &&
      r.auditReturnProjection === 'ID_ONLY_OFFLINE' &&
      r.source === 'REAL_PRISMA_CONTROLLED_PG_NO_NETWORK',
    'WINDOW_SCOPE',
  );
  demand(
    ['targetEquivalent', 'compilerOnlyAttribution', 'serverExecutionIsolated', 'p95Accepted', 'fullQa09Accepted'].every(
      (k) => r[k] === false,
    ),
    'WINDOW_CLAIMS',
  );
  const c = r.counts;
  demand(
    r.samples.length === n &&
      c.networkAttempts === 0 &&
      c.pools === 1 &&
      c.account === 1 &&
      c.checkout === n + 1 &&
      c.release === c.checkout &&
      c.dispose === 1 &&
      c.begin === n &&
      c.commit === (failure ? 0 : n) &&
      c.rollback === (failure ? 1 : 0) &&
      c.load === (failure === 'await' ? 0 : n) &&
      c.update === (failure && !['update', 'audit'].includes(failure) ? 0 : n) &&
      c.readback === (failure && failure !== 'audit' ? 0 : n) &&
      c.audit === (failure && failure !== 'audit' ? 0 : n),
    'WINDOW_OWNERSHIP',
  );
  return r.samples.map((s, i) => {
    demand(
      s.index === i &&
        s.firstForClient === (i === 0) &&
        s.failed === Boolean(failure) &&
        (!failure || s.expectedFailureMatched === true),
      'WINDOW_SEQUENCE_FAILURE',
    );
    demand(
      Object.keys(s.windowsMs).join(',') ===
        (failure
          ? failure === 'await' || ['pg', 'decode', 'result'].includes(failure)
            ? 'load'
            : failure === 'update'
              ? 'load,update'
              : 'load,update,readback,audit'
          : 'load,update,readback,audit') && Object.values(s.windowsMs).every((v) => Number.isFinite(v) && v >= 0),
      'WINDOW_BUSINESS_WINDOWS',
    );
    const phases = s.observations.filter((p) => p.event === 'data-path.phase.completed'),
      own = s.observations.filter((p) => p.event === 'data-path.contract-load.ownership');
    demand(
      own.length === 1 &&
        own[0].modelEntries === 1 &&
        own[0].transactional === (failure !== 'await') &&
        own[0].driverDispatches === (failure === 'await' ? 0 : 1),
      'WINDOW_LOAD_OWNER',
    );
    demand(
      s.observations.every(
        (p) =>
          p.gatewayRequestId === `windows-${r.case}-${i}` &&
          p.lambdaRequestId === `windows-${r.case}-${i}` &&
          p.operationId === 'updateContract',
      ),
      'WINDOW_TRACE_OWNER',
    );
    demand(
      enabled
        ? own[0].detailEnabled === true &&
            own[0].pgQueries === (failure === 'await' ? 0 : 1) &&
            own[0].pgSettlements === (failure === 'await' ? 0 : 1)
        : own[0].detailEnabled === undefined,
      'WINDOW_PG_OWNER',
    );
    if (!enabled) {
      demand(
        s.marks.length === 0 && !phases.some((p) => p.phase === 'contract-load-await-after-queue'),
        'WINDOW_DEFAULT_OFF',
      );
      return { index: i, gate: 'PASS_DEFAULT_OFF', windowsMs: s.windowsMs };
    }
    const names = s.marks.map((m) => m.name);
    demand(new Set(names).size === names.length && names.every((k) => windowMarks.includes(k)), 'WINDOW_MARK_UNIQUE');
    demand(
      s.marks.every(
        (m, j) =>
          m.requestId === `windows-${r.case}-${i}` &&
          m.scope === 'PROCESS_ALL_THREADS' &&
          ['us', 'cpuUserUs', 'cpuSystemUs', 'wallMs'].every((k) => Number.isSafeInteger(m[k]) && m[k] >= 0) &&
          (!j || ['us', 'cpuUserUs', 'cpuSystemUs'].every((k) => m[k] >= s.marks[j - 1][k])),
      ),
      'WINDOW_MARK_ORDER_CPU',
    );
    // A failure cannot be promoted to a complete partition; retain its partial marks and rollback.
    if (['await', 'pg', 'decode', 'result'].includes(failure)) {
      const last = { await: 'await-enter', pg: 'pg-ready', decode: 'decode-enter', result: 'extension-resume' }[
        failure
      ];
      demand(
        names.join(',') === windowMarks.slice(0, windowMarks.indexOf(last) + 1).join(',') &&
          phases.some((p) => p.outcome === 'FAIL'),
        'WINDOW_FAILURE_NOT_COMPLETE',
      );
      return { index: i, gate: 'EXPECTED_FAILURE', windowsMs: s.windowsMs, partitions: null };
    }
    demand(names.join(',') === windowMarks.join(','), 'WINDOW_MARK_REQUIRED');
    const checkpoint = validateContractAwaitCheckpoint(phases, own, true);
    const at = Object.fromEntries(s.marks.map((m) => [m.name, m.us]));
    const byName = Object.fromEntries(s.marks.map((m) => [m.name, m]));
    const windows = Object.fromEntries(
      Object.entries(partitions).map(([key, keys]) => {
        const delta = (field) => byName[keys.at(-1)][field] - byName[keys[0]][field];
        const segments = (field) => keys.slice(1).map((k, j) => byName[k][field] - byName[keys[j]][field]);
        return [
          key,
          {
            totalUs: delta('us'),
            segmentsUs: segments('us'),
            cpuUserUs: delta('cpuUserUs'),
            cpuSystemUs: delta('cpuSystemUs'),
            segmentsCpuUserUs: segments('cpuUserUs'),
            segmentsCpuSystemUs: segments('cpuSystemUs'),
          },
        ];
      }),
    );
    demand(
      Object.values(windows).every((w) => w.totalUs === w.segmentsUs.reduce((a, b) => a + b, 0)),
      'WINDOW_PARTITION_COVERAGE',
    );
    const span = (a, b) => at[b] - at[a];
    const located = {
      awaitCpu: span('await-enter', 'await-exit'),
      awaitWait: span('await-enter', 'await-exit'),
      pgSubmit: span('pg-enter', 'pg-return'),
      pgWait: span('pg-return', 'pg-ready'),
      decodeCpu: span('decode-enter', 'decode-exit'),
      adapterCpu: span('adapter-resume', 'adapter-return'),
      resultCpu: span('extension-resume', 'extension-return'),
      callerCpu: span('caller-resume', 'load-return'),
    };
    for (const [k, v] of Object.entries(control))
      if (typeof v === 'number') demand(located[k] >= (v - 2) * 1000, 'WINDOW_INJECTION_LOCATION');
    const phase = (name) => phases.find((p) => p.phase === name);
    // Separate clocks are used, so this checks containment with the existing 5ms rounding bound only.
    demand(
      windows.afterQueue.totalUs / 1000 <= phase('contract-load-await-after-queue').durationMs + 5 &&
        windows.result.totalUs / 1000 <= phase('contract-load-result').durationMs + 5 &&
        windows.adapter.totalUs / 1000 <= phase('contract-load-driver-query').durationMs + 5,
      'WINDOW_PARENT_CONTAINMENT',
    );
    const wall = Object.fromEntries(s.marks.map((m) => [m.name, m.wallMs]));
    for (const [parent, a, b] of [
      ['contract-load-await-after-queue', 'await-enter', 'await-exit'],
      ['contract-load-driver-query', 'adapter-enter', 'adapter-return'],
      ['contract-load-result', 'extension-resume', 'load-return'],
    ]) {
      demand(
        wall[a] >= Date.parse(phase(parent).startedAt) - 5 && wall[b] <= Date.parse(phase(parent).completedAt) + 5,
        'WINDOW_WALL_CONTAINMENT',
      );
    }
    return {
      index: i,
      gate: failure ? 'EXPECTED_FAILURE' : 'PASS',
      windowsMs: s.windowsMs,
      partitions: windows,
      checkpoint,
    };
  });
}
