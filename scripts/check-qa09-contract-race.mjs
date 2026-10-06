import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closedDomainPrefixes } from './qa09-owned-domain-cleanup.mjs';
import { validateContractRecovery } from './recover-qa09-contract-race.mjs';
import { validateBusinessVersion, validateBusinessDatabaseReceipts } from './check-qa09-business-target.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const requireProof = (ok, code) => {
  if (!ok) throw Error(code);
};
export function bindAudits(attempts, audits) {
  requireProof(audits.length === 3 && new Set(audits.map((a) => a.auditId)).size === 3, 'THREE_UNIQUE_AUDITS_REQUIRED');
  for (const a of attempts) {
    const matches = audits.filter((b) => b.requestId === a.clientRequestId);
    requireProof(
      a.observation.status === 200
        ? matches.length === 1 &&
            matches[0].result === 'SUCCESS' &&
            matches[0].beforeVersion === a.ifMatch &&
            matches[0].afterVersion === a.ifMatch + 1
        : matches.length === 0,
      'AUDIT_REQUEST_VERSION_MISMATCH',
    );
  }
}
export function overlap(records) {
  return [1, 2, 3].map((round) => {
    const pair = ['a', 'b'].map((s) => records.find((r) => r.id === `race:${round}:${s}`));
    requireProof(
      pair.every((r) => r?.exactLinked && r.gateway?.length === 1 && r.lambda?.length === 1),
      'EXACT_LOG_PAIR_REQUIRED',
    );
    const gateway = pair.map((r) => [
      Number(r.gateway[0].requestTimeEpoch),
      Number(r.gateway[0].requestTimeEpoch) + Number(r.gateway[0].responseLatency),
    ]);
    const lambda = pair.map((r) => [r.lambda[0].logTimestampMs - r.lambda[0].elapsedMs, r.lambda[0].logTimestampMs]);
    requireProof([...gateway.flat(), ...lambda.flat()].every(Number.isFinite), 'LOG_TIMING_REQUIRED');
    const ms = (w) => Math.max(0, Math.min(w[0][1], w[1][1]) - Math.max(w[0][0], w[1][0]));
    return {
      round,
      gatewayArrivalDeltaMs: Math.abs(gateway[1][0] - gateway[0][0]),
      gatewayOverlapMs: ms(gateway),
      lambdaApproximateOverlapMs: ms(lambda),
      lambdaIntervalsFromCompletionLogMs: lambda,
    };
  });
}
export function checkContractEvidence(dir) {
  const bindings = {};
  const read = (file) => {
    const bytes = readFileSync(join(dir, file));
    bindings[file] = hash(bytes);
    return JSON.parse(bytes);
  };
  const child = read('contract-race.json'),
    parent = read('contract-race.json.fixtures.json');
  const race = validateContractRecovery(child, parent);
  for (const round of race.rounds) {
    const pair = race.attempts.filter((a) => a.round === round.round);
    const winner = pair.find((a) => a.observation.status === 200);
    requireProof(
      round.beforeVersion === round.round &&
        pair.every(
          (a) =>
            a.ifMatch === round.beforeVersion &&
            a.method === 'PATCH' &&
            a.path === `/api/v1/admin/contracts/${race.contractId}`,
        ) &&
        round.readback.name === winner.name &&
        pair.find((a) => a.observation.status === 409).observation.errorCode === 'VERSION_CONFLICT',
      'CONFLICT_READBACK_MISMATCH',
    );
  }
  const version = read('application-version.json'),
    final = read('runtime-final.json'),
    runtimeBinding = read('runtime-final-binding.json');
  validateBusinessVersion(version, child.sourceCommit);
  requireProof(
    runtimeBinding.gate === 'PASS' &&
      runtimeBinding.initialVersionSha256 === bindings['application-version.json'] &&
      runtimeBinding.runtimeFinalSha256 === bindings['runtime-final.json'],
    'RUNTIME_BINDING_MISMATCH',
  );
  requireProof(
    final.lambdaArtifacts.length === 19 &&
      version.lambdaArtifacts.every((a) =>
        final.lambdaArtifacts.some(
          (b) =>
            b.name === a.name &&
            ['codeSha256', 'revisionId', 'runtime', 'state', 'lastUpdateStatus'].every((k) => b[k] === a[k]),
        ),
      ),
    'RUNTIME_DRIFT',
  );
  const correlation = read('request-correlation.json'),
    recovery = read('recovery.json');
  requireProof(
    correlation.gate === 'PASS' &&
      correlation.exactLinkedCount === 6 &&
      correlation.sourceReceiptSha256 === bindings['contract-race.json'] &&
      Object.keys(correlation.logReadErrors).length === 0 &&
      correlation.records.length === 6,
    'CORRELATION_NOT_BOUND',
  );
  for (const a of race.attempts)
    requireProof(
      correlation.records.filter(
        (r) =>
          r.requestId === a.clientRequestId &&
          r.status === a.observation.status &&
          r.exactLinked &&
          !r.integrationThrottled,
      ).length === 1,
      'REQUEST_LINK_MISMATCH',
    );
  requireProof(
    recovery.gate === 'PASS' &&
      recovery.finishedAt &&
      recovery.semanticCompletion === 'PASS' &&
      recovery.patchReplay === false &&
      recovery.originalChildSha256 === bindings['contract-race.json'] &&
      recovery.originalParentSha256 === bindings['contract-race.json.fixtures.json'] &&
      recovery.prefix === child.prefix &&
      recovery.sourceCommit === child.sourceCommit &&
      recovery.fullQa09Accepted === false &&
      recovery.checks.length > 0 &&
      recovery.checks.every((c) => c.result === 'PASS') &&
      recovery.cleanup.every((c) => c.result === 'PASS'),
    'RECOVERY_NOT_COMPLETE',
  );
  bindAudits(race.attempts, recovery.audit);
  for (const [kind, rows, key] of [
    ['site', child.createdSites, 'id'],
    ['customer', child.customers, 'id'],
    ['identity', [...child.createdIdentities, parent.identity], 'username'],
  ])
    for (const row of rows)
      requireProof(
        recovery.cleanup.some((c) => c.type === kind && c[key] === row[key] && c.result === 'PASS'),
        'OWN_RESOURCE_CLEANUP_MISSING',
      );
  for (const kind of ['business-fixtures', 'database-fixtures', 'license-domain-archive', 'recovery-identity'])
    requireProof(
      recovery.cleanup.some((c) => c.type === kind && c.result === 'PASS'),
      'CLEANUP_STAGE_MISSING',
    );
  const builds = [...child.databaseBuilds, ...recovery.databaseBuilds];
  const db = builds.map((b) => read(b.receipt.slice(b.receipt.lastIndexOf('/') + 1)));
  validateBusinessDatabaseReceipts({ ...child, databaseBuilds: builds }, db);
  const baseline = db[0].result,
    observed = db.findLast((d) => d.result.action === 'observe').result;
  requireProof(
    ['devices', 'certificates', 'requests'].every((k) => observed[k].length === 0) &&
      JSON.stringify(observed.originalFingerprints) === JSON.stringify(baseline.originalFingerprints),
    'FINAL_DEVICE_BASELINE_MISMATCH',
  );
  const domain = read('recovery.json.domain-cleanup.json');
  const closed = read('recovery.json.closed-ledger.json');
  const prefixes = closedDomainPrefixes(closed);
  requireProof(
    domain.gate === 'PASS' &&
      domain.prefix === child.prefix &&
      domain.parentReceiptSha256 === bindings['recovery.json.closed-ledger.json'] &&
      JSON.stringify(domain.prefixes) === JSON.stringify(prefixes) &&
      domain.observations.length === 2 &&
      prefixes.every((p) => domain.observations.some((o) => o.prefix === p && o.versionsRemaining === 0)),
    'DOMAIN_CLEANUP_MISSING',
  );
  for (const file of ['contract-race.json.sources.json', 'recovery.json.sources.json']) {
    const sources = read(file);
    requireProof(
      sources.sources.length > 0 &&
        sources.sources.every((s) => hash(Buffer.from(s.sourceBase64, 'base64')) === s.sha256),
      'EXECUTOR_SOURCE_HASH_MISMATCH',
    );
  }
  requireProof(recovery.sourceReceiptSha256 === bindings['recovery.json.sources.json'], 'RECOVERY_SOURCE_NOT_BOUND');
  const timing = overlap(correlation.records);
  requireProof(
    timing.some((t) => t.lambdaApproximateOverlapMs > 0),
    'CLOUD_CONCURRENCY_NOT_OBSERVED',
  );
  return {
    task: 'QA-09',
    scope: 'OWN_CONTRACT_PATCH_RECOVERED_SEMANTICS_CORRELATION_AND_CLEANUP',
    gate: 'PASS',
    sourceCommit: child.sourceCommit,
    prefix: child.prefix,
    originalRunGate: child.gate,
    originalParentGate: parent.gate,
    fullQa09Accepted: false,
    historicalSibling: 'UNPROVEN_NO_RECEIPT',
    requests: 6,
    successAudits: 3,
    timing,
    bindings,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [dir, out] = process.argv.slice(2);
  const r = checkContractEvidence(dir);
  writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
  console.log(JSON.stringify({ gate: r.gate, requests: r.requests, successAudits: r.successAudits, timing: r.timing }));
}
