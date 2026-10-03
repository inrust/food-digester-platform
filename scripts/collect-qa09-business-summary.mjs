import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateTargetStage, validateTargetAssertions, ROLES } from './qa09-business-target.mjs';
import { validateBusinessVersion, validateBusinessDatabaseReceipts } from './check-qa09-business-target.mjs';
const [output, coreFile, versionFile, recoveredGateFile] = process.argv.slice(2);
if (!output || !coreFile) throw Error('SUMMARY_AND_CORE_RECEIPT_REQUIRED');
const base = 'docs/audit/evidence/';
const hash = (v) => createHash('sha256').update(v).digest('hex'),
  bindings = [];
const read = (path) => {
  const bytes = readFileSync(path);
  bindings.push({ path, sha256: hash(bytes) });
  return JSON.parse(bytes);
};
const business = read(base + 'qa-09-business-target-attempt2-2026-10-03.json');
const original = read(base + 'qa-09-business-target-attempt2-2026-10-03.json.devices.json');
const source = read(base + 'qa-09-business-target-attempt2-2026-10-03.json.sources.json');
for (const entry of source.sources)
  if (hash(Buffer.from(entry.sourceBase64, 'base64')) !== entry.sha256) throw Error('SOURCE_BYTES_INVALID');
for (const [path, digest] of Object.entries(business.sourceHashes)) {
  const entry = source.sources.find((s) => s.path === path) ?? business.sources.find((s) => s.path === path);
  if (!entry || entry.sha256 !== digest || hash(Buffer.from(entry.sourceBase64, 'base64')) !== digest)
    throw Error('BUSINESS_SOURCE_NOT_BOUND');
}
const db = business.databaseBuilds.map((d) => read(d.receipt));
validateBusinessDatabaseReceipts(business, db);
const version = read(versionFile ?? base + 'qa-09-core-workflows-application-version-2026-10-03.json');
validateBusinessVersion(version, business.sourceCommit);
const recovery = read(base + 'qa-09-business-target-attempt2-cleanup-recovery-2026-10-03.json');
const recoverySources = read(base + 'qa-09-business-cleanup-recovery-executed-sources-2026-10-03.json');
if (
  recoverySources.gate !== 'PASS' ||
  recoverySources.originalReceiptSha256 !== bindings.find((b) => b.path === recoverySources.originalReceipt)?.sha256
)
  throw Error('HISTORICAL_RECOVERY_SOURCE_RECEIPT_NOT_BOUND');
for (const [path, digest] of Object.entries(recovery.sourceHashes)) {
  const entry = recoverySources.sources.find((s) => s.path === path);
  if (!entry || entry.sha256 !== digest || hash(Buffer.from(entry.sourceBase64, 'base64')) !== digest)
    throw Error('HISTORICAL_RECOVERY_SOURCE_BYTES_MISSING');
}
const domain = read(recovery.domainCleanupReceipt);
const cloud = read(base + 'qa-09-business-target-attempt2-cloud-cleanup-verification-2026-10-03.json');
if (
  recovery.prefix !== original.prefix ||
  business.prefix !== original.prefix ||
  recovery.gate !== 'PASS' ||
  !recovery.finishedAt ||
  recovery.cleanup.some((c) => c.result !== 'PASS') ||
  !recovery.cleanup.some((c) => c.type === 'database-fixtures' && c.count === 10) ||
  domain.gate !== 'PASS' ||
  domain.parentReceiptSha256 !== bindings.find((b) => b.path === domain.parentReceipt)?.sha256 ||
  domain.observations.length !== 2 ||
  domain.observations.some((o) => o.versionsRemaining !== 0) ||
  cloud.gate !== 'PASS' ||
  cloud.checks.length !== 20 ||
  cloud.checks.some((c) => c.result !== 'PASS') ||
  cloud.parentReceiptSha256 !== domain.parentReceiptSha256
)
  throw Error('RECOVERY_CLEANUP_NOT_BOUND');
for (const entry of recovery.databaseBuilds) {
  const proof = read(entry.receipt);
  if (
    proof.gate !== 'PASS' ||
    proof.build.status !== 'SUCCEEDED' ||
    proof.build.id !== entry.buildId ||
    proof.build.serviceRole !== 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' ||
    proof.result.prefix !== original.prefix ||
    proof.result.action !== entry.action ||
    proof.result.sourceHash !== recovery.sourceHashes['scripts/qa09-ten-device-db.mjs']
  )
    throw Error('RECOVERY_DB_NOT_BOUND');
  if (entry.action === 'cleanup' && proof.result.deleted.devices !== 10) throw Error('RECOVERY_DEVICE_DELETE_MISSING');
}
if (original.sourceCommit !== business.sourceCommit || cloud.prefix !== recovery.prefix)
  throw Error('APPLICATION_OR_CLEANUP_SCOPE_DRIFT');
