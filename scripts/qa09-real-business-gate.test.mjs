import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSmoke } from './check-qa09-real-business-smoke.mjs';
const receipt = JSON.parse(
  readFileSync(new URL('../docs/audit/evidence/qa-09-real-business-smoke-2026-10-02.json', import.meta.url)),
);
const archive = JSON.parse(
  readFileSync(
    new URL('../docs/audit/evidence/qa-09-business-smoke-executed-sources-2026-10-02.json', import.meta.url),
  ),
);
test('real sub-scope acceptance cannot claim whole QA09', () =>
  assert.equal(validateSmoke(receipt, archive).fullQa09Accepted, false));
test('unfinished execution, missing role probe and failed assertion rejected', () => {
  for (const r of [
    { ...receipt, finishedAt: null },
    { ...receipt, startedAt: null },
    { ...receipt, checks: receipt.checks.slice(1) },
    { ...receipt, checks: [...receipt.checks, { id: 'failed', result: 'FAIL' }] },
  ])
    assert.throws(() => validateSmoke(r, archive));
});
test('missing cleanup, wrong target, secrets and source tampering rejected', () => {
  for (const r of [
    { ...receipt, cleanup: receipt.cleanup.slice(1) },
    { ...receipt, target: { ...receipt.target, accountId: '123456789012' } },
    { ...receipt, password: 'must-not-save' },
  ])
    assert.throws(() => validateSmoke(r, archive));
  const a = structuredClone(archive);
  a.sources[Object.keys(a.sources)[0]].base64 = 'broken';
  assert.throws(() => validateSmoke(receipt, a));
});
