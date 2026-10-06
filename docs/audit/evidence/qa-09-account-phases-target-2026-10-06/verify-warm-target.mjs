import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  validateBusinessVersion,
  validateBusinessDatabaseReceipts,
} from '../../../../scripts/check-qa09-business-target.mjs';
import { validateContractRecovery } from '../../../../scripts/recover-qa09-contract-race.mjs';
import { bindAudits, overlap } from '../../../../scripts/check-qa09-contract-race.mjs';
import { validatePhaseCorrelation } from '../../../../scripts/check-qa09-contract-phases.mjs';
const dir = dirname(fileURLToPath(import.meta.url));
const bindings = {};
const digest = (b) => createHash('sha256').update(b).digest('hex');
const demand = (ok, reason) => {
  if (!ok) throw Error(reason);
};
const read = (name) => {
  const b = readFileSync(join(dir, name));
  bindings[name] = digest(b);
  return JSON.parse(b);
};
const child = read('contract-race.json'),
  parent = read('contract-race.json.fixtures.json');
demand(
  child.gate === 'PASS' &&
    child.cleanupComplete === true &&
    child.checks.every((c) => c.result === 'PASS') &&
    parent.globalSignOut === 'PASS' &&
    parent.gate === 'PASS' &&
    parent.finishedAt,
  'FINAL_RESULTS_INCOMPLETE',
);
const race = validateContractRecovery(child, parent);
const version = read('application-version.json'),
  final = read('runtime-final.json');
validateBusinessVersion(version, child.sourceCommit);
demand(
  final.sourceCommit === child.sourceCommit && final.lambdaArtifacts.length === 19 && final.blockers.length === 0,
  'FINAL_VERSION_INCOMPLETE',
);
for (const a of version.lambdaArtifacts)
  demand(
    final.lambdaArtifacts.some(
      (b) =>
        b.name === a.name &&
        ['codeSha256', 'revisionId', 'runtime', 'state', 'lastUpdateStatus'].every((k) => a[k] === b[k]),
    ),
    'RUNTIME_DRIFT',
  );
const runtimeBinding = {
  gate: 'PASS',
  sourceCommit: child.sourceCommit,
  initialVersionSha256: bindings['application-version.json'],
  runtimeFinalSha256: bindings['runtime-final.json'],
  lambdaCount: 19,
  scope: 'FINAL_METADATA_PAIRED_WITH_INITIAL_ZIP_BYTES',
  rawRuntimeGate: final.gate,
};
writeFileSync(join(dir, 'runtime-final-binding.json'), JSON.stringify(runtimeBinding, null, 2) + '\n');
read('runtime-final-binding.json');
const patch = read('request-correlation.json'),
  audit = read('audit-get-correlation.json');
for (const [r, n] of [
  [patch, 6],
  [audit, 19],
])
  demand(
    r.gate === 'PASS' &&
      r.exactLinkedCount === n &&
      r.records.length === n &&
      Object.keys(r.logReadErrors).length === 0 &&
      r.sourceReceiptSha256 === bindings['contract-race.json'],
    'CORRELATION_BINDING',
  );
const phase = validatePhaseCorrelation(patch, audit, { accountPhases: true, requireColdConflict: false });
demand(
  phase.summaries.length === 25 &&
    read('warm-phase-proof.json').gate === 'PASS' &&
    read('warm-phase-proof.json').accountPhasesRequired === true &&
    read('warm-phase-proof.json').coldConflictRequired === false &&
    read('warm-phase-proof.json').coldConflictObservedCount === 0,
  'PHASE_PROOF',
);
for (const a of race.attempts)
  demand(
    patch.records.filter(
      (r) =>
        r.requestId === a.clientRequestId &&
        r.status === a.observation.status &&
        r.exactLinked &&
        !r.integrationThrottled,
    ).length === 1,
    'PATCH_LINK',
  );
bindAudits(
  race.attempts,
  race.audit.filter((a) => a.result === 'SUCCESS').map((a) => ({ ...a, auditId: a.id })),
);
for (const a of race.attempts.filter((a) => a.observation.status === 409))
  demand(
    race.audit.filter(
      (b) => b.requestId === a.clientRequestId && b.result === 'FAILURE' && b.beforeVersion === a.ifMatch,
    ).length === 1,
    'FAILURE_AUDIT',
  );
for (const round of race.rounds)
  demand(
    round.beforeVersion === round.round &&
      round.readback.name === race.attempts.find((a) => a.round === round.round && a.observation.status === 200).name,
    'WINNER_READBACK',
  );
