import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertArchiveAssociation,
  assertNaturalSummary,
  assertPartialBatch,
  dailyDigest,
  logRows,
  assertIngressArchive,
  sha256,
} from './qa09-minimum-a5-proof.mjs';
import { validateEntityMode } from './run-qa09-ten-device-acceptance.mjs';
import { assertOwnS3Request } from './qa09-own-s3-cli.mjs';
import { validateOwnVersionPlan } from './qa09-own-version-reader.mjs';
import { canonicalizeJson } from '../contracts/mqtt/payload-normalization.ts';
const uuid = '11111111-1111-1111-1111-111111111111',
  other = '22222222-2222-2222-2222-222222222222';
const published = [
  {
    deviceId: 'qa09-1234567890abcdef-01',
    customerId: uuid,
    type: 'telemetry',
    messageId: 'T-1',
    seq: 1,
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
    raw_body_sha256: 'd'.repeat(64),
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
    rawBodySha256: 'd'.repeat(64),
    ingressPayloadSha256: published[0].payloadSha256,
    ingressContextVerified: true,
    messageId: published[0].messageId,
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
test('Existing-role reader only accepts ten fixed own versioned files and no arbitrary prefix', () => {
  const plan = {
    prefix: 'qa09-1234567890abcdef',
    customerIds: [uuid, other],
    objects: Array.from({ length: 5 }, (_, i) =>
      ['json.gz', 'manifest.json'].map((ext) => ({
        key: `raw/topic_type=telemetry/customer_id=${uuid}/year=2026/month=10/day=13/hour=13/part-${String(i).padStart(16, '0')}.${ext}`,
        versionId: 'v1',
      })),
    ).flat(),
  };
  validateOwnVersionPlan(plan);
  validateOwnVersionPlan({ ...plan, objects: plan.objects.slice(0, 2) });
  for (const patch of [
    { objects: plan.objects.slice(1) },
    { objects: plan.objects.map((o) => ({ ...o, versionId: undefined })) },
    { objects: plan.objects.map((o) => ({ ...o, key: o.key.replace(uuid, '33333333-3333-3333-3333-333333333333') })) },
  ])
    assert.throws(() => validateOwnVersionPlan({ ...plan, ...patch }));
  assert.throws(() =>
    assertOwnS3Request('get-object', { Bucket: 'fdp-test-raw-065986019555', Key: key, VersionId: 'v1' }, [uuid, other]),
  );
});

test('Actual broker envelope remains byte-bound separately from the published payload and certificate', () => {
  const payload = { meta: { id: 'T-1', seq: 1, ts: '2026-10-13T13:00:00Z' }, data: { value: 1 } };
  const p = { ...published[0], payloadSha256: sha256(canonicalizeJson(payload)) };
  const envelope = {
    ...payload,
    iotTopic: `bnx/device/${p.deviceId}/telemetry`,
    iotDeviceId: p.deviceId,
    iotType: 'telemetry',
    iotReceivedAt: 1,
    iotPrincipal: 'a'.repeat(64),
  };
  const row = {
    deviceId: p.deviceId,
    customerId: p.customerId,
    topicType: p.type,
    receivedAtMs: 1,
    payload,
    rawBody: JSON.stringify(envelope),
  };
  const proof = assertIngressArchive(row, p, 'a'.repeat(64));
  assert.equal(proof.ingressContextVerified, true);
  assert.notEqual(proof.rawBodySha256, sha256(JSON.stringify(payload)));
  for (const patch of [
    { iotPrincipal: 'b'.repeat(64) },
    { iotDeviceId: 'foreign' },
    { iotTopic: 'bnx/device/foreign/telemetry' },
    { data: { value: 2 } },
  ])
    assert.throws(() =>
      assertIngressArchive({ ...row, rawBody: JSON.stringify({ ...envelope, ...patch }) }, p, 'a'.repeat(64)),
    );
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

test('Direct handler proof binds both synthetic successes to one real invocation and exact own object', async () => {
  const { assertDirectPartialAssociation } = await import('./check-qa09-minimum-a5.mjs');
  const partial = {
    eventId: uuid,
    goodIds: ['DIRECT-GOOD', 'DIRECT-DUPLICATE'],
    object: { key, manifestKey: key + '.manifest', compressedSha256: 'a'.repeat(64) },
  };
  const rows = partial.goodIds.map((messageId) => ({
    event: 'archive.record.completed',
    eventId: uuid,
    messageId,
    source: 'DIRECT_FIXTURE_OR_UNKNOWN',
    queueName: null,
    outcome: 'ARCHIVED',
    objectKey: key,
    manifestKey: key + '.manifest',
    compressedSha256: 'a'.repeat(64),
    lambdaRequestId: other,
  }));
  assert.equal(assertDirectPartialAssociation(partial, rows).actualSqsDeliveryOrDlq, false);
  for (const patch of [
    { source: 'aws:sqs' },
    { lambdaRequestId: uuid },
    { compressedSha256: 'bad' },
    { objectKey: 'foreign' },
  ])
    assert.throws(() => assertDirectPartialAssociation(partial, [rows[0], { ...rows[1], ...patch }]));
});

test('Reused natural association requires real nonempty upsert, same request and actual daily persistence count', async () => {
  const { naturalSummaryBusinessAssociation } = await import('./qa09-natural-summary-association.mjs');
  const p = {
    devices: [row.device_id],
    customers: [{ id: uuid }],
    prefix: 'qa09-1234567890abcdef',
    failure: { code: 'OWN_VERSION_READER_FAILED' },
    finishedAt: '2026-10-13T11:00:00Z',
    remainderStartedAt: expected.notBefore,
  };
  const before = {
    prefix: p.prefix,
    action: 'consistency-observe',
    gate: 'PASS',
    devices: [{ lifecycle_status: 'Onboarded' }],
    telemetry_hourly: [{ device_id: row.device_id, customer_id: uuid, sample_count: 1 }],
  };
  const cleanup = {
    prefix: p.prefix,
    action: 'cleanup',
    gate: 'PASS',
    deleted: { telemetry_daily: 1, telemetry_hourly: 1 },
  };
  const r = naturalSummaryBusinessAssociation(p, before, cleanup, [upsert, completed]);
  assert.equal(r.independentDailyValueReadback, false);
  assert.equal(r.result, 'PASS');
  assert.throws(() =>
    naturalSummaryBusinessAssociation(p, before, { ...cleanup, deleted: { telemetry_daily: 0, telemetry_hourly: 1 } }, [
      upsert,
      completed,
    ]),
  );
  for (const patch of [{ source: 'MANUAL_OR_UNRECOGNIZED' }, { customerId: other }, { lambdaRequestId: uuid }])
    assert.throws(() => naturalSummaryBusinessAssociation(p, before, cleanup, [{ ...upsert, ...patch }, completed]));
});
