import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
export function validatePhaseCorrelation(patch, audit, { accountPhases = false, requireColdConflict = false } = {}) {
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
    patch.scope === 'OWN_CONTRACT_PATCH_GATEWAY_LAMBDA_REQUEST_CORRELATION' &&
      audit.scope === 'OWN_AUDIT_GET_GATEWAY_LAMBDA_REQUEST_CORRELATION' &&
      patch.records.length === 6 &&
      audit.records.length >= 10 &&
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
      if (kind === 'patch') {
        demand(c.method === 'PATCH' && [200, 409].includes(c.status), 'PATCH_RESULT_REQUIRED');
        const conflict = c.status === 409;
        phase('db-transaction-open');
        phase('contract-load');
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
  if (requireColdConflict) demand(coldConflicts.length > 0, 'COLD_CONFLICT_REQUIRED');
  return {
    gate: 'PASS',
    scope: 'CONTRACT_DATABASE_CONFLICT_AND_AUDIT_GET_PHASE_OBSERVATION',
    sourceCommit: patch.sourceCommit,
    prefix: patch.prefix,
    fullQa09Accepted: false,
    cleanupVerified: false,
    p95Accepted: false,
    accountPhasesRequired: accountPhases,
    coldConflictObservedCount: coldConflicts.length,
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
  const r = validatePhaseCorrelation(patch, audit, {
    accountPhases: process.argv.slice(6).includes('--account-phases'),
    requireColdConflict: process.argv.slice(6).includes('--require-cold-conflict'),
  });
  r.checkerSha256 = createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex');
  writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
  console.log(JSON.stringify({ gate: r.gate, scope: r.scope, requests: r.summaries.length }));
}
