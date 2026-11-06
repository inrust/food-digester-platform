/** IMG-11: real migrated PGlite, local object storage; no AWS or target database. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { DbClient, PrismaClient } from '@fdp/database';
import { evidenceOutboxKey, MEDIA_EVIDENCE_REGISTERED } from '@fdp/media';
import { createTestDb } from '../../cloud-api/test/helpers.js';
import { createMediaHandler } from '../src/media/handler.js';
import type { ValidatedMessage } from '../src/ingest/pipeline.js';
import { createOutboxPublisher } from '../src/outbox/publisher.js';
import { createLeasedOutboxPublisher } from '../src/outbox/leased-publisher.js';
import { IngestError } from '../src/ingest/errors.js';

const jpeg = readFileSync(new URL('../../../contracts/rest/fixtures/device-images/capture.jpg', import.meta.url));
const hash = createHash('sha256').update(jpeg).digest('hex');
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 60000);
afterAll(async () => {
  await db?.prisma.$disconnect();
  await db?.pg.close();
});
async function fixture(kind: 'EVENT' | 'ALARM' | null = 'ALARM', historicalBytes = false) {
  const suffix = randomUUID(),
    customerId = `c-${suffix}`,
    deviceId = `d-${suffix}`,
    certId = `crt-${suffix}`;
  await db.prisma.customer.create({ data: { id: customerId, name: suffix } });
  await db.prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: suffix,
      customerId,
      model: 'M',
      hardwareVersion: '1',
      manufacturer: 'B',
      manufactureDate: new Date('2026-01-01Z'),
      lifecycleStatus: 'Active',
    },
  });
  await db.prisma.deviceCertificate.create({
    data: {
      id: certId,
      deviceId,
      fingerprint: suffix,
      status: 'ACTIVE',
      notBefore: new Date('2026-01-01Z'),
      notAfter: new Date('2027-01-01Z'),
    },
  });
  let clock = Date.parse('2026-11-06T08:00:00Z');
  const now = () => new Date(clock);
  const trigger = kind
    ? await db.prisma.mediaTrigger.create({
        data: {
          deviceId,
          customerId,
          kind,
          messageId: `SRC-${suffix}`,
          mediaType: 'IMAGE',
          fileName: 'capture.jpg',
          sizeBytes: jpeg.length,
          sizeKb: Math.ceil(jpeg.length / 1024),
          sha256Normalized: hash,
          createdAt: now(),
        },
      })
    : null;
  const session = await db.prisma.mediaUploadSession.create({
    data: {
      id: randomUUID(),
      deviceId,
      customerId,
      mediaType: 'IMAGE',
      fileName: 'capture.jpg',
      sizeBytes: historicalBytes ? null : jpeg.length,
      sizeKb: Math.ceil(jpeg.length / 1024),
      declaredSha256: hash,
      triggerId: trigger?.id ?? null,
      status: 'ISSUED',
      createdAt: now(),
      presignedUrlExpiresAt: new Date(clock + 900000),
    },
  });
  const objectPath = `media/${customerId}/${deviceId}/${session.id}/capture.jpg`;
  let body: Buffer | null = jpeg;
  let afterHash: (() => Promise<void>) | undefined;
  let transactionDepth = 0;
  const locks: string[] = [];
  const client = new Proxy(db.prisma, {
    get(target, key) {
      if (key === '$transaction')
        return async (work: (tx: DbClient) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            transactionDepth++;
            const traced = new Proxy(tx, {
              get(inner, method) {
                if (method === '$queryRawUnsafe')
                  return async (sql: string, ...args: unknown[]) => {
                    locks.push(sql);
                    return inner.$queryRawUnsafe(sql, ...args);
                  };
                return Reflect.get(inner, method);
              },
            });
            try {
              return await work(traced);
            } finally {
              transactionDepth--;
            }
          });
      return Reflect.get(target, key);
    },
  }) as PrismaClient;
  const storage = {
    statObject: vi.fn(async () => {
      expect(transactionDepth).toBe(0);
      return body ? { sizeBytes: body.length } : null;
    }),
    computeSha256: vi.fn(async () => {
      expect(transactionDepth).toBe(0);
      const actual = body ? createHash('sha256').update(body).digest('hex') : null;
      await afterHash?.();
      return actual;
    }),
  };
  const deps = {
    client,
    storage,
    now,
    uploadPolicy: {
      getMediaTypes: () => ['IMAGE', 'VIDEO'],
      getMaxSizeKb: () => 10240,
      getDailyUploadQuotaPerDevice: () => 100,
      getUploadUrlTtlSeconds: () => 900,
      getDownloadUrlTtlSeconds: () => 900,
    },
  };
  const payload = {
    meta: { id: `MED-${suffix}`, ts: now().toISOString(), seq: 1 },
    data: {
      mediaType: 'IMAGE',
      captureTime: now().toISOString(),
      fileName: 'capture.jpg',
      sizeKb: session.sizeKb,
      objectPath,
    },
  };
  const message = (seq = 1, sourceId = payload.meta.id, patch: Record<string, unknown> = {}): ValidatedMessage => {
    const normalized = { meta: { ...payload.meta, seq, id: sourceId }, data: { ...payload.data, ...patch } };
    return {
      envelope: {
        iotTopic: `bnx/device/${deviceId}/media`,
        iotDeviceId: deviceId,
        iotType: 'media',
        iotReceivedAt: clock,
        iotPrincipal: `arn:aws:iot:local:000000000000:cert/${certId}`,
        payload: normalized,
      },
      device: {
        deviceId,
        customerId,
        siteId: null,
        lifecycleStatus: 'Active',
        certificateId: certId,
        certificateFingerprint: suffix,
      },
      normalizedPayload: normalized,
      rawPayload: normalized,
      rawBody: JSON.stringify(normalized),
      messageId: sourceId,
      occurredAt: normalized.meta.ts,
      data: normalized.data,
      audit: null,
    };
  };
  const run = (msg = message()) => createMediaHandler(deps)(msg);
  const counts = async () => ({
    media: await db.prisma.mediaObject.count({ where: { deviceId } }),
    evidence: await db.prisma.mediaEvidence.count({ where: { deviceId } }),
    receipts: await db.prisma.ingestionReceipt.count({ where: { deviceId } }),
    outbox: await db.prisma.outboxEvent.count({
      where: { eventType: MEDIA_EVIDENCE_REGISTERED, payload: { path: ['deviceId'], equals: deviceId } },
    }),
    audits: await db.prisma.auditLog.count({ where: { action: 'media.object.register', actorId: deviceId } }),
    session: (await db.prisma.mediaUploadSession.findUniqueOrThrow({ where: { id: session.id } })).status,
  });
  return {
    deviceId,
    customerId,
    certId,
    trigger,
    session,
    deps,
    message,
    run,
    counts,
    storage,
    locks,
    advance: (ms: number) => {
      clock += ms;
    },
    setBody: (value: Buffer | null) => {
      body = value;
    },
    afterHash: (fn: () => Promise<void>) => {
      afterHash = fn;
    },
  };
}
const empty = { media: 0, evidence: 0, receipts: 0, outbox: 0, audits: 0, session: 'ISSUED' };

describe('IMG-11 atomic image registration', () => {
  test.each(['ALARM', 'EVENT'] as const)(
    '%s creates all five durable facts and one audit, with fixed PENDING deadline',
    async (kind) => {
      const f = await fixture(kind);
      expect(await f.run()).toEqual({ handled: true });
      expect(await f.counts()).toEqual({
        media: 1,
        evidence: 1,
        receipts: 1,
        outbox: 1,
        audits: 1,
        session: 'COMPLETED',
      });
      const e = await db.prisma.mediaEvidence.findUniqueOrThrow({ where: { triggerId: f.trigger!.id } });
      expect(e).toMatchObject({
        status: 'PENDING',
        kind,
        customerId: f.customerId,
        deviceId: f.deviceId,
        messageId: f.trigger!.messageId,
        alarmId: null,
        eventId: null,
        attemptCount: 0,
        failureReason: null,
      });
      expect(e.deadlineAt.getTime() - e.registeredAt.getTime()).toBe(86400000);
      expect(e.nextAttemptAt).toEqual(e.registeredAt);
      const o = await db.prisma.outboxEvent.findUniqueOrThrow({
        where: { idempotencyKey: evidenceOutboxKey(f.trigger!.id) },
      });
      expect(o).toMatchObject({
        eventType: MEDIA_EVIDENCE_REGISTERED,
        aggregateType: 'media_evidence',
        aggregateId: e.id,
        status: 'PENDING',
        retryCount: 0,
      });
      expect(o.payload).toEqual({
        schemaVersion: 1,
        evidenceId: e.id,
        triggerId: f.trigger!.id,
        mediaId: e.mediaId,
        customerId: f.customerId,
        deviceId: f.deviceId,
        triggerRef: { kind, messageId: f.trigger!.messageId },
        registeredAt: e.registeredAt.toISOString(),
        deadlineAt: e.deadlineAt.toISOString(),
      });
      const receipt = await db.prisma.ingestionReceipt.findUniqueOrThrow({
        where: { idempotencyKey: `${f.deviceId}:media:1` },
      });
      expect(receipt.customerId).toBe(f.customerId);
      const ordered = f.locks.filter((sql) => /FROM (devices|media_triggers|media_upload_sessions) WHERE/.test(sql));
      expect(ordered).toEqual([
        'SELECT id FROM devices WHERE id = $1 FOR UPDATE',
        'SELECT id FROM media_triggers WHERE id = $1 FOR NO KEY UPDATE',
        'SELECT id FROM media_upload_sessions WHERE id = $1 FOR UPDATE',
      ]);
    },
  );

  test('concurrent duplicate MQTT registers once; exact receipt replay skips unavailable S3 after expiry', async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 6 }, () => f.run()));
    const first = await f.counts();
    expect(first).toEqual({ media: 1, evidence: 1, receipts: 1, outbox: 1, audits: 1, session: 'COMPLETED' });
    f.setBody(null);
    f.advance(86400001);
    f.storage.statObject.mockClear();
    f.storage.computeSha256.mockClear();
    await f.run();
    expect(f.storage.statObject).not.toHaveBeenCalled();
    expect(f.storage.computeSha256).not.toHaveBeenCalled();
    expect(await f.counts()).toEqual(first);
  });

  test('a concurrent receipt commit wins even if this preflight observed an unavailable object', async () => {
    const f = await fixture();
    f.storage.statObject.mockImplementationOnce(async () => {
      await f.run();
      return null;
    });
    await f.run();
    expect(await f.counts()).toEqual({
      media: 1,
      evidence: 1,
      receipts: 1,
      outbox: 1,
      audits: 1,
      session: 'COMPLETED',
    });
  });

  test('new seq and new messageId for same immutable media replay, with unchanged evidence/deadline/outbox', async () => {
    const f = await fixture();
    await f.run();
    const before = await db.prisma.mediaEvidence.findUniqueOrThrow({ where: { triggerId: f.trigger!.id } });
    await db.prisma.mediaObject.update({ where: { id: before.mediaId }, data: { status: 'DELETED' } });
    f.setBody(null);
    f.advance(900001);
    f.storage.statObject.mockClear();
    await f.run(f.message(2));
    await f.run(f.message(3, 'MED-new-delivery'));
    expect(await f.counts()).toEqual({
      media: 1,
      evidence: 1,
      receipts: 3,
      outbox: 1,
      audits: 1,
      session: 'COMPLETED',
    });
    expect(await db.prisma.mediaEvidence.findUnique({ where: { id: before.id } })).toEqual(before);
    expect(f.storage.statObject).not.toHaveBeenCalled();
  });

  test('same receipt different payload is PAYLOAD_CONFLICT; new receipt modified metadata is rejected', async () => {
    const f = await fixture();
    await f.run();
    await expect(f.run(f.message(1, undefined, { captureTime: '2026-11-06T08:00:01Z' }))).rejects.toMatchObject({
      errorType: 'PAYLOAD_CONFLICT',
    });
    await expect(f.run(f.message(2, undefined, { captureTime: '2026-11-06T08:00:01Z' }))).rejects.toMatchObject({
      errorType: 'MEDIA_METADATA_REJECTED',
    });
    expect((await f.counts()).receipts).toBe(1);
  });

  test.each(['bytes', 'hash', 'missing'] as const)(
    'reject %s before registration; exact bytes distinguish equal ceil KB',
    async (mode) => {
      const f = await fixture();
      f.setBody(
        mode === 'missing'
          ? null
          : mode === 'bytes'
            ? Buffer.concat([jpeg, Buffer.from([0])])
            : Buffer.alloc(jpeg.length, 7),
      );
      if (mode === 'bytes') expect(Math.ceil((jpeg.length + 1) / 1024)).toBe(f.session.sizeKb);
      await expect(f.run()).rejects.toBeInstanceOf(IngestError);
      expect(await f.counts()).toEqual(empty);
    },
  );

  test.each(['revoked', 'rotation', 'suspended', 'retired', 'tenant', 'expired'] as const)(
    'revalidate %s after object I/O and before any durable fact',
    async (mode) => {
      const f = await fixture();
      f.afterHash(async () => {
        if (mode === 'expired') f.advance(900001);
        else if (mode === 'rotation')
          await db.prisma.deviceCertificate.update({
            where: { id: f.certId },
            data: { rotationDeadlineAt: f.deps.now(), rotationConfirmedAt: null },
          });
        else if (mode === 'revoked')
          await db.prisma.deviceCertificate.update({
            where: { id: f.certId },
            data: { status: 'REVOKED', revokedAt: f.deps.now() },
          });
        else if (mode === 'tenant') {
          const other = await db.prisma.customer.create({ data: { name: randomUUID() } });
          await db.prisma.device.update({ where: { id: f.deviceId }, data: { customerId: other.id } });
        } else
          await db.prisma.device.update({
            where: { id: f.deviceId },
            data: { lifecycleStatus: mode === 'retired' ? 'Retired' : 'Suspended' },
          });
      });
      await expect(f.run()).rejects.toBeInstanceOf(IngestError);
      expect(await f.counts()).toEqual(empty);
    },
  );

  test.each([false, true])(
    'legacy unbound session (historical NULL bytes=%s) registers without guessing evidence',
    async (historicalBytes) => {
      const f = await fixture(null, historicalBytes);
      await f.run();
      expect(await f.counts()).toEqual({
        media: 1,
        evidence: 0,
        receipts: 1,
        outbox: 0,
        audits: 1,
        session: 'COMPLETED',
      });
      expect((await db.prisma.mediaUploadSession.findUniqueOrThrow({ where: { id: f.session.id } })).sizeBytes).toBe(
        historicalBytes ? null : jpeg.length,
      );
    },
  );

  test('receipt attribution from an old tenant cannot be committed alongside current-tenant media', async () => {
    const f = await fixture();
    const previous = await db.prisma.customer.create({ data: { name: randomUUID() } });
    const site = await db.prisma.site.create({ data: { customerId: previous.id, name: 'previous' } });
    await db.prisma.device.update({ where: { id: f.deviceId }, data: { customerId: previous.id } });
    await db.prisma.deviceAssignment.create({
      data: {
        deviceId: f.deviceId,
        customerId: previous.id,
        siteId: site.id,
        assignedBy: 'fixture',
        assignedAt: new Date('2026-01-01Z'),
        endedAt: new Date('2026-11-06T08:00:01Z'),
        status: 'ENDED',
      },
    });
    await db.prisma.device.update({ where: { id: f.deviceId }, data: { customerId: f.customerId } });
    f.advance(2000);
    await expect(f.run()).rejects.toMatchObject({ errorType: 'MEDIA_METADATA_REJECTED' });
    expect(await f.counts()).toEqual(empty);
  });

  test('pre-IMG11 completed trigger media without Evidence fails closed, without inventing a new 24-hour window', async () => {
    const f = await fixture();
    const msg = f.message();
    await db.prisma.mediaUploadSession.update({
      where: { id: f.session.id },
      data: { status: 'COMPLETED', completedAt: f.deps.now() },
    });
    await db.prisma.mediaObject.create({
      data: {
        deviceId: f.deviceId,
        customerId: f.customerId,
        uploadSessionId: f.session.id,
        mediaType: 'IMAGE',
        fileName: f.session.fileName,
        sizeKb: f.session.sizeKb,
        sha256: hash,
        objectPath: String(msg.data.objectPath),
        captureTime: new Date(String(msg.data.captureTime)),
        sourceMessageId: msg.messageId,
      },
    });
    await expect(f.run(msg)).rejects.toMatchObject({
      errorType: 'MEDIA_METADATA_REJECTED',
      message: expect.stringContaining('REGISTRATION_INCOMPLETE'),
    });
    expect(await f.counts()).toEqual({ ...empty, media: 1, session: 'COMPLETED' });
  });

  test('two devices using same global source message ID cannot steal an idempotent result', async () => {
    const a = await fixture(),
      b = await fixture();
    const results = await Promise.allSettled([
      a.run(a.message(1, 'MED-global-collision')),
      b.run(b.message(1, 'MED-global-collision')),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const counts = [await a.counts(), await b.counts()];
    expect(counts.map((c) => c.media).sort()).toEqual([0, 1]);
    expect(counts.find((c) => c.media === 0)).toEqual(empty);
  });

  test.each(['media_objects', 'media_evidence', 'outbox_events', 'audit_logs', 'ingestion_receipts'])(
    'failure at %s rolls back session/media/evidence/receipt/outbox/audit; retry succeeds',
    async (table) => {
      const f = await fixture();
      await db.pg
        .exec(`CREATE FUNCTION img11_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMG11_INJECTED'; END $$;
        CREATE TRIGGER img11_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION img11_fail();`);
      try {
        await expect(f.run()).rejects.toThrow();
        expect(await f.counts()).toEqual(empty);
      } finally {
        await db.pg.exec(`DROP TRIGGER img11_fail ON ${table}; DROP FUNCTION img11_fail();`);
      }
      await f.run();
      expect(await f.counts()).toEqual({
        media: 1,
        evidence: 1,
        receipts: 1,
        outbox: 1,
        audits: 1,
        session: 'COMPLETED',
      });
    },
  );

  test('failure after business writes during gap detection also rolls back all five facts', async () => {
    const f = await fixture();
    await db.prisma.ingestionReceipt.create({
      data: {
        idempotencyKey: `${f.deviceId}:media:1`,
        deviceId: f.deviceId,
        topicType: 'media',
        seq: 1,
        payloadHash: 'earlier',
        result: 'PROCESSED',
      },
    });
    await db.pg
      .exec(`CREATE FUNCTION img11_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMG11_GAP'; END $$;
      CREATE TRIGGER img11_fail BEFORE INSERT ON ingestion_gaps FOR EACH ROW EXECUTE FUNCTION img11_fail();`);
    try {
      await expect(f.run(f.message(3))).rejects.toThrow();
      expect(await f.counts()).toEqual({ ...empty, receipts: 1 });
    } finally {
      await db.pg.exec('DROP TRIGGER img11_fail ON ingestion_gaps; DROP FUNCTION img11_fail();');
    }
    await f.run(f.message(3));
    expect((await f.counts()).receipts).toBe(2);
  });
  test('new evidence events use existing durable leased Outbox retry and are isolated from ARCHIVE', async () => {
    const f = await fixture();
    await f.run();
    const archiveSend = vi.fn();
    expect(
      (await createOutboxPublisher({ client: db.prisma, sender: { send: archiveSend } }).publishPendingBatch()).claimed,
    ).toBe(0);
    expect(archiveSend).not.toHaveBeenCalled();
    const send = vi.fn().mockRejectedValueOnce(new Error('LOCAL_SEND_FAILURE')).mockResolvedValue(undefined);
    const publisher = createLeasedOutboxPublisher({
      client: db.prisma,
      eventTypes: [MEDIA_EVIDENCE_REGISTERED],
      send,
      now: f.deps.now,
    });
    const first = await publisher.publishPendingBatch();
    expect(first.retried).toBe(1);
    expect(first.failed).toBe(0);
    const retry = await publisher.publishPendingBatch();
    expect(retry).toEqual({ claimed: 1, published: 1, retried: 0, failed: 0 });
    expect((await publisher.publishPendingBatch()).claimed).toBe(0);
    const own = await db.prisma.outboxEvent.findUniqueOrThrow({
      where: { idempotencyKey: evidenceOutboxKey(f.trigger!.id) },
    });
    expect(own.status).toBe('PUBLISHED');
    expect((await db.prisma.mediaEvidence.findUniqueOrThrow({ where: { triggerId: f.trigger!.id } })).status).toBe(
      'PENDING',
    );
  });
});
