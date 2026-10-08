const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
/** Public extension boundaries only; asynchronous suffix includes compilation/planning/scheduling. */
export function validateClientSplitPhases(phases, required = false) {
  const names = ['db-client-observer-setup', 'db-client-submit', 'db-client-await-dispatch'];
  if (!names.some((n) => phases.some((p) => p.phase === n))) {
    demand(!required, 'CLIENT_SPLIT_REQUIRED');
    return null;
  }
  const one = (n) => {
    const rows = phases.filter((p) => p.phase === n);
    demand(rows.length === 1, 'CLIENT_SPLIT_UNIQUE');
    return rows[0];
  };
  const all = ['db-client-prepare', ...names].map(one),
    [outer, setup, submit, wait] = all;
  for (const p of all) {
    demand(
      p.outcome === 'PASS' && p.errorCode === 'NONE' && p.includesConnectionWait === false,
      'CLIENT_SPLIT_OUTCOME',
    );
    demand(
      ['lambdaRequestId', 'gatewayRequestId', 'operationId'].every(
        (k) => typeof p[k] === 'string' && p[k] !== 'unknown' && p[k] === outer[k],
      ),
      'CLIENT_SPLIT_IDS',
    );
    demand(
      p.processCpuScope === 'PROCESS_ALL_THREADS' &&
        ['processCpuUserUs', 'processCpuSystemUs', 'durationMs'].every((k) => Number.isSafeInteger(p[k]) && p[k] >= 0),
      'CLIENT_SPLIT_CPU_DURATION',
    );
  }
  const [[os, oe], [xs, xe], [ss, se], [ws, we]] = all.map((p) => [Date.parse(p.startedAt), Date.parse(p.completedAt)]);
  demand(
    [os, oe, xs, xe, ss, se, ws, we].every(Number.isFinite) &&
      os <= xs &&
      xs <= xe &&
      xe <= ss &&
      ss <= se &&
      se <= ws &&
      ws <= we &&
      we <= oe &&
      xs - os <= 5 &&
      ss - xe <= 5 &&
      ws - se <= 5 &&
      oe - we <= 5,
    'CLIENT_SPLIT_ORDER',
  );
  demand(
    setup.completionBoundary === 'CALL_RETURNED' &&
      ['CALL_RETURNED', 'DRIVER_DISPATCH'].includes(submit.completionBoundary) &&
      outer.completionBoundary === 'DRIVER_DISPATCH' &&
      wait.completionBoundary === 'DRIVER_DISPATCH',
    'CLIENT_SPLIT_BOUNDARY',
  );
  demand(
    Math.abs(outer.durationMs - setup.durationMs - submit.durationMs - wait.durationMs) <= 5 &&
      all.every((p) => Math.abs(Date.parse(p.completedAt) - Date.parse(p.startedAt) - p.durationMs) <= 5),
    'CLIENT_SPLIT_COVERAGE',
  );
  return {
    observerSetupMs: setup.durationMs,
    submitMs: submit.durationMs,
    awaitDispatchMs: wait.durationMs,
    preparationMs: outer.durationMs,
    partitionResidualMs: outer.durationMs - setup.durationMs - submit.durationMs - wait.durationMs,
    processCpuUserUs: outer.processCpuUserUs,
    processCpuSystemUs: outer.processCpuSystemUs,
    scope: 'NESTED_PROCESS_ALL_THREADS_NOT_COMPILER_ONLY_OR_NETWORK_WAIT',
  };
}
