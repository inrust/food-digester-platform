import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { validatePhaseCorrelation } from './check-qa09-contract-phases.mjs';

export function analyzeAccountPhases(patch, audit) {
  const proof = validatePhaseCorrelation(patch, audit, { accountPhases: true, requireColdConflict: true });
  const top = new Set([
    'runtime-initialize',
    'admin-authenticate',
    'admin-account-hook',
    'db-transaction',
    'audit-failure-write',
    'audit-list-query',
    'audit-detail-query',
    'audit-view',
    'response-serialize',
  ]);
  const rows = [...patch.records, ...audit.records].map((c) => {
    const phase = (name) => c.phases.find((p) => p.phase === name);
    const hook = phase('admin-account-hook'),
      account = phase('admin-account-query');
    const driver = phase('db-first-query'),
      connection = phase('db-first-connection');
    const measured = c.phases.filter((p) => top.has(p.phase)).reduce((sum, p) => sum + p.durationMs, 0);
    return {
      id: c.id,
      requestId: c.requestId,
      status: c.status,
      coldStart: c.phases.every((p) => p.coldStart === true),
      clientMs: c.latencyMs,
      gatewayMs: Number(c.gateway[0].responseLatency),
      lambdaMs: c.lambda[0].elapsedMs,
      hookMs: hook.durationMs,
      accountQueryMs: account.durationMs,
      firstDriverQueryMs: driver.durationMs,
      firstConnectionMs: connection.durationMs,
      accountBeforeDriverMs: Date.parse(driver.startedAt) - Date.parse(account.startedAt),
      accountNonDriverMs: account.durationMs - driver.durationMs,
      driverNonConnectionMs: driver.durationMs - connection.durationMs,
      topLevelMeasuredMs: measured,
      unmeasuredLambdaResidualMs: c.lambda[0].elapsedMs - measured,
    };
  });
  return {
    gate: 'PASS',
    scope: 'ACCOUNT_HOOK_FIRST_ROOT_ADAPTER_QUERY_AND_CHECKOUT_DIAGNOSTICS',
    sourceCommit: proof.sourceCommit,
    prefix: proof.prefix,
    fullQa09Accepted: false,
    p95Accepted: false,
    cleanupVerified: false,
    coldConflictObservedCount: proof.coldConflictObservedCount,
    rows,
    boundaries:
      'First root adapter query and pool checkout are per trace, claimed before dispatch. Hook includes Prisma initialization and optional activation. Checkout includes queueing, TCP/TLS and authentication; it is not pure pool waiting. Driver query includes checkout and result conversion. Differences are elapsed observations, not isolated CPU, SQL or lock time; rounding may yield small negative residuals. Nested phases excluded from top-level sum.',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [childFile, patchFile, auditFile, output] = process.argv.slice(2);
  const child = readFileSync(childFile),
    patchBytes = readFileSync(patchFile),
    auditBytes = readFileSync(auditFile);
  const hash = (b) => createHash('sha256').update(b).digest('hex');
  const patch = JSON.parse(patchBytes),
    audit = JSON.parse(auditBytes);
  if (patch.sourceReceiptSha256 !== hash(child) || audit.sourceReceiptSha256 !== hash(child))
    throw Error('CHILD_BYTES_NOT_BOUND');
  const result = analyzeAccountPhases(patch, audit);
  result.bindings = {
    childSha256: hash(child),
    patchSha256: hash(patchBytes),
    auditSha256: hash(auditBytes),
    analyzerSha256: hash(readFileSync(new URL(import.meta.url))),
    checkerSha256: hash(readFileSync(new URL('./check-qa09-contract-phases.mjs', import.meta.url))),
  };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify({
      gate: result.gate,
      requests: result.rows.length,
      coldConflictObservedCount: result.coldConflictObservedCount,
    }),
  );
}
