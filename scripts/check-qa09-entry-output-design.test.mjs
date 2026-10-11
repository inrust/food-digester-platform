import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDesignMatrix } from './check-qa09-entry-output-design.mjs';
import { entryOutputCases } from './qa09-contract-entry-output-proof.mjs';
const fixture = () => ({
  gate: 'PASS',
  scope: 'OFFLINE_PUBLIC_ENTRY_OUTPUT_OWNERSHIP',
  candidateDefaultsChanged: false,
  targetEquivalent: false,
  targetWiring: 'NOT_IMPLEMENTED',
  p95Accepted: false,
  fullQa09Accepted: false,
  budget: {
    childProcesses: 14,
    concurrency: 1,
    childDeadlineMs: 45000,
    poolMax: 1,
    networkRequests: 0,
    databaseServers: 0,
    targetFixtures: 0,
    inspectorSessions: 0,
    intervalRecordsPerRequestMax: 64,
    plannedSummaryBytesMax: 4096,
    plannedSummaryRecordsPerRequestMax: 1,
  },
  rows: entryOutputCases.map((name) => ({ case: name, receipt: name + '.json', sha256: 'a'.repeat(64) })),
});
for (const [name, mutate, code] of [
  [
    'deployed claim',
    (m) => {
      m.targetWiring = 'READY';
    },
    'DESIGN_MATRIX_SCOPE',
  ],
  [
    'missing case',
    (m) => {
      m.rows.pop();
    },
    'DESIGN_MATRIX_CASES',
  ],
  [
    'duplicate case',
    (m) => {
      m.rows[0].case = m.rows[1].case;
    },
    'DESIGN_MATRIX_CASES',
  ],
  [
    'widened record budget',
    (m) => {
      m.budget.intervalRecordsPerRequestMax = 65;
    },
    'DESIGN_MATRIX_BUDGET',
  ],
  [
    'new network request',
    (m) => {
      m.budget.networkRequests = 1;
    },
    'DESIGN_MATRIX_BUDGET',
  ],
  [
    'path traversal',
    (m) => {
      m.rows[0].receipt = '../credential';
    },
    'DESIGN_RECEIPT_PATH',
  ],
  ['changed bytes', () => {}, 'DESIGN_RECEIPT_HASH'],
])
  test(`design checker rejects ${name} before loading unbound input`, () => {
    const m = fixture();
    mutate(m);
    let reads = 0;
    assert.throws(
      () =>
        validateDesignMatrix(m, () => {
          reads++;
          return Buffer.from('{}');
        }),
      new RegExp(code),
    );
    assert.equal(reads, code === 'DESIGN_RECEIPT_HASH' ? 1 : 0);
  });
