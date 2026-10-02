import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRecovery } from './check-qa09-migration-recovery.mjs';
import { prepareRetirement } from './prepare-qa09-legacy-retirement.mjs';
import { validateRetirementReceipt } from './collect-qa09-legacy-retirement.mjs';
const retirement = JSON.parse(
  readFileSync(new URL('../docs/audit/evidence/qa-09-legacy-retirement-2026-10-02.json', import.meta.url)),
);
const preparation = JSON.parse(
  readFileSync(new URL('../docs/audit/evidence/qa-09-retirement-preparation-2026-10-02.json', import.meta.url)),
);
const upload = JSON.parse(
  readFileSync(new URL('../docs/audit/evidence/qa-09-migration-source-upload-2026-10-02.json', import.meta.url)),
);
const readback = JSON.parse(
  readFileSync(new URL('../docs/audit/evidence/qa-09-migration-source-readback-2026-10-02.json', import.meta.url)),
);
function fixture() {
  const fingerprints = structuredClone(retirement.result.preservedTables);
  delete fingerprints.onboarding_tokens;
  const db = {
    queryGate: 'PASS',
    migrationGate: 'PASS',
    schemaGate: 'PASS',
    build: { id: 'readonly-build' },
    manifest: { migrations: Array.from({ length: 40 }, () => ({})) },
    snapshot: {
      identity: { read_only: 'on' },
      migrationComparison: { status: 'PASS' },
      migrations: Array.from({ length: 40 }, () => ({ finished_at: '2026-10-02', rolled_back_at: null })),
      onboardingMigrationPrecheck: { status: 'PASS' },
      counts: { onboarding_requests: { count: '0' }, onboarding_provisioning_jobs: { count: '0' } },
      preservationFingerprints: fingerprints,
      certificateIdentityRows: structuredClone(retirement.result.certificateIdentityRows),
    },
  };
  const migration = {
    buildspecRoleAndSourceAddressUnchanged: true,
    build: {
      status: 'SUCCEEDED',
      sourceVersion: upload.upload.VersionId,
      expectedSourceCommit: upload.sourceCommit,
      id: 'migration-build',
    },
    result: {
      sourceCommit: upload.sourceCommit,
      buildId: 'migration-build',
      migrations: 'PASS',
      dictionarySeed: 'PASS',
      verification: { schema: 'PASS', migrationCount: 40 },
    },
  };
  return { db, migration };
}
test('recovery sub-gate checks all preserved tables without accepting full QA09', () => {
  const { db, migration } = fixture();
  const result = validateRecovery(retirement, db, migration, upload, readback);
  assert.equal(result.fullQa09Accepted, false);
  assert.equal(result.preservedTablesVerified, 53);
});
test('version mismatch, missing migration and changed certificate/other business data fail closed', () => {
  for (const kind of ['version', 'overrides', 'schema', 'certificates', 'preservation', 'tokens']) {
    const { db, migration } = fixture();
    if (kind === 'overrides') migration.buildspecRoleAndSourceAddressUnchanged = false;
    if (kind === 'version') migration.build.sourceVersion = 'wrong';
    if (kind === 'schema') db.migrationGate = 'BLOCKED';
    if (kind === 'certificates') db.snapshot.certificateIdentityRows.pop();
    if (kind === 'preservation') db.snapshot.preservationFingerprints.devices.digest = '0'.repeat(32);
    if (kind === 'tokens') db.snapshot.preservationFingerprints.onboarding_tokens = { count: '0' };
    assert.throws(() => validateRecovery(retirement, db, migration, upload, readback));
  }
});
test('retirement evidence cannot hide wrong deleted IDs or lose preservation proof', () => {
  validateRetirementReceipt(retirement.result, preparation, retirement.build.id);
  for (const result of [
    { ...retirement.result, deletedRequests: ['wrong'] },
    { ...retirement.result, executorSha256: '0'.repeat(64) },
    { ...retirement.result, preservedTables: {} },
  ])
    assert.throws(() => validateRetirementReceipt(result, preparation, retirement.build.id));
});
test('retirement project has fixed source and never modifies readonly/migration runner', () => {
  const p = prepareRetirement(preparation.approval);
  assert.equal(p.project.name, 'fdp-test-qa09-legacy-retirement');
  assert.deepEqual(Object.keys(p.request), ['projectName']);
  assert.equal(p.project.source.type, 'NO_SOURCE');
  assert.equal(p.project.autoRetryLimit, 0);
  assert.ok(!p.project.source.buildspec.includes('migrate deploy'));
  assert.throws(() => prepareRetirement({ ...preparation.approval, status: 'NOT_APPROVED' }));
});
