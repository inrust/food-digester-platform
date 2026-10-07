import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchedColdInputs, validateMatchedColdPair, readMatchedColdUnit } from './qa09-matched-cold-inputs.mjs';
const pair = () => {
  const inputs = matchedColdInputs('a'.repeat(40));
  const unit = {
    source: 'TARGET_RECEIPT',
    provenanceGate: 'PASS',
    cleanupGate: 'PASS',
    phaseGate: 'PASS',
    connectionBudgetGate: 'PASS',
    lambdaCount: 19,
    artifactSetSha256: 'b'.repeat(64),
    naturalCold409Count: 1,
    platformInitDurationMs: 400,
    coldProofGate: 'PASS',
    clientSplitGate: 'PASS',
    firstCheckoutOwned: true,
  };
  return [
    {
      ...inputs.r0,
      ...unit,
      prefix: 'r0',
      runId: '1',
      startedAt: '2026-10-07T00:00:00Z',
      closedAt: '2026-10-07T00:10:00Z',
    },
    {
      ...inputs.r1,
      ...unit,
      prefix: 'r1',
      runId: '2',
      startedAt: '2026-10-07T00:20:00Z',
      closedAt: '2026-10-07T00:30:00Z',
    },
  ];
};
test('planner never dispatches and matchable inputs never accept P95 or causal benefit', () => {
  const p = matchedColdInputs('a'.repeat(40));
  assert.equal(p.gate, 'PREPARED_OFFLINE_TARGET_NOT_RUN');
  const result = validateMatchedColdPair(...pair());
  assert.equal(result.gate, 'INPUT_COMPATIBLE');
  assert.equal(result.p95Accepted, false);
  assert.equal(result.causalBenefit, 'NOT_ESTABLISHED');
  assert.throws(() => matchedColdInputs('abc'));
});
for (const [key, value] of [
  ['sourceCommit', 'c'.repeat(40)],
  ['memoryMiB', 1024],
  ['poolMax', 2],
  ['actorRole', 'Auditor'],
  ['accountState', 'INVITED'],
  ['operationId', 'auditList'],
  ['expectedStatus', 200],
  ['authenticatedPreconnect', false],
  ['engineCpuDiagnosis', false],
  ['artifactSetSha256', 'c'.repeat(64)],
  ['lambdaCount', 18],
  ['cleanupGate', 'FAIL'],
  ['source', 'CONTROLLED_TEST_ONLY'],
  ['naturalCold409Count', 0],
  ['platformInitDurationMs', 0],
  ['clientSplitGate', 'NOT_RUN'],
  ['firstCheckoutOwned', false],
  ['startedAt', '2026-10-07T00:05:00Z'],
])
  test(`pair rejects drift or missing proof ${key}`, () => {
    const [a, b] = pair();
    b[key] = value;
    assert.throws(() => validateMatchedColdPair(a, b));
  });

test('actual receipt loader rejects byte drift and directory escape before reading semantic proof', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa09-matched-'));
  try {
    const file = join(root, 'version.json'),
      manifest = join(root, 'manifest.json');
    writeFileSync(file, '{}');
    writeFileSync(
      manifest,
      JSON.stringify({ receipts: { version: { path: 'version.json', sha256: 'f'.repeat(64) } } }),
    );
    assert.throws(() => readMatchedColdUnit(manifest), /BYTE_DRIFT/);
    const nested = join(root, 'nested');
    mkdirSync(nested);
    const escaped = join(nested, 'manifest.json');
    writeFileSync(
      escaped,
      JSON.stringify({
        receipts: { version: { path: '../version.json', sha256: createHash('sha256').update('{}').digest('hex') } },
      }),
    );
    assert.throws(() => readMatchedColdUnit(escaped), /PATH_ESCAPE/);
    const missing = join(root, 'missing-manifest.json');
    writeFileSync(missing, '{}');
    assert.throws(() => readMatchedColdUnit(missing), /REFERENCE_REQUIRED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
