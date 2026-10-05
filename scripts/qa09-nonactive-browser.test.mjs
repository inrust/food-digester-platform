import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { semanticSummary, validateOwnCsv } from './qa09-nonactive-browser.mjs';
import { GROUPS, ABSENCE, VIEWPORTS } from './qa08-bindings.mjs';
const matrix = JSON.parse(readFileSync('contracts/prototype-traceability.yaml'));
const all = [...Object.keys(GROUPS), ...Object.keys(ABSENCE).map((id) => 'absence:' + id)].flatMap((group) =>
  VIEWPORTS.map((width) => ({ group, width, result: 'PASS' })),
);
test('117 elements require both real viewport receipts', () => {
  const full = semanticSummary(matrix, all);
  assert.deepEqual(full.counts, { PASS: 117, FAIL: 0, NOT_RUN: 0 });
  assert.equal(full.gate, 'PASS');
  const missing = semanticSummary(
    matrix,
    all.filter((r) => r.width !== 375),
  );
  assert.equal(missing.counts.NOT_RUN, 117);
  assert.equal(missing.gate, 'PARTIAL');
});
test('one failure fails all elements in the affected behavior group', () => {
  const rows = all.map((r) => (r.group === 'contract-new.submit' && r.width === 375 ? { ...r, result: 'FAIL' } : r));
  const result = semanticSummary(matrix, rows);
  assert.equal(result.gate, 'FAIL');
  assert.equal(result.counts.FAIL, GROUPS['contract-new.submit'].length);
});
test('Active dependent operations are explicit NOT_RUN, not successful disabled checks', () => {
  const rows = all.map((r) =>
    r.group === 'device-operate.commands' ? { ...r, result: 'NOT_RUN', reason: 'ACTUATION_REQUIRES_ACTIVE' } : r,
  );
  const result = semanticSummary(matrix, rows);
  assert.equal(result.gate, 'PARTIAL');
  assert.equal(result.counts.NOT_RUN, 8);
});

test('duplicate, foreign and invalid viewport receipts fail closed', () => {
  for (const rows of [
    [...all, all[0]],
    [{ group: 'invented', width: 375, result: 'PASS' }],
    [{ ...all[0], width: 400 }],
  ])
    assert.throws(() => semanticSummary(matrix, rows), /INVALID_TARGET_EXECUTION_ROWS/);
});

test('Defer and Reject failures also block the browser Gate', () => {
  const result = semanticSummary(
    matrix,
    all.map((r) => (r.group.startsWith('absence:') && r.width === 375 ? { ...r, result: 'FAIL' } : r)),
  );
  assert.equal(result.counts.PASS, 117);
  assert.equal(result.gate, 'FAIL');
});

test('CSV proof rejects empty, foreign and malformed downloads while parsing quoted data', () => {
  assert.equal(validateOwnCsv(Buffer.from('id,remarks\r\n1,"qa09-own,fixture"\r\n'), 'qa09-own,fixture').dataRows, 1);
  for (const text of [
    'id,remarks\r\n',
    'id,remarks\r\n1,foreign\r\n',
    'id,remarks\r\n1,"qa09-own\r\n',
    'id,remarks\r\n1,qa09-own,extra\r\n',
  ])
    assert.throws(() => validateOwnCsv(Buffer.from(text), 'qa09-own'));
});
