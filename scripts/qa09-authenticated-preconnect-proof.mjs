const demand = (ok, reason) => {
  if (!ok) throw Error(reason);
};
/** Successful correlated request topology only; no physical-cold or target-benefit inference. */
export function validateAuthenticatedPreconnectPhases(phases, enabled) {
  const prepared = phases.filter((p) => p.phase === 'db-authenticated-preconnect');
  if (!enabled) {
    demand(prepared.length === 0, 'PRECONNECT_DISABLED_PHASE_PRESENT');
    return null;
  }
  const engine = phases.filter((p) => p.phase === 'db-engine-prepare');
  demand(engine.length <= 1 && prepared.length === engine.length, 'PRECONNECT_ENGINE_GENERATION_REQUIRED');
  if (!engine.length) return null;
  const get = (name) => {
    const rows = phases.filter((p) => p.phase === name);
    demand(rows.length === 1, 'PRECONNECT_PHASE_REQUIRED');
    return rows[0];
  };
  const names = [
    'admin-authenticate',
    'admin-account-hook',
    'db-engine-prepare',
    'db-authenticated-preconnect',
    'admin-account-query',
    'db-first-query',
    'db-first-connection',
  ];
  const rows = names.map(get);
  const ids = ['lambdaRequestId', 'gatewayRequestId', 'operationId'];
  demand(
    rows.every(
      (p) =>
        p.outcome === 'PASS' &&
        p.errorCode === 'NONE' &&
        ids.every((k) => typeof p[k] === 'string' && p[k].length > 0 && p[k] === rows[0][k]),
    ),
    'PRECONNECT_ID_OR_OUTCOME',
  );
  const windows = rows.map((p) => [Date.parse(p.startedAt), Date.parse(p.completedAt)]);
  demand(
    windows.every(([s, e]) => Number.isFinite(s) && e >= s) &&
      rows.every((p) => Number.isSafeInteger(p.durationMs) && p.durationMs >= 0),
    'PRECONNECT_TIMESTAMPS',
  );
  const [[, ae], [hs, he], [es, ee], [ps, pe], [qs, qe], [ds, de], [cs, ce]] = windows;
  demand(
    ae <= hs &&
      hs <= es &&
      es <= ps &&
      ps <= ee &&
      pe <= he &&
      Math.max(pe, ee) <= qs &&
      qe <= he &&
      qs <= ds &&
      de <= qe &&
      ds <= cs &&
      ce <= de,
    'PRECONNECT_ORDER_OR_CHECKOUT_OWNERSHIP',
  );
  demand(
    prepared[0].completionBoundary === 'OPERATION_SETTLED' && prepared[0].includesConnectionWait === true,
    'PRECONNECT_SETTLEMENT_REQUIRED',
  );
  return { preconnectMs: prepared[0].durationMs, benefit: 'NOT_EVALUATED' };
}
