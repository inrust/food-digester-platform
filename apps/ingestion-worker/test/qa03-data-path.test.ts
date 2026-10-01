import { rejects } from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { assert, test } from 'vitest';
import { computeAuditHash } from '@fdp/contracts/mqtt/payload-normalization.js';
import { gapStatus } from '../src/index.js';
import { TYPES, sha, withQa03Fixture } from './qa03-fixture.js';

const failures = (id: string) => [{ itemIdentifier: id }];

test('QA03 eight routes: business + receipts + outbox + raw archive, duplicate redelivery', async () => {
  await withQa03Fixture('eight-routes', async (f) => {
    const records = f.devices.flatMap((_, i) => TYPES.map((type) => f.record(type, i)));
    assert.deepEqual((await f.ingest({ Records: records })).batchItemFailures, []);
    assert.deepEqual(f.quarantine, []);
    assert.equal(await f.prisma.ingestionReceipt.count(), 80);
    const counts = async () =>
      Promise.all([
        f.prisma.deviceLatestState.count(),
        f.prisma.telemetryHourly.count(),
        f.prisma.esgReport.count(),
        f.prisma.alarm.count(),
        f.prisma.deviceEvent.count(),
        f.prisma.commandAck.count(),
        f.prisma.tamperEvent.count(),
        f.prisma.mediaObject.count(),
      ]);
    assert.deepEqual(await counts(), Array(8).fill(10));
    assert.equal(await f.prisma.deviceCommand.count({ where: { status: 'SUCCEEDED' } }), 10);
    const outboxBefore = await f.prisma.outboxEvent.count();
    const telemetryBefore = await f.prisma.telemetryHourly.findMany({ orderBy: { id: 'asc' } });
    assert.deepEqual((await f.ingest({ Records: records })).batchItemFailures, []);
    assert.deepEqual(await counts(), Array(8).fill(10));
    assert.equal(await f.prisma.ingestionReceipt.count(), 80);
    assert.equal(await f.prisma.outboxEvent.count(), outboxBefore);
    assert.deepEqual(await f.prisma.telemetryHourly.findMany({ orderBy: { id: 'asc' } }), telemetryBefore);
    const result = await f.publisher.publishPendingBatch();
    assert.equal(result.published, 60);
    assert.deepEqual((await f.archive({ Records: f.archiveQueue })).batchItemFailures, []);
    const original = new Map(records.map((record) => [JSON.parse(record.body).meta.id, record.body]));
    const hashes = [];
    for (const [key, bytes] of f.objects) {
      if (!key.endsWith('.json.gz')) continue;
      const line = JSON.parse(gunzipSync(bytes).toString('utf8').trim());
      assert.equal(line.rawBody, original.get(line.payload.meta.id));
      const envelope = JSON.parse(line.rawBody);
      const {
        iotTopic: _topic,
        iotDeviceId: _device,
        iotType: _type,
        iotReceivedAt: _time,
        iotPrincipal: _principal,
        ...payload
      } = envelope;
      assert.deepEqual(line.payload, payload);
      if (payload.audit) assert.equal(computeAuditHash(payload), payload.audit.hash);
      assert.include(key, `customer_id=${f.customerId}/`);
      const manifest = JSON.parse(Buffer.from(f.objects.get(key.replace('.json.gz', '.manifest.json'))!).toString());
      assert.equal(manifest.sha256, sha(bytes));
      assert.deepEqual(manifest.eventIds, [line.eventId]);
      hashes.push({ messageId: line.payload.meta.id, rawSha256: sha(line.rawBody), objectSha256: sha(bytes) });
    }
    assert.equal(hashes.length, 60);
    const bytesBefore = [...f.objects].map(([key, bytes]) => [key, sha(bytes)]);
    assert.deepEqual((await f.archive({ Records: [...f.archiveQueue].reverse() })).batchItemFailures, []);
    assert.deepEqual(
      [...f.objects].map(([key, bytes]) => [key, sha(bytes)]),
      bytesBefore,
    );
    return {
      routes: [...TYPES],
      legalMessages: 80,
      receipts: 80,
      businessRows: 80,
      duplicateDeliveries: 80,
      duplicateBusinessRows: 0,
      archiveRecords: 60,
      rawHashChecks: hashes,
    };
  });
}, 60_000);