for (const role of ROLES) {
  const reads = business.checks.filter((c) => c.id.startsWith(role + ':read:'));
  if (reads.length !== 18 || reads.some((c) => c.result !== 'PASS')) throw Error('DOMAIN_READ_MATRIX_MISSING');
}
const scopes = {};
for (const id of [
  'dedicated-real-srp',
  'ten-concurrent-independent-mqtt-sessions',
  'first-heartbeat-completes-ten-onboardings',
  'rest-no-client-certificate-denied',
  'rest-untrusted-client-certificate-denied',
  'aws-cross-device-subscription-denied',
  'aws-cross-device-publish-denied',
  'all-twenty-telemetry-archived',
])
  if (!original.checks.some((c) => c.id === id && c.result === 'PASS')) throw Error('DEVICE_BASELINE_MISSING');
const keys = original.checks.find((c) => c.id === 'ten-concurrent-independent-mqtt-sessions').keyFingerprints;
const archive = read(base + 'qa-09-business-target-attempt2-2026-10-03.json.devices.json.archive-read.json');
if (
  keys?.length !== 10 ||
  new Set(keys).size !== 10 ||
  archive.gate !== 'PASS' ||
  archive.result.archivedMessages !== 20 ||
  archive.prefix !== original.prefix ||
  original.executorSha256 !==
    source.sources.find((s) => s.path === 'scripts/run-qa09-ten-device-acceptance.mjs')?.sha256
)
  throw Error('DEVICE_KEYS_ARCHIVE_OR_EXECUTOR_NOT_BOUND');
scopes.iotBaseline = {
  gate: 'PASS',
  scope: 'TEN_REAL_CSR_MTLS_IOT_BASELINE_ONLY',
  originalParentGate: original.gate,
  cleanupRecovered: true,
  archivedTelemetry: 20,
};
for (const [stage, required] of Object.entries({
  recovery: ['own-export-lease-expired', 'expired-processing-lease-recovered', 'esg-export-csv-count'],
  security: [
    'invalid-writes-no-business-effects',
    'audit-no-credential-leak',
    'invite-password-rejected',
    'security-required-probes-complete',
  ],
  browser: ['browser-site-edit-persisted', 'browser-required-probes-complete'],
}))
  scopes[stage] = validateTargetStage(business, stage, required);
for (const role of ROLES)
  if (!business.checks.some((c) => c.id === role + ':browser-srp-login' && c.result === 'PASS'))
    throw Error('REAL_BROWSER_LOGIN_MISSING');
const core = read(coreFile),
  coreGate = read(recoveredGateFile ?? coreFile + '.gate.json'),
  fixtures = read(coreFile + '.fixtures.json');
const coreSources = read(coreFile + '.sources.json');
for (const entry of coreSources.sources)
  if (hash(Buffer.from(entry.sourceBase64, 'base64')) !== entry.sha256) throw Error('CORE_SOURCE_BYTES_INVALID');
if (
  coreGate.gate !== 'PASS' ||
  (!coreGate.cleanupRecovered && fixtures.gate !== 'PASS') ||
  coreGate.sourceCommit !== version.sourceCommit ||
  core.prefix !== fixtures.prefix ||
  coreGate.prefix !== core.prefix ||
  coreGate.fullQa09Accepted !== false ||
  coreGate.sourceReceiptSha256 !== bindings.find((b) => b.path === coreFile + '.sources.json').sha256
)
  throw Error('CORE_GATE_NOT_BOUND');
const coreLedger = [...core.databaseBuilds];
if (coreGate.cleanupRecovered) {
  if (!recoveredGateFile || coreGate.scope !== 'CORE_BUSINESS_FIVE_ROLE_SUBSET_RECOVERED_CLEANUP')
    throw Error('EXPLICIT_RECOVERED_GATE_REQUIRED');
  for (const binding of coreGate.bindings) {
    if (
      !binding.path.startsWith(base + 'qa-09-') ||
      binding.path.includes('..') ||
      hash(readFileSync(binding.path)) !== binding.sha256
    )
      throw Error('RECOVERED_GATE_INPUT_CHANGED');
  }
  const recoveredAudit = read(coreGate.recoveredAuditReceipt);
  coreLedger.push({
    action: 'business-audit',
    receipt: coreGate.recoveredAuditReceipt,
    buildId: recoveredAudit.build.id,
  });
}
validateBusinessDatabaseReceipts(
  { ...core, databaseBuilds: coreLedger },
  coreLedger.map((d) => read(d.receipt)),
);
const coreRequired = [
  'core-workflows-complete',
  'contract-if-match-race',
  'license-state-sequence-proved',
  'license-renew-replay',
  'config-publish',
  'device-user-disable',
  'device-user-cross-tenant-no-side-effects',
  'consumable-complete',
  'consumable-cancel',
  'alarm-clear',
];
scopes.core = coreGate.cleanupRecovered
  ? {
      ...validateTargetAssertions(core, 'core', coreRequired),
      gate: 'PASS',
      cleanupRecovered: true,
      scope: 'VERIFIED_SUBSET_NOT_FULL_QA04',
    }
  : validateTargetStage(core, 'core', coreRequired);
