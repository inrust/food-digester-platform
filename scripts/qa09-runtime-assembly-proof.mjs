const demand = (ok, reason) => {
  if (!ok) throw Error(reason);
};
/** Successful correlated requests only; initialization failure receipts remain separate. */
export function validateRuntimeAssemblyPhases(phases) {
  const names = [
    'runtime-initialize',
    'runtime-database-secret',
    'runtime-license-secret',
    'runtime-client-construct',
    'runtime-route-assembly',
  ];
  const found = names.map((name) => phases.filter((p) => p.phase === name));
  if (found.every((p) => p.length === 0)) return null;
  demand(
    found.every((p) => p.length === 1),
    'RUNTIME_ASSEMBLY_PHASES_REQUIRED',
  );
  const [runtime, _db, _license, client, assembly] = found.map((p) => p[0]);
  const ids = ['lambdaRequestId', 'gatewayRequestId', 'operationId'];
  demand(
    found
      .flat()
      .every(
        (p) =>
          p.outcome === 'PASS' &&
          p.errorCode === 'NONE' &&
          p.includesConnectionWait === false &&
          ids.every((k) => typeof p[k] === 'string' && p[k] === runtime[k]),
      ),
    'RUNTIME_ASSEMBLY_ID_OR_OUTCOME',
  );
  const windows = found.map((p) => [Date.parse(p[0].startedAt), Date.parse(p[0].completedAt)]);
  demand(
    windows.every(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a <= b),
    'RUNTIME_ASSEMBLY_TIMESTAMPS',
  );
  const [[rs, re], [ds, de], [ls, le], [cs, ce], [as, ae]] = windows;
  demand(
    rs <= ds && rs <= ls && Math.max(de, le) <= cs && cs <= ce && ce <= as && as <= ae && ae <= re,
    'RUNTIME_ASSEMBLY_ORDER',
  );
  demand(
    found.flat().every((p) => Number.isSafeInteger(p.durationMs) && p.durationMs >= 0),
    'RUNTIME_ASSEMBLY_DURATION',
  );
  for (const p of [client, assembly])
    demand(
      p.processCpuScope === 'PROCESS_ALL_THREADS' &&
        ['processCpuUserUs', 'processCpuSystemUs'].every((k) => Number.isSafeInteger(p[k]) && p[k] >= 0),
      'RUNTIME_ASSEMBLY_CPU_REQUIRED',
    );
  return {
    clientConstructMs: client.durationMs,
    routeAssemblyMs: assembly.durationMs,
    clientCpuUserUs: client.processCpuUserUs,
    clientCpuSystemUs: client.processCpuSystemUs,
    assemblyCpuUserUs: assembly.processCpuUserUs,
    assemblyCpuSystemUs: assembly.processCpuSystemUs,
    runtimeMs: runtime.durationMs,
    postSecretsIntervalMs: re - Math.max(de, le),
    unpartitionedPostSecretsIntervalMs: Math.max(0, re - Math.max(de, le) - (ce - cs) - (ae - as)),
    scope: 'NESTED_INTERVALS_NOT_ADDITIVE_PROCESS_ALL_THREADS',
  };
}
