import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codeRangeTimeoutMs,
  codeRangeConcurrency,
  codeRangeBytes,
  validateStoredAssetSha256,
} from './collect-qa09-application-version.mjs';

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

test('whole-asset reads remain within the existing 32 MiB artifact bound and retain the default', () => {
  assert.equal(codeRangeBytes({}), 262144);
  assert.equal(codeRangeBytes({ QA09_CODE_RANGE_BYTES: '33554432' }), 33554432);
  for (const value of ['0', '-1', '33554433', 'Infinity', '262144;echo', ''])
    assert.throws(() => codeRangeBytes({ QA09_CODE_RANGE_BYTES: value }), /INVALID_CODE_RANGE_BYTES/);
});

test('S3 full-object verification rejects multipart/composite, wrong version/size/hash and absent SHA256', () => {
  const expected = { versionId: 'fixed-version', contentLength: 4985000, codeSha256: 'A'.repeat(43) + '=' };
  const value = {
    VersionId: expected.versionId,
    ObjectSize: expected.contentLength,
    Checksum: { ChecksumType: 'FULL_OBJECT', ChecksumSHA256: expected.codeSha256 },
  };
  assert.equal(validateStoredAssetSha256(value, expected), expected.codeSha256);
  for (const changed of [
    { ...value, VersionId: 'foreign' },
    { ...value, ObjectSize: 1 },
    { ...value, Checksum: { ...value.Checksum, ChecksumType: 'COMPOSITE' } },
    { ...value, Checksum: { ...value.Checksum, ChecksumSHA256: 'B'.repeat(43) + '=' } },
    { ...value, Checksum: { ChecksumCRC32: 'other' } },
  ])
    assert.throws(() => validateStoredAssetSha256(changed, expected), /FULL_OBJECT_SHA256_REQUIRED/);
});