for (const role of ROLES) {
  const own = core.checks.find((c) => c.id === role + ':device-scope:0'),
    cross = core.checks.find((c) => c.id === role + ':device-scope:1');
  if (own?.status !== 200 || cross?.status !== (role.startsWith('Customer') ? 403 : 200))
    throw Error('FIVE_ROLE_SCOPE_MISSING');
}
const mqtt = read(base + 'qa-09-business-attempt2-mqtt-window-diagnostic-2026-10-03.json');
const observation = read(mqtt.sourceReceipt);
if (
  observation.gate !== 'PASS' ||
  observation.result.prefix !== original.prefix ||
  observation.build.id !== mqtt.sourceBuildId ||
  observation.build.status !== 'SUCCEEDED' ||
  observation.result.receipts.length !== 950 ||
  observation.result.receipts.some((c) => c.result !== 'PROCESSED') ||
  observation.result.telemetrySamples.length !== 10 ||
  observation.result.telemetrySamples.some((c) => c.samples !== '92')
)
  throw Error('MQTT_DIAGNOSTIC_NOT_BOUND');
const http = business.checks.filter((c) => c.stage === 'httpLoad');
const httpFailures = http.filter((c) => c.status === 500);
if (http.length !== 10 || httpFailures.length !== 2 || http.filter((c) => c.status === 200).length !== 8)
  throw Error('HTTP_FAILURE_PROOF_MISSING');
scopes.httpLoad = {
  gate: 'FAIL',
  proof: business.httpLoadFailure,
  attemptedRequests: http.length,
  http500: httpFailures.length,
  requestIds: httpFailures.map((c) => c.requestId),
  retryUsedToMaskFailure: false,
};
scopes.mqttLoad = {
  gate: 'FAIL',
  actualBurstSpanSeconds: mqtt.burst.publishStartSpanSeconds,
  plannedBurstSeconds: 10,
  uniqueProcessedReceipts: 950,
  samplesPerDevice: 92,
  publisherToAdditionalArchiveProof: 'MISSING',
  dbProcessedP95Ms: mqtt.normal.dbProcessedP95Ms,
  telemetryApiVisibilitySlo: 'NOT_MEASURED',
  commandPublishSlo: 'NOT_MEASURED',
  fullProfileExecuted: false,
};
const formal = read(base + 'qa-09-business-formal-gates-2026-10-03.json');
if (formal.checks.length !== 8 || formal.checks.some((c) => c.status !== 'NOT_RUN_NO_RECEIPT' || c.exitCode !== 1))
  throw Error('FORMAL_GATES_MISMATCH');
const local = read(base + 'qa-09-business-local-regression-2026-10-03.json');
const r = {
  task: 'QA-09',
  scope: 'ACTUAL_VERIFIED_SUBSCOPES_AND_FAILURES',
  collectedAt: new Date().toISOString(),
  sourceCommit: version.sourceCommit,
  gate: 'PARTIAL',
  fullQa09Accepted: false,
  stages: scopes,
  cleanup: {
    gate: 'PASS',
    originalFailedCleanupPreserved: true,
    recoveryPrefix: original.prefix,
    independentCloudAbsenceChecks: 20,
    domainVersionsDeleted: domain.deleted.length,
    corePrefix: core.prefix,
    coreCleanupRecovered: !!coreGate.cleanupRecovered,
    coreLicenseDomainVersionsDeleted: coreGate.licenseDomainVersionsDeleted ?? null,
  },
  formalTargetGates: 'NOT_RUN_NO_RECEIPT',
  localRegression: local.gate,
  collectorSourceHash: hash(readFileSync(new URL(import.meta.url))),
  collectorSourceBase64: readFileSync(new URL(import.meta.url)).toString('base64'),
  bindings,
  nextExecutableTask:
    'Read-only correlation of HTTP500 and Lambda concurrency; prepare capacity remediation and target SLO rerun plan before deployment',
  remainingCoverage: [
    ...core.remainingCoverage,
    ...(coreGate.remainingCoverage ?? []),
    'Own queue redelivery and complete reliability scenarios',
  ],
};
writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
console.log(
  JSON.stringify({
    gate: r.gate,
    stages: Object.fromEntries(Object.entries(scopes).map(([k, v]) => [k, v.gate])),
    fullQa09Accepted: false,
  }),
);
process.exitCode = 2;
