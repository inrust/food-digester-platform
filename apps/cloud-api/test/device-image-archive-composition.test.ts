import { afterAll, beforeAll, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './helpers.js';
import { imageIntegrationFixture, jpeg } from './device-image-integration-fixtures.js';
import { renewImageViewer, readLatestImage } from '../../admin-web/src/pages/devices/live-image-api.js';
import { evidenceOutboxKey } from '@fdp/media';
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
  await db.pg.exec(readFileSync(new URL('../../../packages/database/prisma/seed.sql', import.meta.url), 'utf8'));
}, 60000);
afterAll(async () => {
  await db?.prisma.$disconnect();
  await db?.pg.close();
});
const signal = () => new AbortController().signal;
type F = Awaited<ReturnType<typeof imageIntegrationFixture>>;
async function issue(f: F, kind: 'ALARM' | 'EVENT', id: string) {
  const declaration = f.declaration(kind, id),
    response = await f.device('media/upload-sessions', declaration);
  expect(response.status).toBe(201);
  const view = response.body.data;
  f.objects.set(view.objectPath, jpeg);
  const record = f.record('media', `MED-${randomUUID()}`, {
    mediaType: 'IMAGE',
    captureTime: f.now().toISOString(),
    fileName: view.fileName,
    objectPath: view.objectPath,
    sizeKb: view.sizeKb,
    durationSec: 0,
  });
  return { declaration, view, record };
}
async function readEvidence(f: F, kind: 'ALARM' | 'EVENT', sourceId: string) {
  if (kind === 'ALARM') {
    const row = await f.client.alarm.findUniqueOrThrow({ where: { sourceMessageId: sourceId } });
    const response = await f.alice.api.request<{
      data: { status: string; evidenceImage: { mediaId: string; status: string } | null };
    }>(`/admin/alarms/${row.id}`);
    return response.data;
  }
  const row = await f.client.deviceEvent.findUniqueOrThrow({ where: { sourceMessageId: sourceId } });
  const response = await f.alice.api.request<{
    data: { eventId: string; evidenceImage: { mediaId: string; status: string } | null }[];
  }>(`/admin/events?deviceId=${f.deviceId}`);
  return response.data.find((entry) => entry.eventId === row.id)!;
}
for (const kind of ['EVENT', 'ALARM'] as const) {
  for (const order of ['source-first', 'media-first'] as const) {
    test(`${kind} ${order}: preview + REST session + SQS schema/dispatcher/receipt + Outbox + read/download remain independent`, async () => {
      const f = await imageIntegrationFixture(db),
        viewer = randomUUID(),
        sourceId = `SRC-${randomUUID()}`;
      const lease = await renewImageViewer(f.alice.api, f.deviceId, viewer, signal());
      const source = f.source(kind, sourceId);
      if (order === 'source-first') expect((await f.ingest([source])).batchItemFailures).toEqual([]);
      const [uploaded, pending] = await Promise.all([
        f.device('live-image/frames', f.frame(lease.data.streamId)),
        issue(f, kind, sourceId),
      ]);
      expect(uploaded.status).toBe(200);
      expect(await f.client.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(1);
      const reused = await f.device('media/upload-sessions', pending.declaration);
      expect(reused.status).toBe(200);
      expect(reused.body.data.objectPath).toBe(pending.view.objectPath);
      const duplicate = await Promise.all([f.ingest([pending.record]), f.ingest([pending.record])]);
      expect(duplicate.every((result) => result.batchItemFailures.length === 0)).toBe(true);
      let e = await f.client.mediaEvidence.findFirstOrThrow({ where: { deviceId: f.deviceId } });
      if (order === 'media-first') {
        expect(e.status).toBe('PENDING');
        expect((await f.ingest([source])).batchItemFailures).toEqual([]);
      }
      if (kind === 'ALARM') {
        expect(
          (
            await f.ingest([
              f.record('alarm', `CLEAR-${randomUUID()}`, {
                code: 'TEMP_HIGH',
                status: 'CLEARED',
                detectedTime: f.now().toISOString(),
              }),
            ])
          ).batchItemFailures,
        ).toEqual([]);
      }
      f.advance(order === 'media-first' ? 60001 : 0);
      await Promise.all([f.worker(), f.worker()]);
      e = await f.client.mediaEvidence.findUniqueOrThrow({ where: { id: e.id } });
      expect(e.status).toBe('LINKED');
      expect(await f.client.mediaObject.count({ where: { deviceId: f.deviceId } })).toBe(1);
      expect(await f.client.ingestionReceipt.count({ where: { deviceId: f.deviceId, topicType: 'media' } })).toBe(1);
      expect(await f.client.outboxEvent.count({ where: { idempotencyKey: evidenceOutboxKey(e.triggerId) } })).toBe(1);
      const confirmation = await f.device('media/upload-sessions', pending.declaration);
      expect(confirmation.status).toBe(409);
      expect(confirmation.body.error).toMatchObject({
        code: 'MEDIA_ALREADY_REGISTERED',
        details: { mediaId: e.mediaId },
      });
      const read = await readEvidence(f, kind, sourceId);
      expect(read.evidenceImage).toMatchObject({ mediaId: e.mediaId, status: 'AVAILABLE' });
      if (kind === 'ALARM') {
        expect(read).toMatchObject({ status: 'CLEARED', severity: 'MAJOR' });
        const stored = await f.client.alarm.findUniqueOrThrow({ where: { sourceMessageId: sourceId } });
        expect(stored.severity).toBe('HIGH');
        const filtered = await f.alice.api.request<{ data: { alarmId: string; severity: string }[] }>(
          `/admin/alarms?deviceId=${f.deviceId}&severity=MAJOR`,
        );
        expect(filtered.data).toEqual(
          expect.arrayContaining([expect.objectContaining({ alarmId: stored.id, severity: 'MAJOR' })]),
        );
      }
      const download = await f.alice.api.request<{ data: { downloadUrl: string } }>(
        `/admin/media/${e.mediaId}/download-url`,
      );
      expect(download.data.downloadUrl).toContain('https://s3.example.invalid/');
      expect(f.quarantine.send).not.toHaveBeenCalled();
      if (order === 'source-first') {
        expect(f.store.controls.get(f.deviceId)!.streamId).toBe(lease.data.streamId);
        expect((await readLatestImage(f.alice.api, f.deviceId, viewer, signal())).data.state).toBe('READY');
      }
      await f.client.mediaObject.update({ where: { id: e.mediaId }, data: { status: 'DELETED' } });
      expect((await readEvidence(f, kind, sourceId)).evidenceImage).toMatchObject({ status: 'DELETED' });
      await expect(f.alice.api.request(`/admin/media/${e.mediaId}/download-url`)).rejects.toMatchObject({
        status: 404,
      });
    });
  }
}
test('concurrent triggered session attempts reserve one quota; expired session and late old MQTT cannot win over replacement', async () => {
  const f = await imageIntegrationFixture(db),
    id = `SRC-${randomUUID()}`,
    declaration = f.declaration('EVENT', id);
  const responses = await Promise.all(Array.from({ length: 4 }, () => f.device('media/upload-sessions', declaration)));
  expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
  expect(new Set(responses.map((r) => r.body.data.sessionId)).size).toBe(1);
  const old = responses[0]!.body.data;
  f.objects.set(old.objectPath, jpeg);
  f.advance(900001);
  const replacement = await f.device('media/upload-sessions', declaration);
  expect(replacement.status).toBe(201);
  expect(replacement.body.data.objectPath).not.toBe(old.objectPath);
  f.objects.set(replacement.body.data.objectPath, jpeg);
  const message = (view: typeof old) =>
    f.record('media', `MED-${randomUUID()}`, {
      mediaType: 'IMAGE',
      captureTime: f.now().toISOString(),
      fileName: view.fileName,
      objectPath: view.objectPath,
      sizeKb: view.sizeKb,
      durationSec: 0,
    });
  const current = message(replacement.body.data),
    late = message(old);
  const results = await Promise.all([f.ingest([late]), f.ingest([current])]);
  expect(results.every((r) => r.batchItemFailures.length === 0)).toBe(true);
  expect(f.quarantine.send).toHaveBeenCalledOnce();
  const object = await f.client.mediaObject.findFirstOrThrow({ where: { deviceId: f.deviceId } });
  expect(object.uploadSessionId).toBe(replacement.body.data.sessionId);
  expect(await f.client.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(2);
  expect((await f.device('media/upload-sessions', declaration)).body.error.details.mediaId).toBe(object.id);
});
test('transient object storage failure returns SQS partial failure and leaves no receipt; replay recovers then terminal timeout is bounded', async () => {
  const f = await imageIntegrationFixture(db),
    id = `SRC-${randomUUID()}`,
    pending = await issue(f, 'EVENT', id);
  f.storage.computeSha256.mockRejectedValueOnce(new Error('local transient storage failure'));
  expect((await f.ingest([pending.record])).batchItemFailures).toEqual([{ itemIdentifier: pending.record.messageId }]);
  expect(await f.client.ingestionReceipt.count({ where: { deviceId: f.deviceId, topicType: 'media' } })).toBe(0);
  expect(await f.client.mediaObject.count({ where: { deviceId: f.deviceId } })).toBe(0);
  expect((await f.ingest([pending.record])).batchItemFailures).toEqual([]);
  const e = await f.client.mediaEvidence.findFirstOrThrow({ where: { deviceId: f.deviceId } });
  expect(e.status).toBe('PENDING');
  f.advance(86400000);
  const result = await f.worker();
  expect(result.scan.pages).toBeLessThanOrEqual(3);
  expect(await f.client.mediaEvidence.findUnique({ where: { id: e.id } })).toMatchObject({
    status: 'UNMATCHED',
    failureReason: 'SOURCE_TIMEOUT',
  });
});
test('registration transaction rollback through normal SQS leaves no partial object/evidence/receipt and identical retry completes', async () => {
  const f = await imageIntegrationFixture(db),
    pending = await issue(f, 'EVENT', `SRC-${randomUUID()}`);
  // Fail the actual local transaction, including its tx-scoped Prisma delegates.
  await db.pg.exec(`CREATE FUNCTION img19_outbox_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_type = 'MEDIA_EVIDENCE_REGISTERED' THEN RAISE EXCEPTION 'IMG19_INJECTED'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER img19_outbox_fail BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION img19_outbox_fail();`);
  try {
    const first = await f.ingest([pending.record]);
    expect(first.batchItemFailures).toEqual([{ itemIdentifier: pending.record.messageId }]);
    expect(await f.client.mediaObject.count({ where: { deviceId: f.deviceId } })).toBe(0);
    expect(await f.client.mediaEvidence.count({ where: { deviceId: f.deviceId } })).toBe(0);
    expect(await f.client.ingestionReceipt.count({ where: { deviceId: f.deviceId, topicType: 'media' } })).toBe(0);
  } finally {
    await db.pg.exec('DROP TRIGGER img19_outbox_fail ON outbox_events; DROP FUNCTION img19_outbox_fail();');
  }
  expect((await f.ingest([pending.record])).batchItemFailures).toEqual([]);
  expect(await f.client.mediaObject.count({ where: { deviceId: f.deviceId } })).toBe(1);
});
test.each(['certificate', 'assignment'] as const)(
  'authority %s change while object verification is pending denies SQS commit without partial registration',
  async (kind) => {
    const f = await imageIntegrationFixture(db),
      pending = await issue(f, 'EVENT', `SRC-${randomUUID()}`);
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.storage.computeSha256.getMockImplementation()!;
    f.storage.computeSha256.mockImplementationOnce(async (key) => {
      started();
      await held;
      return original(key);
    });
    const delivery = f.ingest([pending.record]);
    await entered;
    try {
      if (kind === 'certificate')
        await f.client.deviceCertificate.update({
          where: { id: f.certId },
          data: { status: 'REVOKED', revokedAt: f.now() },
        });
      else {
        const customerId = `c-${randomUUID()}`;
        await f.client.customer.create({ data: { id: customerId, name: 'New scope' } });
        await f.client.device.update({ where: { id: f.deviceId }, data: { customerId } });
      }
    } finally {
      release();
    }
    expect((await delivery).batchItemFailures).toEqual([]);
    expect(f.quarantine.send).toHaveBeenCalledOnce();
    expect(await f.client.mediaObject.count({ where: { deviceId: f.deviceId } })).toBe(0);
    expect(await f.client.mediaEvidence.count({ where: { deviceId: f.deviceId } })).toBe(0);
    expect(await f.client.ingestionReceipt.count({ where: { deviceId: f.deviceId, topicType: 'media' } })).toBe(0);
    expect(await f.client.mediaUploadSession.findUnique({ where: { id: pending.view.sessionId } })).toMatchObject({
      status: 'ISSUED',
    });
  },
);
