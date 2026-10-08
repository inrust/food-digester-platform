import { validateContractLoadSplit } from './qa09-contract-load-proof.mjs';
const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
const groups = [
  [
    'contract-load-orm-prepare',
    ['contract-load-orm-submit', 'contract-load-orm-await'],
    ['CALL_RETURNED', 'DRIVER_DISPATCH'],
  ],
  [
    'contract-load-driver-query',
    ['contract-load-driver-before-pg', 'contract-load-driver-pg', 'contract-load-driver-after-pg'],
    ['PG_DISPATCH', 'PG_SETTLED', 'OPERATION_SETTLED'],
  ],
];
/** Public Promise/adapter boundaries only; the pg interval includes parsing and network, not server-only. */
export function validateContractLoadDetail(phases, ownership = [], required = false) {
  const names = groups.flatMap((g) => g[1]);
  if (!phases.some((p) => names.includes(p.phase))) {
    demand(!required, 'CONTRACT_DETAIL_REQUIRED');
    return null;
  }
  validateContractLoadSplit(phases, ownership, true);
  demand(
    ownership.length === 1 &&
      ownership[0].detailEnabled === true &&
      ownership[0].pgQueries === 1 &&
      ownership[0].pgSettlements === 1,
    'CONTRACT_DETAIL_PG_OWNERSHIP',
  );
  const result = {};
  for (const [parentName, children, boundaries] of groups) {
    const parent = phases.find((p) => p.phase === parentName);
    let cursor = Date.parse(parent.startedAt),
      total = 0;
    const end = Date.parse(parent.completedAt);
    for (const [i, name] of children.entries()) {
      const rows = phases.filter((p) => p.phase === name);
      demand(rows.length === 1, 'CONTRACT_DETAIL_UNIQUE');
      const p = rows[0],
        start = Date.parse(p.startedAt),
        stop = Date.parse(p.completedAt);
      demand(
        ['gatewayRequestId', 'lambdaRequestId', 'operationId'].every((k) => p[k] === parent[k]),
        'CONTRACT_DETAIL_IDS',
      );
      demand(
        p.outcome === 'PASS' && p.errorCode === 'NONE' && p.completionBoundary === boundaries[i],
        'CONTRACT_DETAIL_OUTCOME_BOUNDARY',
      );
      demand(
        p.processCpuScope === 'PROCESS_ALL_THREADS' &&
          ['durationMs', 'processCpuUserUs', 'processCpuSystemUs'].every(
            (k) => Number.isSafeInteger(p[k]) && p[k] >= 0,
          ),
        'CONTRACT_DETAIL_CPU_DURATION',
      );
      demand(p.includesConnectionWait === (name === 'contract-load-driver-pg'), 'CONTRACT_DETAIL_WAIT_SCOPE');
      demand(
        Number.isFinite(start) &&
          Number.isFinite(stop) &&
          start >= cursor &&
          start - cursor <= 5 &&
          stop >= start &&
          stop <= end &&
          Math.abs(stop - start - p.durationMs) <= 5,
        'CONTRACT_DETAIL_ORDER',
      );
      cursor = stop;
      total += p.durationMs;
      result[name] = p.durationMs;
    }
    demand(end - cursor <= 5 && Math.abs(total - parent.durationMs) <= 5, 'CONTRACT_DETAIL_COVERAGE');
  }
  return {
    gate: 'PASS',
    windowsMs: result,
    scope: 'PUBLIC_ORM_RETURN_PG_SETTLEMENT_ADAPTER_WINDOWS',
    compilerOnlyAttribution: false,
    serverExecutionIsolated: false,
    p95Accepted: false,
  };
}
