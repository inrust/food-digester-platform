import assert from 'node:assert/strict';
import test from 'node:test';
import { codeRangeTimeoutMs, codeRangeConcurrency } from './collect-qa09-application-version.mjs';

test('range reads keep the original default and permit bounded slow-link retry', () => {
  assert.equal(codeRangeTimeoutMs({}), 45000);
  assert.equal(codeRangeTimeoutMs({ QA09_CODE_RANGE_TIMEOUT_MS: '120000' }), 120000);
  assert.equal(codeRangeTimeoutMs({ QA09_CODE_RANGE_TIMEOUT_MS: '180000' }), 180000);
});

test('range reads reject unbounded, ambiguous and below-default timeouts', () => {
  for (const value of ['0', '44999', '180001', 'Infinity', '120000ms', '0120000', '-1', ''])
    assert.throws(() => codeRangeTimeoutMs({ QA09_CODE_RANGE_TIMEOUT_MS: value }), /INVALID_CODE_RANGE_TIMEOUT/);
});

test('read-only asset concurrency stays bounded independently of DB/API capacity', () => {
  assert.equal(codeRangeConcurrency({}), 8);
  assert.equal(codeRangeConcurrency({ QA09_CODE_RANGE_CONCURRENCY: '32' }), 32);
  for (const value of ['0', '33', 'Infinity', '08', '-1', ''])
    assert.throws(() => codeRangeConcurrency({ QA09_CODE_RANGE_CONCURRENCY: value }), /INVALID_CODE_RANGE_CONCURRENCY/);
});
