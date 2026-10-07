import { validateRuntimeAssemblyPhases } from './qa09-runtime-assembly-proof.mjs';
import { validateSamplingCorrelationLedger } from './qa09-cold409-proof.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { validatePhaseCorrelation } from './check-qa09-contract-phases.mjs';

export function analyzeAccountPhases(
  patch,
  audit,
  { sampling = false, clientPreparation = false, engineCpu = false, runtimeAssembly = false } = {},
) {
  const proof = validatePhaseCorrelation(patch, audit, {
    accountPhases: true,
    requireColdConflict: true,
    sampling,
    clientPreparation,
    engineCpu,
    runtimeAssembly,
  });
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
      ...(runtimeAssembly ? { runtimeAssembly: validateRuntimeAssemblyPhases(c.phases) } : {}),
      gatewayMs: Number(c.gateway[0].responseLatency),
      lambdaMs: c.lambda[0].elapsedMs,
      ...(clientPreparation
        ? {
            clientPreparationMs: phase('db-client-prepare').durationMs,
            accountBeforePreparationMs:
              Date.parse(phase('db-client-prepare').startedAt) - Date.parse(account.startedAt),
            adapterConnectMs: engineCpu ? null : (phase('db-adapter-connect')?.durationMs ?? null),
            afterAdapterMs: phase('db-client-after-adapter')?.durationMs ?? null,
            preparationBeforeAdapterMs:
              !engineCpu && phase('db-adapter-connect')
                ? Date.parse(phase('db-adapter-connect').startedAt) - Date.parse(phase('db-client-prepare').startedAt)
                : null,
            preparationResidualMs:
              !engineCpu && phase('db-adapter-connect')
                ? phase('db-client-prepare').durationMs -
                  phase('db-adapter-connect').durationMs -
                  phase('db-client-after-adapter').durationMs
                : null,
          }
        : {}),
      ...(engineCpu
        ? {
            enginePrepareMs: phase('db-engine-prepare')?.durationMs ?? null,
            engineProcessCpuUserUs: phase('db-engine-prepare')?.processCpuUserUs ?? null,
            engineProcessCpuSystemUs: phase('db-engine-prepare')?.processCpuSystemUs ?? null,
            engineAfterAdapterMs: phase('db-engine-after-adapter')?.durationMs ?? null,
            engineAfterAdapterProcessCpuUserUs: phase('db-engine-after-adapter')?.processCpuUserUs ?? null,
            engineAfterAdapterProcessCpuSystemUs: phase('db-engine-after-adapter')?.processCpuSystemUs ?? null,
            accountQueryProcessCpuUserUs: account.processCpuUserUs,
            accountQueryProcessCpuSystemUs: account.processCpuSystemUs,
            processCpuScope: 'PROCESS_ALL_THREADS',
          }
        : {}),
      clientTransport: c.clientTransport,
      platformReport: c.platformReports?.[0],
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
    clientPreparationRequired: clientPreparation,
    engineCpuRequired: engineCpu,
    runtimeAssemblyRequired: runtimeAssembly,
    coldConflictObservedCount: proof.coldConflictObservedCount,
    rows,
    boundaries:
      'First root adapter query and pool checkout are per trace, claimed before dispatch. Hook includes Prisma initialization and optional activation. Checkout includes queueing, TCP/TLS and authentication; it is not pure pool waiting. Driver query includes checkout and result conversion. Differences are elapsed observations, not isolated CPU, SQL or lock time; rounding may yield small negative residuals. Nested phases excluded from top-level sum. Preparation uses public ORM extension entry through its own driver dispatch; adapter construction is lazy, suffix includes compiler/planning and scheduling, not isolated CPU or SQL. Warm requests do not invent adapter phases.',
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
  const sampling = process.argv.slice(6).includes('--cold-sampling');
  if (sampling) validateSamplingCorrelationLedger(JSON.parse(child), patch, audit);
  const result = analyzeAccountPhases(patch, audit, {
    sampling,
    engineCpu: process.argv.slice(6).includes('--engine-cpu'),
    runtimeAssembly: process.argv.slice(6).includes('--runtime-assembly'),
    clientPreparation: process.argv.slice(6).includes('--client-preparation'),
  });
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
