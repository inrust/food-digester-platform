import { validateContractAwaitCheckpoint } from './qa09-contract-load-detail-proof.mjs';
const demand = (v, c) => {
  if (!v) throw Error(c);
};
export const publicGroups = [
  [
    'contract-load-driver-query',
    ['contract-load-driver-submit', 'contract-load-driver-await'],
    ['ADAPTER_CALL_RETURNED', 'OPERATION_SETTLED'],
  ],
  [
    'contract-load-driver-pg',
    ['contract-load-pg-submit', 'contract-load-pg-await'],
    ['PG_CALL_RETURNED', 'PG_SETTLED'],
  ],
  [
    'contract-load-result',
    ['contract-load-result-to-model', 'contract-load-result-after-model'],
    ['MODEL_EXTENSION_RESUMED', 'OPERATION_SETTLED'],
  ],
];
/** Existing public await continuation and per-transaction adapter/pg ports; no compiler or server attribution. */
export function validateContractPublicBoundaries(phases, ownership = [], required = false) {
  const names = publicGroups.flatMap((g) => g[1]);
  if (!phases.some((p) => names.includes(p.phase))) {
    demand(!required, 'CONTRACT_PUBLIC_REQUIRED');
    return null;
  }
  validateContractAwaitCheckpoint(phases, ownership, true);
  const own = ownership[0];
  demand(
    own.publicBoundariesEnabled === true &&
      own.modelResumeObserved === true &&
      own.driverReturns === 1 &&
      own.pgReturns === 1 &&
      own.modelResumes === 1,
    'CONTRACT_PUBLIC_OWNERSHIP',
  );
  const windowsMs = {};
  for (const [name, children, boundaries] of publicGroups) {
    const parents = phases.filter((p) => p.phase === name);
    demand(parents.length === 1, 'CONTRACT_PUBLIC_PARENT');
    const parent = parents[0],
      end = Date.parse(parent.completedAt);
    let cursor = Date.parse(parent.startedAt),
      total = 0;
    for (const [i, key] of children.entries()) {
      const rows = phases.filter((p) => p.phase === key);
      demand(rows.length === 1, 'CONTRACT_PUBLIC_UNIQUE');
      const p = rows[0],
        start = Date.parse(p.startedAt),
        stop = Date.parse(p.completedAt);
      demand(
        ['gatewayRequestId', 'lambdaRequestId', 'operationId'].every((k) => p[k] === parent[k]),
        'CONTRACT_PUBLIC_IDS',
      );
      demand(
        p.outcome === 'PASS' && p.errorCode === 'NONE' && p.completionBoundary === boundaries[i],
        'CONTRACT_PUBLIC_OUTCOME_BOUNDARY',
      );
      demand(
        p.processCpuScope === 'PROCESS_ALL_THREADS' &&
          ['durationMs', 'processCpuUserUs', 'processCpuSystemUs'].every(
            (k) => Number.isSafeInteger(p[k]) && p[k] >= 0,
          ),
        'CONTRACT_PUBLIC_CPU',
      );
      demand(
        p.includesConnectionWait === ['contract-load-driver-await', 'contract-load-pg-await'].includes(key),
        'CONTRACT_PUBLIC_WAIT',
      );
      demand(
        Number.isFinite(start) &&
          Number.isFinite(stop) &&
          start >= cursor &&
          start - cursor <= 5 &&
          stop >= start &&
          stop <= end &&
          Math.abs(stop - start - p.durationMs) <= 5,
        'CONTRACT_PUBLIC_ORDER',
      );
      total += p.durationMs;
      cursor = stop;
      windowsMs[key] = p.durationMs;
    }
    demand(end - cursor <= 5 && Math.abs(total - parent.durationMs) <= 5, 'CONTRACT_PUBLIC_COVERAGE');
  }
  return {
    gate: 'PASS',
    windowsMs,
    scope: 'PUBLIC_SYNCHRONOUS_RETURN_EXISTING_AWAIT_CONTINUATION_NO_FORCED_YIELD',
    afterQueueAttribution: 'UNRESOLVED_NO_STABLE_COMPILER_SEAM',
    compilerOnlyAttribution: false,
    serverExecutionIsolated: false,
    p95Accepted: false,
  };
}
