import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertBusinessContext, validateTargetAssertions, ROLES } from './qa09-business-target.mjs';
import { validateBusinessVersion, validateBusinessDatabaseReceipts } from './check-qa09-business-target.mjs';
const [coreFile, auditFile, recoveryFile, output] = process.argv.slice(2),
  bindings = [];
const sha = (v) => createHash('sha256').update(v).digest('hex');
const read = (path) => {
  const bytes = readFileSync(path);
  bindings.push({ path, sha256: sha(bytes) });
  return JSON.parse(bytes);
};
const core = read(coreFile),
  parent = read(coreFile + '.fixtures.json'),
  sources = read(coreFile + '.sources.json'),
  audit = read(auditFile),
  recovery = read(recoveryFile);
assertBusinessContext(core);
const version = read(parent.versionReceipt);
validateBusinessVersion(version, core.sourceCommit);
for (const entry of sources.sources)
  if (sha(Buffer.from(entry.sourceBase64, 'base64')) !== entry.sha256) throw Error('SOURCE_BYTES_INVALID');
for (const entry of core.sources)
  if (
    sources.sources.find((s) => s.path === entry.path)?.sha256 !== entry.sha256 ||
    sha(Buffer.from(entry.sourceBase64, 'base64')) !== entry.sha256
  )
    throw Error('CORE_SOURCE_NOT_BOUND');
const originalAudit = read(audit.recoveredFrom),
  prep = read(audit.recoveredFrom + '.preparation.json');
if (
  audit.gate !== 'PASS' ||
  audit.writes !== 0 ||
  audit.recoveredFromSha256 !== bindings.find((b) => b.path === audit.recoveredFrom).sha256 ||
  audit.preparationSha256 !== bindings.find((b) => b.path === audit.recoveredFrom + '.preparation.json').sha256 ||
  audit.build.id !== originalAudit.build.id ||
  audit.build.serviceRole !== prep.project.serviceRole ||
  JSON.stringify(audit.build.vpcConfig) !== JSON.stringify(prep.project.vpcConfig) ||
  audit.sourceHash !== core.sourceHashes['scripts/qa09-ten-device-db.mjs']
)
  throw Error('AUDIT_RECOVERY_NOT_BOUND');
const ledger = [...core.databaseBuilds, { action: 'business-audit', receipt: auditFile, buildId: audit.build.id }];
validateBusinessDatabaseReceipts(
  { ...core, databaseBuilds: ledger },
  ledger.map((b) => read(b.receipt)),
);
for (const b of parent.databaseBuilds) {
  const proof = read(b.receipt);
  if (
    proof.gate !== 'PASS' ||
    proof.build.status !== 'SUCCEEDED' ||
    proof.build.id !== b.buildId ||
    proof.result.prefix !== core.prefix ||
    proof.sourceHash !== core.sourceHashes['scripts/qa09-ten-device-db.mjs'] ||
    proof.result.sourceHash !== proof.sourceHash ||
    proof.build.serviceRole !== 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role'
  )
    throw Error('PHYSICAL_FIXTURE_BUILD_NOT_BOUND');
}
const seed = read(parent.databaseBuilds.find((b) => b.action === 'business-seed-devices').receipt),
  physical = read(parent.databaseBuilds.find((b) => b.action === 'cleanup').receipt);
if (
  physical.result.deleted.devices !== 10 ||
  JSON.stringify(seed.result.originalFingerprints) !== JSON.stringify(physical.result.originalFingerprints) ||
  parent.cleanup.some((c) => c.result !== 'PASS') ||
  !parent.finishedAt ||
  parent.fixtureMode !== 'REAL_RDS_ONBOARDED_STATE_FOR_BUSINESS_APIS_NO_DEVICE_AUTH_CLAIM'
)
  throw Error('PHYSICAL_FIXTURE_CLEANUP_MISSING');
const originalDomain = read(coreFile + '.domain-cleanup.json');
const expectedDomainPrefixes = parent.customers.map((c) => `domain/entity_type=license/customer_id=${c.id}/`);
if (
  originalDomain.gate !== 'PASS' ||
  originalDomain.parentReceiptSha256 !== bindings.find((b) => b.path === coreFile + '.fixtures.json').sha256 ||
  originalDomain.bucket !== 'fdp-test-raw-065986019555' ||
  JSON.stringify(originalDomain.prefixes) !== JSON.stringify(expectedDomainPrefixes) ||
  originalDomain.observations.some((o) => o.versionsRemaining !== 0)
)
  throw Error('ORIGINAL_DOMAIN_CLEANUP_NOT_BOUND');
