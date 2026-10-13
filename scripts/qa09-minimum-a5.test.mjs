import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertArchiveAssociation,
  assertNaturalSummary,
  assertPartialBatch,
  dailyDigest,
  logRows,
} from './qa09-minimum-a5-proof.mjs';
import { validateEntityMode } from './run-qa09-ten-device-acceptance.mjs';
import { assertOwnS3Request } from './qa09-own-s3-cli.mjs';
const uuid = '11111111-1111-1111-1111-111111111111',
  other = '22222222-2222-2222-2222-222222222222';
const published = [
  {
    deviceId: 'qa09-1234567890abcdef-01',
    customerId: uuid,
    type: 'telemetry',
    bodySha256: 'b'.repeat(64),
    payloadSha256: 'c'.repeat(64),
  },
];
const outbox = [
  {
    id: uuid,
    event_type: 'ARCHIVE',
    aggregate_id: published[0].deviceId,
    topic_type: 'telemetry',
    status: 'PUBLISHED',
    raw_body_sha256: published[0].bodySha256,
    payload_hash: published[0].payloadSha256,
  },
];
const key = `raw/topic_type=telemetry/customer_id=${uuid}/year=2026/part-test.json.gz`;
const logs = [
  {
    event: 'archive.record.completed',
    schemaVersion: 1,
    eventId: uuid,
    source: 'aws:sqs',
    queueName: 'fdp-test-archive',
    messageId: other,
    lambdaRequestId: uuid,
    outcome: 'ARCHIVED',
    objectKey: key,
    manifestKey: key + '.manifest',
    compressedSha256: 'a'.repeat(64),
  },
];
const objects = [
  {
    key,
    manifestKey: key + '.manifest',
    compressedSha256: 'a'.repeat(64),
    eventId: uuid,
    rawBodySha256: published[0].bodySha256,
    payloadSha256: published[0].payloadSha256,
    versionId: 'v1',
    manifestVersionId: 'm1',
  },
];
test('Archive proof requires exact nonempty outbox, actual queue invocation and versioned object bytes', () => {
  assert.equal(assertArchiveAssociation(published, outbox, logs, objects).result, 'PASS');
  assert.throws(() => assertArchiveAssociation([], [], [], []), /NONEMPTY/);
  for (const patch of [
    { source: 'DIRECT_FIXTURE_OR_UNKNOWN' },
    { eventId: other },
    { queueName: 'fdp-test-replay' },
    { lambdaRequestId: null },
    { messageId: 'DIRECT-GOOD-1' },
  ])
    assert.throws(() => assertArchiveAssociation(published, outbox, [{ ...logs[0], ...patch }], objects));
  for (const patch of [
    { key: 'foreign' },
    { payloadSha256: 'bad' },
    { manifestVersionId: null },
    { compressedSha256: 'bad' },
  ])
    assert.throws(() => assertArchiveAssociation(published, outbox, logs, [{ ...objects[0], ...patch }]));
  assert.throws(() => assertArchiveAssociation(published, [outbox[0], outbox[0]], logs, objects), /EXACT_PUBLISHED/);
});
const row = {
  device_id: published[0].deviceId,
  customer_id: uuid,
  site_id: 'site',
  bucket_date: '2026-10-13T00:00:00Z',
  sample_count: 1,
  completeness_pct: '100.000',
  missing_record_count: 0,
  metrics: { z: { n: 2 }, a: 1 },
};
const expected = {
  deviceId: row.device_id,
  customerId: uuid,
  notBefore: '2026-10-13T10:00:00Z',
  ruleName: 'fdp-test-summary',
};
const upsert = {
  event: 'summary.daily.upserted',
  schemaVersion: 1,
  deviceId: row.device_id,
  customerId: uuid,
  siteId: 'site',
  bucketDate: new Date(row.bucket_date).toISOString(),
  outputSha256: dailyDigest(row),
  sampleCount: 1,
  source: 'aws.events',
  ruleName: expected.ruleName,
  eventId: uuid,
  lambdaRequestId: other,
  eventTime: '2026-10-13T10:37:00Z',
};
const completed = { ...upsert, event: 'summary.run.completed', dailyUpserted: 1 };
test('Summary proves natural same-request completion and exact persisted digest, not time proximity', () => {
  assert.equal(assertNaturalSummary([row], [upsert, completed], expected).result, 'PASS');
  for (const patch of [
    { source: 'MANUAL_OR_UNRECOGNIZED' },
    { ruleName: 'foreign' },
    { outputSha256: 'bad' },
    { eventTime: '2026-10-13T09:37:00Z' },
    { siteId: 'wrong' },
  ])
    assert.throws(() => assertNaturalSummary([row], [{ ...upsert, ...patch }, completed], expected));
  assert.throws(() => assertNaturalSummary([row], [upsert, { ...completed, lambdaRequestId: uuid }], expected));
  assert.throws(() => assertNaturalSummary([{ ...row, sample_count: 0 }], [upsert, completed], expected));
  assert.equal(dailyDigest(row), dailyDigest({ ...row, metrics: { a: 1, z: { n: 2 } } }));
  assert.notEqual(dailyDigest(row), dailyDigest({ ...row, metrics: { a: 2 } }));
});
test('Partial response cannot upgrade direct fixture IDs to real SQS retry or DLQ evidence', () => {
  const response = { batchItemFailures: [{ itemIdentifier: 'bad' }] };
  assert.equal(assertPartialBatch(response, ['bad'], ['good']).actualPoisonRetryOrDlqProven, false);
  for (const r of [
    { batchItemFailures: [] },
    { batchItemFailures: [{ itemIdentifier: 'good' }] },
    { batchItemFailures: [{ itemIdentifier: 'bad' }, { itemIdentifier: 'bad' }] },
  ])
    assert.throws(() => assertPartialBatch(r, ['bad'], ['good']));
});
test('Remaining-only mode requires explicit hook and cannot combine review or unknown modes', () => {
  assert.throws(() => validateEntityMode({ reviewOnly: false, remainingOnly: true }, () => {}));
  const fn = () => {};
  fn.remainingOnly = true;
  validateEntityMode({ reviewOnly: false, remainingOnly: true }, fn);
  assert.throws(() => validateEntityMode({ reviewOnly: true, remainingOnly: true }, fn));
});
test('S3 reads require own prefixes and immutable version, including new signal types', () => {
  const input = {
    Bucket: 'fdp-test-raw-065986019555',
    Key: `raw/topic_type=tamper/customer_id=${uuid}/part.json.gz`,
    VersionId: 'v1',
  };
  assertOwnS3Request('get-object', input, [uuid, other]);
  assert.throws(() => assertOwnS3Request('get-object', { ...input, VersionId: undefined }, [uuid, other]));
  assert.throws(() => assertOwnS3Request('get-object', { ...input, Key: 'raw/foreign' }, [uuid, other]));
  assert.throws(() => assertOwnS3Request('put-object', input, [uuid, other]));
});
test('Minimum scope keeps truth and disallows all new privilege channels', () => {
  const scope = JSON.parse(readFileSync(new URL('../infra/environments/qa09-minimum-cloud.json', import.meta.url)));
  for (const k of [
    'newChannelsRequired',
    'newIamRolesRequired',
    'iamKmsOrSharedPermissionChangesAllowed',
    'performanceExpansion',
    'repeatFullBusinessSuite',
    'fullQa09Accepted',
    'productionReady',
  ])
    assert.equal(scope[k], false);
  assert.ok(scope.conditionalExclusions.every((e) => e.releaseRequired && e.status.endsWith('NOT_ACCEPTED')));
  assert.equal(logRows([{ message: 'PREFIX {"event":"test"}' }, { message: 'bad' }])[0].event, 'test');
});
