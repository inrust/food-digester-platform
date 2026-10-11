import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateImplementationMatrix } from './check-qa09-observer-implementation.mjs';
const root = 'docs/audit/evidence/qa-09-observer-cost-implementation-2026-10-11/matrix-03';
const matrix = JSON.parse(readFileSync(root + '/matrix.json'));
const load = (name) => readFileSync(root + '/' + name);
test('implementation matrix replays bounded summaries and original business transaction ownership', () => {
  const r = validateImplementationMatrix(matrix, load);
  assert.equal(r.counts.begin, 34);
  assert.equal(r.counts.release, 48);
  assert.equal(r.statuses.COMPLETE, 18);
  assert.ok(r.maxSummaryBytes <= 4096);
});
for (const [name, mutate] of Object.entries({
  targetClaim: (m) => (m.targetEquivalent = true),
  caseOrder: (m) => m.rows.reverse(),
  extraCase: (m) => m.rows.push(m.rows[0]),
  pathEscape: (m) => (m.rows[0].receipt = '../outside'),
  hash: (m) => (m.rows[0].sha256 = 'bad'),
  replay: (m) => (m.rows[2].summary.summaries[0].status = 'OFF'),
  budget: (m) => (m.budget.intervalRecordsPerRequestMax = 65),
  capacity: (m) => (m.budget.poolMax = 2),
}))
  test('implementation seal rejects ' + name, () => {
    const m = structuredClone(matrix);
    mutate(m);
    assert.throws(() => validateImplementationMatrix(m, load));
  });