const domain = read(recovery.domainCleanupReceipt);
if (
  recovery.gate !== 'PASS' ||
  !recovery.finishedAt ||
  recovery.prefix !== core.prefix ||
  recovery.coreReceiptSha256 !== bindings.find((b) => b.path === coreFile).sha256 ||
  recovery.parentReceiptSha256 !== bindings.find((b) => b.path === coreFile + '.fixtures.json').sha256 ||
  recovery.auditReceiptSha256 !== bindings.find((b) => b.path === auditFile).sha256 ||
  recovery.checks.some((c) => c.result !== 'PASS') ||
  recovery.cleanup.some((c) => c.result !== 'PASS') ||
  recovery.globalSignOut !== 'PASS' ||
  domain.gate !== 'PASS' ||
  domain.bucket !== 'fdp-test-raw-065986019555' ||
  JSON.stringify(domain.prefixes) !== JSON.stringify(expectedDomainPrefixes) ||
  domain.parentReceiptSha256 !== bindings.find((b) => b.path === recoveryFile).sha256 ||
  domain.observations.length !== 2 ||
  domain.observations.some((o) => o.versionsRemaining !== 0)
)
  throw Error('ALTERNATIVE_CLEANUP_NOT_BOUND');
for (const [i, s] of core.createdSites.entries())
  if (
    !recovery.cleanup.some((c) => c.type === 'site' && c.id === s.id) ||
    !recovery.checks.some((c) => c.id === 'site-absent-' + i && c.status === 404)
  )
    throw Error('OWN_SITE_CLEANUP_MISSING');
for (const c of parent.customers)
  if (!recovery.checks.some((check) => check.id === 'customer-still-absent-' + c.suffix && check.status === 404))
    throw Error('OWN_CUSTOMER_CLEANUP_MISSING');
for (const own of [...core.createdIdentities, { username: parent.identity.username }])
  if (!recovery.checks.some((c) => c.id === 'identity-absent-' + own.username))
    throw Error('OWN_IDENTITY_ABSENCE_MISSING');
if (!recovery.checks.some((c) => c.id === 'recovery-identity-absent')) throw Error('RECOVERY_IDENTITY_ABSENCE_MISSING');
for (const role of ROLES) {
  const own = core.checks.find((c) => c.id === role + ':device-scope:0'),
    cross = core.checks.find((c) => c.id === role + ':device-scope:1');
  if (own?.status !== 200 || cross?.status !== (role.startsWith('Customer') ? 403 : 200))
    throw Error('FIVE_ROLE_DEVICE_SCOPE_MISSING');
}
const assertions = validateTargetAssertions(core, 'core', [
  'core-workflows-complete',
  'contract-if-match-race',
  'license-state-sequence-proved',
  'license-renew-replay',
  'license-reactivate-renewed',
  'config-publish',
  'device-user-disable',
  'device-user-cross-tenant-no-side-effects',
  'consumable-complete',
  'consumable-cancel',
  'alarm-clear',
]);
const validatorSources = [
  'scripts/check-qa09-core-recovered-target.mjs',
  'scripts/qa09-business-target.mjs',
  'scripts/check-qa09-business-target.mjs',
].map((path) => {
  const b = readFileSync(path);
  return { path, sha256: sha(b), sourceBase64: b.toString('base64') };
});
const r = {
  task: 'QA-09',
  scope: 'CORE_BUSINESS_FIVE_ROLE_SUBSET_RECOVERED_CLEANUP',
  collectedAt: new Date().toISOString(),
  sourceCommit: core.sourceCommit,
  prefix: core.prefix,
  gate: 'PASS',
  assertionsGate: assertions.assertionsGate,
  checks: assertions.checks,
  fullQa09Accepted: false,
  originalExecutorGate: core.gate,
  originalCleanupComplete: core.cleanupComplete,
  cleanupRecovered: true,
  recoveredAuditReceipt: auditFile,
  recoveredCleanupReceipt: recoveryFile,
  licenseDomainVersionsDeleted: originalDomain.deleted.length + domain.deleted.length,
  fixtureMode: parent.fixtureMode,
  sourceReceipt: coreFile + '.sources.json',
  sourceReceiptSha256: bindings.find((b) => b.path === coreFile + '.sources.json').sha256,
  bindings,
  validatorSources,
  remainingCoverage: [
    'Full QA04 Suspend/Reactivate/Retire/Command and post-configuration Sync',
    'All-verb five-role permission matrix',
    'Full browser/prototype/security/load/reliability Gates',
  ],
};
writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
console.log(JSON.stringify({ gate: r.gate, checks: r.checks, cleanupRecovered: true, fullQa09Accepted: false }));
