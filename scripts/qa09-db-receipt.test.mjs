import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSnapshot } from './collect-qa09-db-readonly.mjs';
const receipt = JSON.parse(
  readFileSync(new URL('../docs/audit/evidence/qa-09-db-readonly-2026-10-02.json', import.meta.url)),
);
const preparation = JSON.parse(
  readFileSync(new URL('../docs/audit/evidence/qa-09-db-runner-preparation-2026-10-02.json', import.meta.url)),
);
test('query success preserves real migration BLOCKED instead of promoting readiness', () =>
  assert.equal(
    validateSnapshot(receipt.snapshot, preparation, receipt.snapshot.buildId).migrationComparison.status,
    'BLOCKED',
  ));
test('wrong build, writable transaction, unbound hash and fabricated migration PASS rejected', () => {
  for (const r of [
    { ...receipt.snapshot, identity: { database: 'fdp', read_only: 'off' } },
    { ...receipt.snapshot, probeSha256: '0'.repeat(64) },
    { ...receipt.snapshot, migrationComparison: { status: 'PASS' } },
  ])
    assert.throws(() => validateSnapshot(r, preparation, receipt.snapshot.buildId));
  assert.throws(() => validateSnapshot(receipt.snapshot, preparation, 'fdp-test-migration-runner:wrong'));
});
test('missing table count cannot become complete SQL evidence', () => {
  const r = structuredClone(receipt.snapshot);
  delete r.counts.users;
  assert.throws(() => validateSnapshot(r, preparation, r.buildId));
});
