const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
const names = [
  'contract-load-delegate',
  'contract-load-orm-prepare',
  'contract-load-driver-query',
  'contract-load-result',
];
/** The public extension/adapter window includes planning and scheduling; never compiler-only attribution. */
export function validateContractLoadSplit(phases, ownership = [], required = false) {
  if (!names.some((n) => phases.some((p) => p.phase === n))) {
    demand(!required, 'CONTRACT_LOAD_SPLIT_REQUIRED');
    return null;
  }
  const one = (name) => {
    const rows = phases.filter((p) => p.phase === name);
    demand(rows.length === 1, 'CONTRACT_LOAD_UNIQUE');
    return rows[0];
  };
  const all = ['contract-load', ...names].map(one),
    [outer, ...parts] = all;
  const own = (p) =>
    ['lambdaRequestId', 'gatewayRequestId', 'operationId'].every(
      (k) => typeof p[k] === 'string' && p[k] !== 'unknown' && p[k] === outer[k],
    );
  demand(
    ownership.length === 1 &&
      own(ownership[0]) &&
      ownership[0].modelEntries === 1 &&
      ownership[0].driverDispatches === 1 &&
      ownership[0].transactional === true,
    'CONTRACT_LOAD_TRANSACTION_OWNERSHIP',
  );
  for (const p of all) {
    demand(own(p) && p.outcome === 'PASS' && p.errorCode === 'NONE', 'CONTRACT_LOAD_IDS_OUTCOME');
    demand(
      p.processCpuScope === 'PROCESS_ALL_THREADS' &&
        ['durationMs', 'processCpuUserUs', 'processCpuSystemUs'].every((k) => Number.isSafeInteger(p[k]) && p[k] >= 0),
      'CONTRACT_LOAD_CPU_DURATION',
    );
    demand(
      p.includesConnectionWait === (p === outer || p.phase === 'contract-load-driver-query'),
      'CONTRACT_LOAD_WAIT_SCOPE',
    );
  }
  const intervals = all.map((p) => [Date.parse(p.startedAt), Date.parse(p.completedAt)]),
    [os, oe] = intervals[0];
  demand(
    intervals.every(
      ([s, e], i) => Number.isFinite(s) && Number.isFinite(e) && s <= e && Math.abs(e - s - all[i].durationMs) <= 5,
    ),
    'CONTRACT_LOAD_TIME',
  );
  demand(
    parts.every(
      (p, i) =>
        p.completionBoundary ===
        ['MODEL_EXTENSION_ENTERED', 'DRIVER_DISPATCH', 'OPERATION_SETTLED', 'OPERATION_SETTLED'][i],
    ),
    'CONTRACT_LOAD_BOUNDARY',
  );
  let cursor = os;
  for (const [s, e] of intervals.slice(1)) {
    demand(s >= cursor && s - cursor <= 5 && e <= oe, 'CONTRACT_LOAD_ORDER');
    cursor = e;
  }
  demand(
    oe - cursor <= 5 && Math.abs(outer.durationMs - parts.reduce((sum, p) => sum + p.durationMs, 0)) <= 5,
    'CONTRACT_LOAD_COVERAGE',
  );
  return {
    gate: 'PASS',
    delegateMs: parts[0].durationMs,
    ormPrepareMs: parts[1].durationMs,
    driverQueryMs: parts[2].durationMs,
    resultMs: parts[3].durationMs,
    loadMs: outer.durationMs,
    scope: 'PUBLIC_MODEL_EXTENSION_TO_TRANSACTION_ADAPTER_NOT_COMPILER_OR_SERVER_ONLY',
    causalBenefit: 'NOT_ESTABLISHED',
  };
}
