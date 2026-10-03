import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnS3Request } from './qa09-own-s3-cli.mjs';
test('S3 fallback accepts exact owned version cleanup and rejects bucket, customer and pagination expansion', () => {
  const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
  const key = 'raw/topic_type=telemetry/customer_id=' + ids[0] + '/sample.json.gz';
  const input = { Bucket: 'fdp-test-raw-065986019555', Delete: { Objects: [{ Key: key, VersionId: 'v1' }] } };
  assertOwnS3Request('delete-objects', input, ids);
  assert.throws(() => assertOwnS3Request('delete-objects', { ...input, Bucket: 'other' }, ids));
  assert.throws(() =>
    assertOwnS3Request(
      'delete-objects',
      { ...input, Delete: { Objects: [{ Key: 'raw/foreign', VersionId: 'v1' }] } },
      ids,
    ),
  );
  assert.throws(() => assertOwnS3Request('delete-objects', { ...input, Delete: { Objects: [{ Key: key }] } }, ids));
  assert.throws(() =>
    assertOwnS3Request('list-object-versions', { Bucket: input.Bucket, Prefix: key, KeyMarker: 'foreign' }, ids),
  );
  assert.throws(() => assertOwnS3Request('purge', { Bucket: input.Bucket }, ids));
});
