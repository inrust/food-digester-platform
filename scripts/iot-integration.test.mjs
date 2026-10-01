import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeIntegration } from './run-iot-integration.mjs';

const sample = JSON.parse(
  readFileSync(new URL('../docs/audit/evidence/qa-03-local-integration.json', import.meta.url), 'utf8'),
).scenarios;
test('QA03 Gate accepts complete local integration receipt', () => {
  assert.equal(summarizeIntegration(sample).receipts, 86);
});
for (const [name, mutate] of [
  ['missing scenario', (rows) => rows.pop()],
  [
    'unclean resources',
    (rows) => {
      rows[0].cleanup = 'FAIL';
    },
  ],
  [
    'reused isolation prefix',
    (rows) => {
      rows[1].prefix = rows[0].prefix;
    },
  ],
  [
    'lost message',
    (rows) => {
      rows[0].receipts--;
    },
  ],
  [
    'duplicate business record',
    (rows) => {
      rows[1].duplicateBusinessRows = 1;
    },
  ],
  [
    'missing raw proof',
    (rows) => {
      rows[0].rawHashChecks.pop();
    },
  ],
  [
    'missing fault probe',
    (rows) => {
      rows.find((r) => r.name === 'archive-faults').manifestRetry = false;
    },
  ],
])
  test(`QA03 Gate rejects ${name}`, () => {
    const rows = structuredClone(sample);
    mutate(rows);
    assert.throws(() => summarizeIntegration(rows));
  });
