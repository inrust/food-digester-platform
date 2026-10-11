import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateOwnedRuntimeMatrix } from './check-qa09-owned-summary.mjs';
const root = 'docs/audit/evidence/qa-09-owned-summary-2026-10-11/sealed-runtime-matrix';
const matrix = JSON.parse(readFileSync(root + '/matrix.json'));
const load = (name) => readFileSync(root + '/' + name);
test('schema2 fixed runtime matrix proves original ownership and degradation without target acceptance', () => {
  const r = validateOwnedRuntimeMatrix(matrix, load);
  assert.equal(r.gate, 'LOCAL_OWNED_SUMMARY_PASS');
  assert.equal(r.targetGate, 'NOT_RUN');
  assert.equal(r.counts.begin, 34);
  assert.equal(r.counts.release, 48);
  assert.equal(r.counts.network, 0);
  assert.equal(r.statuses.COMPLETE, 18);
  assert.ok(r.maxSummaryBytes <= 4096);
});
for (const [name, mutate] of Object.entries({
  target: (m) => (m.targetEquivalent = true),
  budget: (m) => (m.budget.poolMax = 2),
  missing: (m) => m.rows.pop(),
  path: (m) => (m.rows[0].receipt = '../other'),
  bytes: (m) => (m.rows[0].sha256 = 'bad'),
  design: (m) => (m.observationDesignDecision = 'COMPILER_INTERNAL'),
}))
  test('owned matrix refuses ' + name, () => {
    const m = structuredClone(matrix);
    mutate(m);
    assert.throws(() => validateOwnedRuntimeMatrix(m, load));
  });
test('historical schema1 cannot stand in for owned matrix even if its receipt hash is rebound', () => {
  const m = structuredClone(matrix),
    item = m.rows.find((r) => r.case === 'entry-output');
  const receipt = JSON.parse(load(item.receipt));
  receipt.samples[0].observations.find((r) => r.event === 'data-path.contract-load.observer-cost').schemaVersion = 1;
  const bytes = Buffer.from(JSON.stringify(receipt));
  item.sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.throws(() => validateOwnedRuntimeMatrix(m, (name) => (name === item.receipt ? bytes : load(name))));
});
