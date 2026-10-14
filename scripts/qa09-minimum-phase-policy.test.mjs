import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildMinimumPhaseScope,
  validateMinimumPhaseScope,
  validateMinimumPhaseFacts,
  validateMinimumDomainReceipt,
  summarizeMinimumPhase,
  MINIMUM_DOMAINS,
  MINIMUM_LIMITS,
  digest,
} from './qa09-minimum-phase-policy.mjs';
const original = JSON.parse(readFileSync('docs/audit/evidence/qa-09-a1-entry-2026-10-13/scope.json'));
const scope = buildMinimumPhaseScope(original, 'a'.repeat(64));
const facts = {
  currentApplication: 'PASS_BOUND_CURRENT_DEPLOYMENT_AND_CONFIG',
  rotation: 'PASS_REAL_DUAL_CHANNEL_ROTATION',
  a5: [
    'replay.operatorNonempty',
    'replay.uniqueProducerAssociation',
    'reliability.sameRunNonemptyDedup',
    'reliability.archivePartialFailure',
    'reliability.queueAndScheduleAssociation',
  ],
  userState: 'PASS_FIVE_SIGNED_ROLES_STATE_AUDIT_AND_CLEANUP',
  authorization: { invalidBranches: 378, forgedSignatures: 6, currentRoles: 5, trustedInvalidClaimsAccepted: false },
  persistence: { retained: 76, deferredA2: 33, deferredMaterials: 3, notProven: 0 },
  semantics: { retained: 100, deferredA2: 15, deferredMaterials: 2, notProven: 0 },
  browser: {
    originalPass: 87,
    originalFail: 1,
    finalLayoutRecheck: 'PASS',
    changedViewerRead: 'PASS',
    realLogins: 5,
    retainedWorkflowFamilies: [
      'alias-write-readback',
      'contract-create-bind',
      'consumable-process-complete',
      'device-user-create-update',
      'nonempty-csv-export',
    ],
    originalFailurePreserved: true,
  },
  data: {
    naturalConsistency: 'PASS_RETAINED_REAL_DATABASE_CSV_ARCHIVE',
    leaseRecovery: 'PASS_NATURAL_NONEMPTY_EQUAL_CSV',
  },
  cleanup: {
    current: 'PASS_INDEPENDENT_EMPTY_IDENTITY_ABSENCE_AND_OUTSIDE_BASELINE',
    unknownExecution: 'UNKNOWN',
    unknownContainment: 'PASS',
    originalFailuresPreserved: true,
  },
  permissionsChanged: false,
  fullSuiteRepeated: false,
  fullQa09Accepted: false,
  productionReady: false,
};
const binding = {
  scopeSha256: 'a'.repeat(64),
  applicationCommit: 'b'.repeat(40),
  executorSnapshotSha256: 'c'.repeat(64),
  documentationSnapshotSha256: 'd'.repeat(64),
  evidenceBundleSha256: 'e'.repeat(64),
};
function receipts() {
  return Object.entries(MINIMUM_DOMAINS).map(([domain, required]) => ({
    schemaVersion: '2.0',
    kind: 'QA09_FORMAL_MINIMUM_DOMAIN_RECEIPT',
    domain,
    status: 'PASS_MINIMUM_SCOPE',
    ...binding,
    factsSha256: digest(JSON.stringify(facts)),
    required,
    accepted: required,
    scopeLimit: MINIMUM_LIMITS[domain],
    releaseDeferrals: scope.requirements.filter((r) => r.disposition.startsWith('DEFERRED')).map((r) => r.id),
    materialDependencyDeferrals: scope.materialDeferrals,
    fullOriginalDomainAccepted: false,
    fullQa09Accepted: false,
    productionReady: false,
  }));
}
test('explicit three-material authorization changes the phase without waiving retained cleanup or business proofs', () => {
  validateMinimumPhaseScope(scope, original, 'a'.repeat(64));
  assert.equal(scope.requirements.filter((r) => r.disposition === 'RETAINED_REQUIRED').length, 14);
  for (const change of [
    (s) => {
      s.authorization = 'INFERRED';
    },
    (s) => {
      s.requirements.find((r) => r.id === 'cleanup.ownedResourcesAndUnknownWrites').disposition =
        'DEFERRED_TO_PRE_RELEASE_NOT_ACCEPTED';
    },
    (s) => {
      s.materialDeferrals['REL-MATERIAL-NOTIFY-01'].operations.push('createContract');
    },
    (s) => {
      s.materialDeferrals['REL-MATERIAL-SETTING-01'].releaseRequired = false;
    },
  ]) {
    const s = structuredClone(scope);
    change(s);
    assert.throws(() => validateMinimumPhaseScope(s, original, 'a'.repeat(64)));
  }
});
test('HTTP coverage and missing independent proof cannot pass after materials are deferred', () => {
  for (const change of [
    (f) => {
      f.rotation = 'HTTP_ONLY';
    },
    (f) => {
      f.a5.pop();
    },
    (f) => {
      f.persistence.retained = 75;
      f.persistence.notProven = 1;
    },
    (f) => {
      f.browser.finalLayoutRecheck = 'NOT_RUN';
    },
    (f) => {
      f.cleanup.unknownContainment = 'NOT_PROVEN';
    },
    (f) => {
      f.authorization.trustedInvalidClaimsAccepted = true;
    },
  ]) {
    const f = structuredClone(facts);
    change(f);
    assert.throws(() => validateMinimumPhaseFacts(f));
  }
});
test('formal minimum receipts require every scoped domain and its exact evidence/version bindings', () => {
  const r = receipts();
  const result = summarizeMinimumPhase(r, scope, facts, binding);
  assert.equal(result.minimumPhaseAccepted, true);
  assert.equal(result.fullQa09Accepted, false);
  assert.equal(result.productionReady, false);
  assert.throws(() => summarizeMinimumPhase(r.slice(1), scope, facts, binding));
  assert.throws(() => summarizeMinimumPhase([...r.slice(1), r[1]], scope, facts, binding));
  for (const delta of [
    { accepted: [] },
    { scopeSha256: 'f'.repeat(64) },
    { executorSnapshotSha256: 'f'.repeat(64) },
    { documentationSnapshotSha256: 'f'.repeat(64) },
    { evidenceBundleSha256: 'f'.repeat(64) },
    { factsSha256: 'f'.repeat(64) },
    { releaseDeferrals: [] },
    { materialDependencyDeferrals: {} },
  ])
    assert.throws(() => validateMinimumDomainReceipt({ ...r[0], ...delta }, scope, facts, binding));
});
test('minimum acceptance preserves historical UNKNOWN and cannot promote original full gates or release readiness', () => {
  const r = receipts()[0];
  for (const delta of [
    { status: 'PASS' },
    { fullOriginalDomainAccepted: true },
    { fullQa09Accepted: true },
    { productionReady: true },
  ])
    assert.throws(() => validateMinimumDomainReceipt({ ...r, ...delta }, scope, facts, binding));
  const f = structuredClone(facts);
  f.cleanup.unknownExecution = 'PASS';
  assert.throws(() => validateMinimumPhaseFacts(f));
});
