import { validateContractPublicBoundaries } from './qa09-contract-public-proof.mjs';
import { validateClientSplitPhases } from './qa09-client-split-proof.mjs';
import { validateContractLoadSplit } from './qa09-contract-load-proof.mjs';
import { validateContractLoadDetail, validateContractAwaitCheckpoint } from './qa09-contract-load-detail-proof.mjs';
import { validateAuthenticatedPreconnectPhases } from './qa09-authenticated-preconnect-proof.mjs';
import { validateRuntimeAssemblyPhases } from './qa09-runtime-assembly-proof.mjs';
import { validateSamplingCorrelationLedger } from './qa09-cold409-proof.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
export function validatePhaseCorrelation(
  patch,
  audit,
  {
    accountPhases = false,
    requireColdConflict = false,
    sampling = false,
    clientPreparation = false,
    clientSplit = false,
    engineCpu = false,
    runtimeAssembly = false,
    authenticatedPreconnect = false,
    contractLoadSplit = false,
    contractLoadDetail = false,
    contractAwaitCheckpoint = false,
    contractPublicBoundaries = false,
  } = {},
) {
  demand(!contractPublicBoundaries || contractAwaitCheckpoint, 'PUBLIC_REQUIRES_AWAIT');
  demand(!contractAwaitCheckpoint || contractLoadDetail, 'AWAIT_REQUIRES_DETAIL');
  demand(!authenticatedPreconnect || (engineCpu && runtimeAssembly), 'PRECONNECT_REQUIRES_ENGINE_RUNTIME_PHASES');
  demand(!clientSplit || clientPreparation, 'CLIENT_SPLIT_REQUIRES_PREPARATION');
  demand(!engineCpu || clientPreparation, 'ENGINE_CPU_REQUIRES_CLIENT_PREPARATION');
  demand(!clientPreparation || accountPhases, 'CLIENT_PREPARATION_REQUIRES_ACCOUNT_PHASES');
  demand(!sampling || accountPhases, 'SAMPLING_REQUIRES_ACCOUNT_PHASES');
  demand(!requireColdConflict || accountPhases, 'COLD_CONFLICT_REQUIRES_ACCOUNT_PHASES');
  for (const r of [patch, audit])
    demand(
      r.gate === 'PASS' &&
        r.records.length > 0 &&
        r.records.every(
          (c) => c.exactLinked && c.responseReceived && c.lambda.length === 1 && c.gateway.length === 1,
        ) &&
        Object.keys(r.logReadErrors).length === 0,
      'HTTP_CORRELATION_INCOMPLETE',
    );
  demand(
    patch.scope ===
      (sampling
        ? 'OWN_COLD409_PATCH_GATEWAY_LAMBDA_REQUEST_CORRELATION'
        : 'OWN_CONTRACT_PATCH_GATEWAY_LAMBDA_REQUEST_CORRELATION') &&
      audit.scope ===
        (sampling
          ? 'OWN_COLD409_AUDIT_GET_GATEWAY_LAMBDA_REQUEST_CORRELATION'
          : 'OWN_AUDIT_GET_GATEWAY_LAMBDA_REQUEST_CORRELATION') &&
      (sampling ? [6, 12].includes(patch.records.length) : patch.records.length === 6) &&
      (sampling ? audit.records.length === 9 * (patch.records.length / 6) : audit.records.length >= 10) &&
      patch.sourceReceiptSha256 === audit.sourceReceiptSha256 &&
      patch.sourceCommit === audit.sourceCommit &&
      patch.prefix === audit.prefix,
    'SAME_RUN_REQUIRED',
  );
  const summaries = [];
  for (const [kind, r] of [
    ['patch', patch],
    ['audit', audit],
  ])
    for (const c of r.records) {
      const phases = c.phases;
      if (sampling) {
        demand(c.clientTransport?.source === 'NODE_HTTPS_SOCKET_EVENTS', 'CLIENT_SOCKET_OBSERVATION_REQUIRED');
        demand(
          ['socketAcquisitionMs', 'requestSentAtMs', 'headersAtMs', 'bodyEndAtMs', 'bodyReadMs', 'jsonParseMs'].every(
            (name) => Number.isFinite(c.clientTransport[name]) && c.clientTransport[name] >= 0,
          ) &&
            ['dnsMs', 'tcpMs', 'tlsMs'].every(
              (name) =>
                c.clientTransport[name] === null ||
                (Number.isFinite(c.clientTransport[name]) && c.clientTransport[name] >= 0),
            ) &&
            c.clientTransport.bodyEndAtMs >= c.clientTransport.headersAtMs &&
            typeof c.clientTransport.reusedSocket === 'boolean' &&
            (!c.clientTransport.reusedSocket ||
              ['dnsMs', 'tcpMs', 'tlsMs'].every((name) => c.clientTransport[name] === null)),
          'CLIENT_TRANSPORT_TIMINGS_REQUIRED',
        );
        demand(
          c.platformReports?.length === 1 &&
            c.platformReports[0].lambdaRequestId === c.lambda[0].lambdaRequestId &&
            Number.isFinite(c.platformReports[0].durationMs) &&
            c.platformReports[0].durationMs >= 0 &&
            c.platformReports[0].memoryMiB === 512,
          'EXACT_PLATFORM_REPORT_REQUIRED',
        );
      }
      demand(
        phases.every(
          (p) =>
            p.lambdaRequestId === c.lambda[0].lambdaRequestId &&
            p.gatewayRequestId === c.requestId &&
            p.operationId === c.lambda[0].operationId &&
            Number.isFinite(p.durationMs) &&
            p.durationMs >= 0,
        ),
        'PHASE_ID_MISMATCH',
      );
      const phase = (name, outcome = 'PASS', error = 'NONE') => {
        const found = phases.filter((p) => p.phase === name);
        demand(
          found.length === 1 && found[0].outcome === outcome && found[0].errorCode === error,
          'PHASE_MISSING_OR_WRONG_OUTCOME',
        );
        return found[0];
      };
      if (runtimeAssembly) validateRuntimeAssemblyPhases(phases);
      validateAuthenticatedPreconnectPhases(phases, authenticatedPreconnect);
      phase('admin-authenticate');
      if (accountPhases) {
        for (const name of ['admin-account-hook', 'admin-account-query', 'db-first-query', 'db-first-connection'])
          demand(phase(name).includesConnectionWait === true, 'ACCOUNT_CONNECTION_BOUNDARY_REQUIRED');
        const intervals = ['admin-account-hook', 'admin-account-query', 'db-first-query', 'db-first-connection'].map(
          (name) => {
            const p = phases.find((p) => p.phase === name);
            const start = Date.parse(p.startedAt),
              end = Date.parse(p.completedAt);
            demand(Number.isFinite(start) && Number.isFinite(end) && end >= start, 'ACCOUNT_TIMESTAMPS_REQUIRED');
            return [start, end];
          },
        );
        for (let i = 1; i < intervals.length; i++)
          demand(
            intervals[i][0] >= intervals[i - 1][0] && intervals[i][1] <= intervals[i - 1][1],
            'ACCOUNT_PHASE_NOT_NESTED',
          );
      }
      validateClientSplitPhases(c.phases, clientSplit);
      if (clientPreparation) {
        const prepare = phase('db-client-prepare'),
          account = phase('admin-account-query'),
          driver = phase('db-first-query');
        const window = (p) => [Date.parse(p.startedAt), Date.parse(p.completedAt)];
        const [start, end] = window(prepare),
          [accountStart, accountEnd] = window(account),
          [driverStart] = window(driver);
        demand(
          prepare.completionBoundary === 'DRIVER_DISPATCH' &&
            prepare.includesConnectionWait === false &&
            [start, end].every(Number.isFinite) &&
            start >= accountStart &&
            end >= start &&
            end <= driverStart &&
            end <= accountEnd,
          'CLIENT_PREPARATION_BOUNDARY_REQUIRED',
        );
        const adapters = c.phases.filter((p) => p.phase === 'db-adapter-connect'),
          suffixes = c.phases.filter((p) => p.phase === 'db-client-after-adapter');
        demand(
          adapters.length <= 1 &&
            suffixes.length === (engineCpu ? 0 : adapters.length) &&
            (engineCpu || !c.phases.every((p) => p.coldStart === true) || adapters.length === 1),
          'CLIENT_ADAPTER_PHASES_REQUIRED',
        );
        if (adapters.length && !engineCpu) {
          const adapter = phase('db-adapter-connect'),
            suffix = phase('db-client-after-adapter');
          const [aStart, aEnd] = window(adapter),
            [sStart, sEnd] = window(suffix);
          demand(
            adapter.includesConnectionWait === false &&
              suffix.includesConnectionWait === false &&
              suffix.completionBoundary === 'DRIVER_DISPATCH' &&
              [aStart, aEnd, sStart, sEnd].every(Number.isFinite) &&
              aStart >= start &&
              aEnd >= aStart &&
              aEnd <= sStart &&
              sStart >= start &&
              sEnd >= sStart &&
              sEnd <= end,
            'CLIENT_ADAPTER_PHASE_NOT_NESTED',
          );
        }
      }
      if (engineCpu) {
        const cpu = (p) =>
          demand(
            p.processCpuScope === 'PROCESS_ALL_THREADS' &&
              ['processCpuUserUs', 'processCpuSystemUs'].every((k) => Number.isSafeInteger(p[k]) && p[k] >= 0),
            'PROCESS_CPU_METRICS_REQUIRED',
          );
        cpu(phase('admin-account-query'));
        const engines = phases.filter((p) => p.phase === 'db-engine-prepare');
        demand(
          engines.length <= 1 && (!phases.every((p) => p.coldStart === true) || engines.length === 1),
          'ENGINE_PREPARATION_REQUIRED',
        );
        if (engines.length) {
          const engine = phase('db-engine-prepare'),
            suffix = phase('db-engine-after-adapter'),
            adapter = phase('db-adapter-connect');
          cpu(engine);
          cpu(suffix);
          const window = (p) => [Date.parse(p.startedAt), Date.parse(p.completedAt)];
          const [es, ee] = window(engine),
            [ss, se] = window(suffix),
            [as, ae] = window(adapter),
            [hs, he] = window(phase('admin-account-hook')),
            [qs] = window(phase('admin-account-query'));
          demand(
            [es, ee, ss, se, as, ae, hs, he, qs].every(Number.isFinite) &&
              hs <= es &&
              es <= as &&
              as <= ae &&
              ae <= ss &&
              ss <= se &&
              se <= ee &&
              ee <= qs &&
              ee <= he &&
              engine.completionBoundary === 'OPERATION_SETTLED' &&
              suffix.completionBoundary === 'OPERATION_SETTLED' &&
              [engine, suffix, adapter].every((p) => p.includesConnectionWait === false),
            'ENGINE_PHASE_BOUNDARY_REQUIRED',
          );
          demand(
            !phases.some(
              (p) => ['db-first-query', 'db-first-connection'].includes(p.phase) && Date.parse(p.startedAt) < ee,
            ),
            'ENGINE_PREPARATION_DISPATCHED_DRIVER',
          );
        } else
          demand(
            !phases.some((p) => ['db-engine-after-adapter', 'db-adapter-connect'].includes(p.phase)),
            'ORPHAN_ENGINE_PHASE',
          );
      }
      if (kind === 'patch') {
        demand(c.method === 'PATCH' && [200, 409].includes(c.status), 'PATCH_RESULT_REQUIRED');
        const conflict = c.status === 409;
        phase('db-transaction-open');
        phase('contract-load');
        validateContractLoadSplit(phases, c.contractLoadOwnership, contractLoadSplit);
        validateContractLoadDetail(phases, c.contractLoadOwnership, contractLoadDetail);
        validateContractAwaitCheckpoint(phases, c.contractLoadOwnership, contractAwaitCheckpoint);
        validateContractPublicBoundaries(phases, c.contractLoadOwnership, contractPublicBoundaries);
        for (const name of [
          'contract-version-update',
          'db-transaction-callback',
          'db-transaction-finish',
          'db-transaction',
        ])
          phase(name, conflict ? 'FAIL' : 'PASS', conflict ? 'VERSION_CONFLICT' : 'NONE');
        if (conflict) {
          phase('audit-failure-write');
          demand(
            !phases.some((p) => ['audit-success-write', 'contract-readback'].includes(p.phase)),
            'CONFLICT_HAS_SUCCESS_PHASE',
          );
        } else {
          phase('contract-readback');
          phase('audit-success-write');
        }
      } else {
        demand(c.method === 'GET' && c.status === 200, 'AUDIT_GET_RESULT_REQUIRED');
        phase(c.operationId === 'listAuditLogs' ? 'audit-list-query' : 'audit-detail-query');
        phase('audit-view');
      }
      summaries.push({
        id: c.id,
        status: c.status,
        clientMs: c.latencyMs,
        gatewayMs: Number(c.gateway[0].responseLatency),
        lambdaMs: c.lambda[0].elapsedMs,
        phases: phases.map((p) => ({
          phase: p.phase,
          durationMs: p.durationMs,
          outcome: p.outcome,
          errorCode: p.errorCode,
          includesConnectionWait: p.includesConnectionWait,
        })),
      });
    }
  const coldConflicts = patch.records.filter(
    (c) =>
      c.status === 409 &&
      c.phases.length > 0 &&
      c.phases.every((p) => p.coldStart === true) &&
      c.phases.filter((p) => p.phase === 'runtime-initialize').length === 1 &&
      c.phases.some((p) => p.phase === 'runtime-initialize' && p.outcome === 'PASS' && p.errorCode === 'NONE'),
  );
  const verifiedCold = sampling
    ? coldConflicts.filter(
        (c) => Number.isFinite(c.platformReports[0].initDurationMs) && c.platformReports[0].initDurationMs > 0,
      )
    : coldConflicts;
  if (requireColdConflict) demand(verifiedCold.length > 0, 'COLD_CONFLICT_REQUIRED');
  return {
    gate: 'PASS',
    scope: 'CONTRACT_DATABASE_CONFLICT_AND_AUDIT_GET_PHASE_OBSERVATION',
    sourceCommit: patch.sourceCommit,
    prefix: patch.prefix,
    fullQa09Accepted: false,
    cleanupVerified: false,
    p95Accepted: false,
    accountPhasesRequired: accountPhases,
    clientPreparationRequired: clientPreparation,
    clientSplitRequired: clientSplit,
    contractLoadSplitRequired: contractLoadSplit,
    contractLoadDetailRequired: contractLoadDetail,
    contractAwaitCheckpointRequired: contractAwaitCheckpoint,
    contractPublicBoundariesRequired: contractPublicBoundaries,
    engineCpuRequired: engineCpu,
    authenticatedPreconnectRequired: authenticatedPreconnect,
    runtimeAssemblyRequired: runtimeAssembly,
    coldConflictObservedCount: verifiedCold.length,
    applicationColdConflictObservedCount: coldConflicts.length,
    platformColdProofRequired: sampling,
    coldConflictRequired: requireColdConflict,
    summaries,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [childFile, patchFile, auditFile, out] = process.argv.slice(2);
  const child = readFileSync(childFile);
  const patch = JSON.parse(readFileSync(patchFile)),
    audit = JSON.parse(readFileSync(auditFile));
  demand(patch.sourceReceiptSha256 === createHash('sha256').update(child).digest('hex'), 'CHILD_BYTES_NOT_BOUND');
  const sampling = process.argv.slice(6).includes('--cold-sampling');
  if (sampling) validateSamplingCorrelationLedger(JSON.parse(child), patch, audit);
  const r = validatePhaseCorrelation(patch, audit, {
    sampling,
    authenticatedPreconnect: process.argv.slice(6).includes('--authenticated-preconnect'),
    engineCpu: process.argv.slice(6).includes('--engine-cpu'),
    runtimeAssembly: process.argv.slice(6).includes('--runtime-assembly'),
    clientPreparation: process.argv.slice(6).includes('--client-preparation'),
    clientSplit: process.argv.slice(6).includes('--client-split'),
    contractLoadSplit: process.argv.slice(6).includes('--contract-load-split'),
    contractLoadDetail: process.argv.slice(6).includes('--contract-load-detail'),
    contractAwaitCheckpoint: process.argv.slice(6).includes('--contract-await-checkpoint'),
    contractPublicBoundaries: process.argv.slice(6).includes('--contract-public-boundaries'),
    accountPhases: process.argv.slice(6).includes('--account-phases'),
    requireColdConflict: process.argv.slice(6).includes('--require-cold-conflict'),
  });
  r.preconnectCheckerSha256 = createHash('sha256')
    .update(readFileSync(new URL('./qa09-authenticated-preconnect-proof.mjs', import.meta.url)))
    .digest('hex');
  r.checkerSha256 = createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex');
  r.clientSplitCheckerSha256 = createHash('sha256')
    .update(readFileSync(new URL('./qa09-client-split-proof.mjs', import.meta.url)))
    .digest('hex');
  r.contractLoadCheckerSha256 = createHash('sha256')
    .update(readFileSync(new URL('./qa09-contract-load-proof.mjs', import.meta.url)))
    .digest('hex');
  r.contractLoadDetailCheckerSha256 = createHash('sha256')
    .update(readFileSync(new URL('./qa09-contract-load-detail-proof.mjs', import.meta.url)))
    .digest('hex');
  r.contractPublicCheckerSha256 = createHash('sha256')
    .update(readFileSync(new URL('./qa09-contract-public-proof.mjs', import.meta.url)))
    .digest('hex');
  writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
  console.log(JSON.stringify({ gate: r.gate, scope: r.scope, requests: r.summaries.length }));
}
