import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validatePhaseCorrelation } from '../../../../scripts/check-qa09-contract-phases.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const read = (name) => readFileSync(new URL(name, import.meta.url));
const childBytes = read('contract-race.json');
const patchBytes = read('request-correlation.json');
const auditBytes = read('audit-get-correlation.json');
const child = JSON.parse(childBytes), patch = JSON.parse(patchBytes), audit = JSON.parse(auditBytes);
if ([patch, audit].some((r) => r.sourceReceiptSha256 !== hash(childBytes))) throw Error('CHILD_BINDING');
const proof = validatePhaseCorrelation(patch, audit, { accountPhases: true, requireColdConflict: false });
if (proof.coldConflictObservedCount !== 0 || proof.summaries.length !== 25) throw Error('WARM_SCOPE_REQUIRED');
const top = new Set(['runtime-initialize', 'admin-authenticate', 'admin-account-hook', 'db-transaction',
 'audit-failure-write', 'audit-list-query', 'audit-detail-query', 'audit-view', 'response-serialize']);
const rows = [...patch.records, ...audit.records].map((r) => {
 const phase = (name) => r.phases.find((p) => p.phase === name);
 const account = phase('admin-account-query'), driver = phase('db-first-query');
 const measured = r.phases.filter((p) => top.has(p.phase)).reduce((sum, p) => sum + p.durationMs, 0);
 return { id: r.id, requestId: r.requestId, status: r.status, coldStart: r.phases.every((p) => p.coldStart),
 clientMs: r.latencyMs, gatewayMs: Number(r.gateway[0].responseLatency), lambdaMs: r.lambda[0].elapsedMs,
 hookMs: phase('admin-account-hook').durationMs, accountQueryMs: account.durationMs,
 firstDriverQueryMs: driver.durationMs, firstConnectionMs: phase('db-first-connection').durationMs,
 accountBeforeDriverMs: Date.parse(driver.startedAt) - Date.parse(account.startedAt),
 accountNonDriverMs: account.durationMs - driver.durationMs,
 driverNonConnectionMs: driver.durationMs - phase('db-first-connection').durationMs,
 topLevelMeasuredMs: measured, unmeasuredLambdaResidualMs: r.lambda[0].elapsedMs - measured };
});
const checker = readFileSync(new URL('../../../../scripts/check-qa09-contract-phases.mjs', import.meta.url));
if (hash(checker) !== hash(execFileSync('git', ['show', child.sourceCommit + ':scripts/check-qa09-contract-phases.mjs']))) throw Error('CHECKER_DRIFT');
const result = { gate: 'PASS', scope: 'WARM_PHASE_DESCRIPTIVE_ONLY', sourceCommit: child.sourceCommit, prefix: child.prefix,
 coldConflictGate: 'NOT_OBSERVED', coldConflictObservedCount: 0, strictColdAnalyzerExecuted: false,
 p95Accepted: false, fullQa09Accepted: false, rows,
 boundaries: 'Warm samples only. Checkout includes queue/TCP/TLS/auth, adapter query includes checkout/conversion. Nested durations excluded from top-level sum; differences do not isolate SQL/CPU/lock time. Millisecond rounding can yield negative residuals.',
 bindings: { childSha256: hash(childBytes), patchSha256: hash(patchBytes), auditSha256: hash(auditBytes),
 checkerSha256: hash(checker), executorSha256: hash(readFileSync(new URL(import.meta.url))) } };
writeFileSync(new URL('warm-descriptive-timings-verified.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ gate: result.gate, scope: result.scope, rows: rows.length, coldConflictObservedCount: 0 }));
