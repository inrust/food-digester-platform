import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from './qa09-minimum-a5-proof.mjs';
import { archiveQueueWriteAssociation } from './qa09-minimum-association-gate.mjs';
function fixture() {
  const prefix = 'qa09-1234567890abcdef',
    deviceId = prefix + '-01',
    customerId = '11111111-1111-1111-1111-111111111111',
    types = ['telemetry', 'alarm', 'event', 'tamper'],
    published = types.map((type) => ({ deviceId, customerId, type, seq: 1, payloadSha256: 'a'.repeat(64) })),
    outbox = types.map((topic_type, i) => ({
      id: `00000000-0000-0000-0000-00000000000${i}`,
      event_type: 'ARCHIVE',
      aggregate_id: deviceId,
      topic_type,
      payload_hash: 'a'.repeat(64),
      raw_body_sha256: 'b'.repeat(64),
      status: 'PUBLISHED',
    })),
    logs = outbox.map((o) => {
      const key = `raw/topic_type=${o.topic_type}/customer_id=${customerId}/year=2026/part-${sha256(o.id).slice(0, 16)}.json.gz`;
      return {
        event: 'archive.record.completed',
        eventId: o.id,
        schemaVersion: 1,
        source: 'aws:sqs',
        queueName: 'fdp-test-archive',
        messageId: customerId,
        lambdaRequestId: customerId,
        outcome: 'ARCHIVED',
        objectKey: key,
        manifestKey: key.replace('.json.gz', '.manifest.json'),
        compressedSha256: 'c'.repeat(64),
      };
    });
  return {
    parent: {
      prefix,
      failure: { code: 'OWN_VERSION_READER_FAILED' },
      published,
      archiveKeys: logs.flatMap((l) => [l.objectKey, l.manifestKey]),
      cleanup: [{ type: 'archive-batch-owned-prefix', result: 'PASS', count: 10 }],
    },
    db: {
      prefix,
      gate: 'PASS',
      devices: [{ lifecycle_status: 'Onboarded' }],
      outbox,
      receipts: published.map((p) => ({
        device_id: deviceId,
        topic_type: p.type,
        seq: 1,
        payload_hash: p.payloadSha256,
        result: 'PROCESSED',
      })),
    },
    logs,
  };
}
test('Queue association proves actual business/storage completion without claiming an unperformed normal byte readback', () => {
  const f = fixture();
  const r = archiveQueueWriteAssociation(f.parent, f.db, f.logs);
  assert.equal(r.result, 'PASS');
  assert.equal(r.newIndependentNormalObjectByteReadback, false);
});
test('Temporal logs, foreign keys, direct fixture IDs, missing DB commitment or cleanup cannot close queue association', () => {
  for (const mutate of [
    (f) => {
      f.logs[0].source = 'DIRECT_FIXTURE_OR_UNKNOWN';
    },
    (f) => {
      f.logs[0].eventId = 'foreign';
    },
    (f) => {
      f.logs[0].objectKey = 'foreign';
    },
    (f) => {
      f.db.outbox[0].status = 'PENDING';
    },
    (f) => {
      f.db.receipts[0].payload_hash = 'bad';
    },
    (f) => {
      f.parent.archiveKeys = [];
    },
    (f) => {
      f.parent.cleanup[0].result = 'FAIL';
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => archiveQueueWriteAssociation(f.parent, f.db, f.logs));
  }
});