validateBusinessDatabaseReceipts(
  child,
  child.databaseBuilds.map((b) => read(b.receipt.split('/').at(-1))),
);
const sources = read('contract-race.json.sources.json');
const hashes = new Map(
  sources.sources.map((s) => {
    demand(digest(Buffer.from(s.sourceBase64, 'base64')) === s.sha256, 'SOURCE_BYTES');
    return [s.path, s.sha256];
  }),
);
for (const s of child.sources) demand(hashes.get(s.path) === s.sha256, 'EXECUTED_SOURCE_DRIFT');
const builds = parent.databaseBuilds.map((b) => {
  const r = read(b.receipt.split('/').at(-1));
  demand(
    r.gate === 'PASS' &&
      r.build.status === 'SUCCEEDED' &&
      r.build.id === b.buildId &&
      r.build.serviceRole === 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' &&
      r.result.prefix === child.prefix &&
      r.result.action === b.action &&
      r.result.sourceHash === hashes.get('scripts/qa09-ten-device-db.mjs'),
    'PARENT_BUILD_BINDING',
  );
  return r;
});
const initial = builds.find((b) => b.result.action === 'observe').result;
const cleaned = builds.find((b) => b.result.action === 'cleanup').result;
demand(
  JSON.stringify(initial.originalFingerprints) === JSON.stringify(cleaned.originalFingerprints),
  'OUTSIDE_DEVICE_CERT_DRIFT',
);
demand(cleaned.deleted.devices === 10, 'EXACT_DELETE_COUNT');
for (const k of [
  'certificates',
  'rotationRequests',
  'requests',
  'jobs',
  'receipts',
  'latest',
  'outbox',
  'telemetrySamples',
])
  demand(Array.isArray(cleaned[k]) && cleaned[k].length === 0, 'OWN_DATABASE_RESIDUE');
for (const c of [...child.cleanup, ...parent.cleanup]) demand(c.result === 'PASS', 'CLEANUP_FAILED');
for (const s of child.createdSites)
  demand(
    child.cleanup.some((c) => c.type === 'site' && c.id === s.id),
    'SITE_CLEANUP',
  );
for (const c of parent.customers)
  demand(
    parent.cleanup.some((x) => x.type === 'customer' && x.id === c.id),
    'CUSTOMER_CLEANUP',
  );
for (const i of child.createdIdentities)
  demand(
    child.cleanup.some((c) => c.type === 'cognito' && c.username === i.username && c.globalSignOut === 'PASS'),
    'CHILD_IDENTITY_CLEANUP',
  );
demand(
  parent.cleanup.some((c) => c.type === 'identity' && c.username === parent.identity.username),
  'ROOT_IDENTITY_CLEANUP',
);
const domain = read('contract-race.json.domain-cleanup.json'),
  wrapper = read('contract-race.json.gate.json');
demand(
  domain.gate === 'PASS' &&
    domain.observations.length === 2 &&
    domain.observations.every((o) => o.versionsRemaining === 0 && domain.prefixes.includes(o.prefix)) &&
    domain.parentReceiptSha256 === bindings['contract-race.json.fixtures.json'] &&
    wrapper.gate === 'PASS' &&
    wrapper.cleanup === 'PASS' &&
    wrapper.sourceReceiptSha256 === bindings['contract-race.json.sources.json'],
  'FINAL_CLEANUP_GATE',
);
const empty = read('database-empty-audit.json');
demand(
  empty.gate === 'PASS' &&
    empty.build.status === 'SUCCEEDED' &&
    empty.build.id === empty.result.buildId &&
    empty.build.serviceRole === 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' &&
    empty.result.action === 'audit-empty' &&
    empty.result.prefix === child.prefix &&
    empty.result.sourceHash === hashes.get('scripts/qa09-ten-device-db.mjs') &&
    empty.result.empty === true &&
    ['devices', 'certificates', 'onboardingRequests'].every((k) => empty.result[k].length === 0) &&
    JSON.stringify(empty.result.originalFingerprints) === JSON.stringify(initial.originalFingerprints),
  'POST_CLEANUP_EMPTY_PROOF',
);
const summary = {
  gate: 'PARTIAL',
  businessGate: 'PASS',
  accountPhaseGate: 'PASS',
  coldConflictGate: 'NOT_OBSERVED',
  strictColdPhaseCheck: 'COLD_CONFLICT_REQUIRED',
  scope: 'SAME_SHA_WARM_ACCOUNT_FIRST_DATABASE_AND_OWN_CLEANUP',
  sourceCommit: child.sourceCommit,
  prefix: child.prefix,
  finishedAt: parent.finishedAt,
  fullQa09Accepted: false,
  overallQa09Gate: 'PARTIAL',
  p95Accepted: false,
  performanceDiagnosis: 'WARM_PHASES_OBSERVED_COLD_CONFLICT_NOT_OBSERVED',
  businessChecks: child.checks.length,
  patchLinked: 6,
  auditGetLinked: 19,
  phaseRequests: 25,
  coldConflictObservedCount: phase.coldConflictObservedCount,
  cleanup: 'PASS',
  ownedDevicesCleaned: 10,
  ownedSitesCleaned: 2,
  ownedCustomersCleaned: 2,
  ownedIdentitiesCleaned: 5,
  originalDeviceCertificateFingerprintsUnchanged: true,
  outsideBusinessFingerprintsUnchanged: true,
  overlap: overlap(patch.records),
  historicalSibling: race.historical.clientSiblingReceipt,
  bindings,
};
writeFileSync(join(dir, 'target-summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