test('QA03 partial failure, quarantine retry, payload conflict and gap recovery', async () => {
  await withQa03Fixture('ingestion-faults', async (f) => {
    const one = f.record('telemetry');
    const two = f.record('telemetry');
    const three = f.record('telemetry');
    f.faults.ingestionId = JSON.parse(two.body).meta.id;
    const invalid = { messageId: 'QA03-invalid-json', body: '{invalid' };
    f.faults.quarantine = true;
    const batch = await f.ingest({ Records: [one, invalid, two, three] });
    assert.sameDeepMembers(batch.batchItemFailures, [...failures(invalid.messageId), ...failures(two.messageId)]);
    assert.equal(await f.prisma.ingestionReceipt.count(), 2);
    assert.equal(await f.prisma.outboxEvent.count(), 2);
    assert.deepEqual(
      (await gapStatus(f.prisma, { deviceId: f.devices[0]!.deviceId, topicType: 'telemetry' })).map((g) => [
        g.missingFromSeq,
        g.missingToSeq,
      ]),
      [[2, 2]],
    );
    assert.deepEqual((await f.ingest({ Records: [two, invalid] })).batchItemFailures, []);
    assert.deepEqual(await gapStatus(f.prisma, { deviceId: f.devices[0]!.deviceId, topicType: 'telemetry' }), []);
    assert.equal(f.quarantine[0]!.rawBody, invalid.body);
    const conflict = JSON.parse(one.body);
    conflict.data.currentAmp = 999;
    const { iotTopic: _t, iotType: _y, iotDeviceId: _d, iotPrincipal: _p, iotReceivedAt: _r, ...payload } = conflict;
    conflict.audit.hash = computeAuditHash(payload);
    const badSchema = JSON.parse(f.record('heartbeat').body);
    badSchema.data.deviceStatus = 'BROKEN';
    const badIdentity = JSON.parse(f.record('event').body);
    badIdentity.iotPrincipal = `arn:aws:iot:ap-southeast-1:123456789012:cert/${f.devices[1]!.certificateId}`;
    assert.deepEqual(
      (
        await f.ingest({
          Records: [
            { messageId: 'conflict', body: JSON.stringify(conflict) },
            { messageId: 'schema', body: JSON.stringify(badSchema) },
            { messageId: 'identity', body: JSON.stringify(badIdentity) },
          ],
        })
      ).batchItemFailures,
      [],
    );
    assert.deepEqual(
      f.quarantine.map((q) => q.errorType),
      ['INVALID_JSON', 'PAYLOAD_CONFLICT', 'SCHEMA_VIOLATION', 'IDENTITY_VIOLATION'],
    );
    assert.equal(await f.prisma.ingestionReceipt.count(), 3);
    assert.equal(await f.prisma.outboxEvent.count(), 3);
    return {
      legalMessages: 3,
      receipts: 3,
      partialFailures: 2,
      quarantined: 4,
      traceablePending: 3,
      gapDetected: true,
      gapResolved: true,
      duplicateBusinessRows: 0,
    };
  });
}, 60_000);

test('QA03 archive queue outage and manifest failure converge with stable objects', async () => {
  await withQa03Fixture('archive-faults', async (f) => {
    assert.deepEqual((await f.ingest({ Records: [f.record('event'), f.record('event', 1)] })).batchItemFailures, []);
    f.faults.send = true;
    assert.deepEqual(await f.publisher.publishPendingBatch(), { claimed: 2, published: 1, retried: 1, failed: 0 });
    assert.equal(await f.prisma.outboxEvent.count({ where: { status: 'PENDING', retryCount: 1 } }), 1);
    assert.equal(await f.prisma.deviceEvent.count(), 2);
    assert.equal((await f.publisher.publishPendingBatch()).published, 1);
    assert.equal(f.archiveQueue.length, 2);
    f.faults.manifest = true;
    assert.sameDeepMembers(
      (await f.archive({ Records: f.archiveQueue })).batchItemFailures,
      f.archiveQueue.map((r) => ({ itemIdentifier: r.messageId })),
    );
    assert.equal([...f.objects.keys()].filter((key) => key.endsWith('.json.gz')).length, 1);
    assert.deepEqual((await f.archive({ Records: f.archiveQueue })).batchItemFailures, []);
    assert.equal(f.objects.size, 4);
    const mixed = await f.archive({ Records: [f.archiveQueue[0]!, { messageId: 'invalid-archive', body: '{bad' }] });
    assert.deepEqual(mixed.batchItemFailures, failures('invalid-archive'));
    assert.equal(f.objects.size, 4);
    return {
      legalMessages: 2,
      receipts: 2,
      archiveRecords: 2,
      queueRetry: true,
      manifestRetry: true,
      archivePartialFailure: true,
      duplicateBusinessRows: 0,
    };
  });
}, 60_000);

test('QA03 business/receipt/outbox transaction rollback then retry', async () => {
  await withQa03Fixture('transaction-rollback', async (f) => {
    const record = f.record('event');
    await f.pg.exec(
      `CREATE FUNCTION qa03_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA03 outbox write outage'; END $$; CREATE TRIGGER qa03_reject BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION qa03_reject_outbox();`,
    );
    assert.deepEqual((await f.ingest({ Records: [record] })).batchItemFailures, failures(record.messageId));
    assert.equal(await f.prisma.deviceEvent.count(), 0);
    assert.equal(await f.prisma.ingestionReceipt.count(), 0);
    assert.equal(await f.prisma.outboxEvent.count(), 0);
    await f.pg.exec('DROP TRIGGER qa03_reject ON outbox_events; DROP FUNCTION qa03_reject_outbox();');
    assert.deepEqual((await f.ingest({ Records: [record] })).batchItemFailures, []);
    assert.equal(await f.prisma.deviceEvent.count(), 1);
    assert.equal(await f.prisma.ingestionReceipt.count(), 1);
    assert.equal(await f.prisma.outboxEvent.count({ where: { status: 'PENDING' } }), 1);
    return { legalMessages: 1, receipts: 1, traceablePending: 1, rollback: true, duplicateBusinessRows: 0 };
  });
}, 60_000);

test('QA03 isolated resources are cleaned even when the scenario throws', async () => {
  await withQa03Fixture('cleanup-failure', async (f) => {
    let failedFixture: typeof f | undefined;
    await rejects(
      withQa03Fixture('deliberate-failure', async (inner) => {
        failedFixture = inner;
        await inner.ingest({ Records: [inner.record('event')] });
        await inner.publisher.publishPendingBatch();
        await inner.archive({ Records: inner.archiveQueue });
        throw new Error('QA03 deliberate assertion failure');
      }),
      /deliberate assertion failure/,
    );
    assert.ok(failedFixture);
    assert.notEqual(failedFixture.prefix, f.prefix);
    assert.equal(failedFixture.objects.size, 0);
    assert.equal(failedFixture.archiveQueue.length, 0);
    assert.equal(failedFixture.quarantine.length, 0);
    await rejects(failedFixture.pg.query('SELECT 1'));
    await failedFixture.cleanup(); // Idempotent cleanup.
    return { failureCleanup: true, isolatedPrefixes: true };
  });
}, 60_000);
