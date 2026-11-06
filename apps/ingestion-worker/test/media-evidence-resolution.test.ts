/** IMG-12: migrated PostgreSQL/PGlite; real signal handlers and registration, no AWS calls. */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { evidenceOutboxKey, handleMediaMetadata, resolveMediaEvidence } from '@fdp/media';
import { createTestDb } from '../../cloud-api/test/helpers.js';
import { createMediaHandler } from '../src/media/handler.js';
import { createAlarmHandler } from '../src/signals/alarm.js';
import { createEventHandler } from '../src/signals/event.js';
import {
  consumeMediaEvidenceOutbox,
  runMediaEvidenceWorker,
  scanPendingMediaEvidence,
} from '../src/media/evidence-worker.js';
import type { ValidatedMessage } from '../src/ingest/pipeline.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 60000);
afterAll(async () => {
  await db?.prisma.$disconnect();
  await db?.pg.close();
});
const bytes = Buffer.from('IMG12-local-object'),
  hash = createHash('sha256').update(bytes).digest('hex');
const policy = {
  getMediaTypes: () => ['IMAGE', 'VIDEO'],
  getMaxSizeKb: () => 10240,
  getDailyUploadQuotaPerDevice: () => 100,
  getUploadUrlTtlSeconds: () => 900,
  getDownloadUrlTtlSeconds: () => 900,
};
async function fixture(existingCustomerId?: string) {
  const suffix = randomUUID(),
    customerId = existingCustomerId ?? `c-${suffix}`,
    deviceId = `d-${suffix}`,
    certificateId = `cert-${suffix}`;
  if (!existingCustomerId) await db.prisma.customer.create({ data: { id: customerId, name: suffix } });
  await db.prisma.device.create({
    data: {
      id: deviceId,
      customerId,
      serialNumber: suffix,
      model: 'M',
      hardwareVersion: '1',
      manufacturer: 'B',
      manufactureDate: new Date('2026-01-01Z'),
      lifecycleStatus: 'Active',
    },
  });
  await db.prisma.deviceCertificate.create({
    data: {
      id: certificateId,
      deviceId,
      fingerprint: suffix,
      status: 'ACTIVE',
      notBefore: new Date('2026-01-01Z'),
      notAfter: new Date('2027-01-01Z'),
    },
  });
  let clock = Date.parse('2026-11-06T09:00:00Z'),
    seq = 0;
  const now = () => new Date(clock),
    deps = { client: db.prisma, now };
  const mediaDeps = {
    ...deps,
    storage: { statObject: async () => ({ sizeBytes: bytes.length }), computeSha256: async () => hash },
    uploadPolicy: policy,
  };
  const message = (type: string, id: string, data: Record<string, unknown>): ValidatedMessage => {
    const payload = { meta: { id, ts: now().toISOString(), seq: ++seq }, data };
    return {
      envelope: {
        iotTopic: `bnx/device/${deviceId}/${type}`,
        iotDeviceId: deviceId,
        iotType: type,
        iotReceivedAt: clock,
        iotPrincipal: `arn:aws:iot:local:0:cert/${certificateId}`,
        payload,
      },
      device: {
        deviceId,
        customerId,
        certificateId,
        certificateFingerprint: suffix,
        lifecycleStatus: 'Active',
        siteId: null,
      },
      messageId: id,
      occurredAt: now().toISOString(),
      data,
      audit: null,
      normalizedPayload: payload,
      rawPayload: payload,
      rawBody: JSON.stringify(payload),
    };
  };
  const upload = async (kind: 'EVENT' | 'ALARM' = 'EVENT', sourceId = `SRC-${randomUUID()}`) => {
    const trigger = await db.prisma.mediaTrigger.create({
      data: {
        deviceId,
        customerId,
        kind,
        messageId: sourceId,
        mediaType: 'IMAGE',
        fileName: 'capture.jpg',
        sizeBytes: bytes.length,
        sizeKb: 1,
        sha256Normalized: hash,
        createdAt: now(),
      },
    });
    const session = await db.prisma.mediaUploadSession.create({
      data: {
        id: randomUUID(),
        deviceId,
        customerId,
        triggerId: trigger.id,
        mediaType: 'IMAGE',
        fileName: 'capture.jpg',
        sizeBytes: bytes.length,
        sizeKb: 1,
        declaredSha256: hash,
        createdAt: now(),
        presignedUrlExpiresAt: new Date(clock + 900000),
      },
    });
    const msg = message('media', `MED-${randomUUID()}`, {
      mediaType: 'IMAGE',
      captureTime: now().toISOString(),
      fileName: 'capture.jpg',
      objectPath: `media/${customerId}/${deviceId}/${session.id}/capture.jpg`,
      sizeKb: 1,
    });
    return { trigger, session, msg };
  };
  const register = async (kind: 'EVENT' | 'ALARM' = 'EVENT', sourceId?: string) => {
    const pending = await upload(kind, sourceId);
    const result = await handleMediaMetadata(mediaDeps, deviceId, pending.msg.normalizedPayload as never);
    expect(result.applied).toBe(true);
    return db.prisma.mediaEvidence.findUniqueOrThrow({ where: { mediaId: result.mediaId! } });
  };
  const source = async (kind: 'EVENT' | 'ALARM', sourceId: string) => {
    if (kind === 'EVENT') {
      await createEventHandler(deps)(message('event', sourceId, { eventType: 'START', source: 'DEVICE' }));
      return db.prisma.deviceEvent.findUniqueOrThrow({ where: { sourceMessageId: sourceId } });
    }
    await createAlarmHandler(deps)(
      message('alarm', sourceId, {
        code: 'SAME_CODE',
        status: 'ACTIVE',
        category: 'MACHINE',
        severity: 'WARNING',
        detectedTime: now().toISOString(),
      }),
    );
    return db.prisma.alarm.findUniqueOrThrow({ where: { sourceMessageId: sourceId } });
  };
  const clear = async (sourceId: string) =>
    createAlarmHandler(deps)(
      message('alarm', sourceId, { code: 'SAME_CODE', status: 'CLEARED', detectedTime: now().toISOString() }),
    );
  const get = (id: string) => db.prisma.mediaEvidence.findUniqueOrThrow({ where: { id } });
  return {
    deviceId,
    customerId,
    message,
    deps,
    mediaDeps,
    now,
    upload,
    register,
    source,
    clear,
    get,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('IMG-12 precise source and immutable terminal state', () => {
  test.each(['EVENT', 'ALARM'] as const)(
    '%s: source-first links immediately after registration transaction commits',
    async (kind) => {
      const f = await fixture(),
        sourceId = `SRC-${randomUUID()}`;
      const source = await f.source(kind, sourceId),
        pending = await f.upload(kind, sourceId);
      await createMediaHandler(f.mediaDeps)(pending.msg);
      const e = await db.prisma.mediaEvidence.findUniqueOrThrow({ where: { triggerId: pending.trigger.id } });
      expect(e).toMatchObject({
        status: 'LINKED',
        attemptCount: 1,
        failureReason: null,
        nextAttemptAt: null,
        alarmId: kind === 'ALARM' ? source.id : null,
        eventId: kind === 'EVENT' ? source.id : null,
      });
      expect(await db.prisma.ingestionReceipt.count({ where: { deviceId: f.deviceId, topicType: 'media' } })).toBe(1);
    },
  );
  test.each(['EVENT', 'ALARM'] as const)(
    '%s: image-first retries after source arrives, without extending deadline',
    async (kind) => {
      const f = await fixture(),
        e = await f.register(kind);
      expect(await resolveMediaEvidence(f.deps, e.id)).toBe('PENDING');
      const first = await f.get(e.id);
      expect(first.attemptCount).toBe(1);
      expect(first.nextAttemptAt?.getTime()).toBe(e.registeredAt.getTime() + 60000);
      await f.source(kind, e.messageId);
      expect(await resolveMediaEvidence(f.deps, e.id)).toBe('NOT_DUE');
      f.advance(60000);
      expect(await resolveMediaEvidence(f.deps, e.id)).toBe('LINKED');
      const linked = await f.get(e.id);
      expect(linked.attemptCount).toBe(2);
      expect(linked.deadlineAt).toEqual(e.deadlineAt);
      await Promise.all(Array.from({ length: 6 }, () => resolveMediaEvidence(f.deps, e.id)));
      expect(await f.get(e.id)).toEqual(linked);
    },
  );
  test('cleared original ACTIVE links; a reference to the CLEARED message is terminal UNMATCHED', async () => {
    const f = await fixture(),
      original = `ALM-${randomUUID()}`,
      clearId = `CLR-${randomUUID()}`;
    const alarm = await f.source('ALARM', original);
    await f.clear(clearId);
    expect((await db.prisma.alarm.findUniqueOrThrow({ where: { id: alarm.id } })).status).toBe('CLEARED');
    const activeRef = await f.register('ALARM', original),
      clearRef = await f.register('ALARM', clearId);
    expect(await resolveMediaEvidence(f.deps, activeRef.id)).toBe('LINKED');
    expect((await f.get(activeRef.id)).alarmId).toBe(alarm.id);
    expect(await resolveMediaEvidence(f.deps, clearRef.id)).toBe('UNMATCHED');
    expect(await f.get(clearRef.id)).toMatchObject({
      failureReason: 'CLEARED_MESSAGE_REFERENCE',
      alarmId: null,
      eventId: null,
      nextAttemptAt: null,
    });
  });
  test.each(['EVENT', 'ALARM'] as const)('%s duplicate MQTT never recreates its source or evidence', async (kind) => {
    const f = await fixture(),
      sourceId = `SRC-${randomUUID()}`;
    const msg = f.message(
      kind === 'EVENT' ? 'event' : 'alarm',
      sourceId,
      kind === 'EVENT'
        ? { eventType: 'START' }
        : { code: 'SAME_CODE', status: 'ACTIVE', category: 'MACHINE', severity: 'WARNING' },
    );
    const handler = kind === 'EVENT' ? createEventHandler(f.deps) : createAlarmHandler(f.deps);
    await handler(msg);
    if (kind === 'ALARM') await f.clear(`CLR-${randomUUID()}`);
    expect((await handler(msg)).outcome).toBe('DUPLICATE_SKIPPED');
    const e = await f.register(kind, sourceId);
    await resolveMediaEvidence(f.deps, e.id);
    const linked = await f.get(e.id);
    await handler(msg);
    await resolveMediaEvidence(f.deps, e.id);
    expect(await f.get(e.id)).toEqual(linked);
    if (kind === 'ALARM')
      expect((await db.prisma.alarm.findUniqueOrThrow({ where: { sourceMessageId: sourceId } })).status).toBe(
        'CLEARED',
      );
  });
  test('known CLEARED from another scope cannot bind or reveal its target', async () => {
    const f = await fixture(),
      other = await fixture(),
      e = await f.register('ALARM');
    await other.clear(e.messageId);
    expect(await resolveMediaEvidence(f.deps, e.id)).toBe('UNMATCHED');
    expect(await f.get(e.id)).toMatchObject({ failureReason: 'SOURCE_SCOPE_MISMATCH', alarmId: null });
  });
  test('CLEARED lookup uses its partial expression index', async () => {
    const plan = await db.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN (COSTS OFF)
        SELECT payload->>'customerId' FROM outbox_events WHERE event_type = 'ARCHIVE'
          AND payload->>'topicType' = 'alarm' AND payload->'columns'->>'status' = 'CLEARED'
          AND payload->>'messageId' = $1`,
        'no-such-message',
      );
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('outbox_alarm_cleared_source_idx');
  });

  test('late clear is detected on retry; same-code nearby alarms never exchange evidence', async () => {
    const f = await fixture(),
      e = await f.register('ALARM');
    await resolveMediaEvidence(f.deps, e.id);
    await f.clear(e.messageId);
    f.advance(60000);
    expect(await resolveMediaEvidence(f.deps, e.id)).toBe('UNMATCHED');
    const a = `ALM-${randomUUID()}`,
      b = `ALM-${randomUUID()}`;
    const first = await f.source('ALARM', a),
      second = await f.source('ALARM', b);
    await f.clear(`CLR-${randomUUID()}`);
    const eb = await f.register('ALARM', b),
      ea = await f.register('ALARM', a);
    await resolveMediaEvidence(f.deps, eb.id);
    await resolveMediaEvidence(f.deps, ea.id);
    expect((await f.get(eb.id)).alarmId).toBe(second.id);
    expect((await f.get(ea.id)).alarmId).toBe(first.id);
  });
  test.each([true, false])(
    'foreign device source (same tenant=%s) is UNMATCHED without target IDs',
    async (sameTenant) => {
      const f = await fixture(),
        other = await fixture(sameTenant ? f.customerId : undefined);
      const e = await f.register();
      await other.source('EVENT', e.messageId);
      expect(await resolveMediaEvidence(f.deps, e.id)).toBe('UNMATCHED');
      expect(await f.get(e.id)).toMatchObject({ failureReason: 'SOURCE_SCOPE_MISMATCH', alarmId: null, eventId: null });
    },
  );
  test('same device/new tenant source cannot link an old-tenant image', async () => {
    const f = await fixture(),
      e = await f.register();
    const customer = await db.prisma.customer.create({ data: { name: randomUUID() } });
    await db.prisma.device.update({ where: { id: f.deviceId }, data: { customerId: customer.id } });
    await db.prisma.deviceEvent.create({
      data: {
        deviceId: f.deviceId,
        customerId: customer.id,
        eventType: 'START',
        sourceMessageId: e.messageId,
        occurredAt: f.now(),
      },
    });
    expect(await resolveMediaEvidence(f.deps, e.id)).toBe('UNMATCHED');
    expect((await f.get(e.id)).failureReason).toBe('SOURCE_SCOPE_MISMATCH');
  });
  test('subsequent assignment change does not move or block an original historical link', async () => {
    const f = await fixture(),
      e = await f.register(),
      source = await f.source('EVENT', e.messageId);
    const customer = await db.prisma.customer.create({ data: { name: randomUUID() } });
    await db.prisma.device.update({ where: { id: f.deviceId }, data: { customerId: customer.id } });
    await db.prisma.mediaObject.update({ where: { id: e.mediaId }, data: { status: 'DELETED' } });
    expect(await resolveMediaEvidence(f.deps, e.id)).toBe('LINKED');
    expect(await f.get(e.id)).toMatchObject({ customerId: f.customerId, eventId: source.id });
  });
  test('case and kind are exact; similar code/time or opposite-kind records are never guessed', async () => {
    const f = await fixture(),
      sourceId = `SRC-AbC-${randomUUID()}`;
    await f.source('EVENT', sourceId);
    const wrongCase = await f.register('EVENT', sourceId.toLowerCase()),
      wrongKind = await f.register('ALARM', sourceId);
    expect(await resolveMediaEvidence(f.deps, wrongCase.id)).toBe('PENDING');
    expect(await resolveMediaEvidence(f.deps, wrongKind.id)).toBe('PENDING');
  });
  test.each([false, true])(
    'deadline is inclusive: target present=%s still times out at exactly 24 hours',
    async (targetPresent) => {
      const f = await fixture(),
        e = await f.register();
      if (targetPresent) await f.source('EVENT', e.messageId);
      f.advance(86400000);
      expect(await resolveMediaEvidence(f.deps, e.id)).toBe('UNMATCHED');
      const terminal = await f.get(e.id);
      expect(terminal).toMatchObject({
        failureReason: 'SOURCE_TIMEOUT',
        alarmId: null,
        eventId: null,
        nextAttemptAt: null,
      });
      if (!targetPresent) await f.source('EVENT', e.messageId);
      f.advance(60000);
      expect(await resolveMediaEvidence(f.deps, e.id)).toBe('TERMINAL');
      expect(await f.get(e.id)).toEqual(terminal);
    },
  );
  test('read/lock delay crossing deadline prevents a late LINKED commit', async () => {
    const f = await fixture(),
      e = await f.register();
    await f.source('EVENT', e.messageId);
    f.advance(86399999);
    let reads = 0;
    expect(await resolveMediaEvidence({ ...f.deps, now: () => new Date(f.now().getTime() + reads++) }, e.id)).toBe(
      'UNMATCHED',
    );
    expect((await f.get(e.id)).failureReason).toBe('SOURCE_TIMEOUT');
  });
  test.each([false, true])('parallel resolver attempts (source present=%s) mutate once', async (present) => {
    const f = await fixture(),
      e = await f.register();
    if (present) await f.source('EVENT', e.messageId);
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => resolveMediaEvidence(f.deps, e.id)));
    expect(outcomes.filter((o) => o === (present ? 'LINKED' : 'PENDING'))).toHaveLength(1);
    expect((await f.get(e.id)).attemptCount).toBe(1);
  });
});

describe('IMG-12 durable routing and bounded scan', () => {
  test('Outbox dispatch ignores supplied scope, re-reads its durable identity and tolerates replay', async () => {
    const f = await fixture(),
      e = await f.register();
    await f.source('EVENT', e.messageId);
    const row = await db.prisma.outboxEvent.findUniqueOrThrow({
      where: { idempotencyKey: evidenceOutboxKey(e.triggerId) },
    });
    await consumeMediaEvidenceOutbox(f.deps, {
      ...row,
      aggregateId: 'forged',
      payload: { customerId: 'other', evidenceId: 'other' },
    });
    const linked = await f.get(e.id);
    expect(linked.status).toBe('LINKED');
    await consumeMediaEvidenceOutbox(f.deps, row);
    expect(await f.get(e.id)).toEqual(linked);
    await expect(consumeMediaEvidenceOutbox(f.deps, { ...row, id: randomUUID() })).rejects.toThrow(
      'INVALID_MEDIA_EVIDENCE_EVENT',
    );
  });
  test('minute worker consumes only evidence, advances scan, and repeated scheduling is idempotent', async () => {
    const f = await fixture(),
      e = await f.register();
    await f.source('EVENT', e.messageId);
    const result = await runMediaEvidenceWorker(f.deps);
    expect(result.outbox.failed).toBe(0);
    expect(result.scan.failed).toBe(0);
    const outbox = await db.prisma.outboxEvent.findUniqueOrThrow({
      where: { idempotencyKey: evidenceOutboxKey(e.triggerId) },
    });
    expect(outbox.status).toBe('PUBLISHED');
    expect((await f.get(e.id)).status).toBe('LINKED');
    const before = await f.get(e.id);
    await db.prisma.outboxEvent.update({ where: { id: outbox.id }, data: { status: 'PENDING' } }); // Lost send acknowledgement.
    await runMediaEvidenceWorker(f.deps);
    expect(await f.get(e.id)).toEqual(before);
    expect(
      await db.prisma.outboxEvent.count({
        where: { eventType: 'ARCHIVE', aggregateId: f.deviceId, status: 'PENDING' },
      }),
    ).toBe(1);
  });
  test('Outbox time budget reserves scanner progress even when event delivery has backlog', async () => {
    const f = await fixture(),
      e = await f.register();
    await f.source('EVENT', e.messageId);
    let reads = 0;
    const result = await runMediaEvidenceWorker(f.deps, { clock: () => (reads++ === 0 ? 0 : 15000) });
    expect(result.outbox.claimed).toBe(0);
    expect((await f.get(e.id)).status).toBe('LINKED');
    expect(
      (await db.prisma.outboxEvent.findUniqueOrThrow({ where: { idempotencyKey: evidenceOutboxKey(e.triggerId) } }))
        .status,
    ).toBe('PENDING');
  });

  test('corrupt durable event retries safely; the scan remains an independent recovery path', async () => {
    const f = await fixture(),
      e = await f.register();
    await f.source('EVENT', e.messageId);
    const row = await db.prisma.outboxEvent.findUniqueOrThrow({
      where: { idempotencyKey: evidenceOutboxKey(e.triggerId) },
    });
    await db.prisma.outboxEvent.update({
      where: { id: row.id },
      data: { payload: { schemaVersion: 99, evidenceId: e.id } },
    });
    const result = await runMediaEvidenceWorker(f.deps);
    expect(result.outbox.retried).toBeGreaterThanOrEqual(1);
    expect((await f.get(e.id)).status).toBe('LINKED');
    const failed = await db.prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(failed).toMatchObject({
      status: 'PENDING',
      retryCount: 1,
      leaseToken: null,
      lastError: 'INVALID_MEDIA_EVIDENCE_EVENT',
    });
  });
  test('keyset pages progress through equal due times and stop at the hard page limit', async () => {
    const f = await fixture();
    const entries = [];
    for (let i = 0; i < 8; i++) entries.push(await f.register());
    // Scope the scanner client to this test's Evidence, retaining its actual predicate and ordering.
    const originalFind = db.prisma.mediaEvidence.findMany.bind(db.prisma.mediaEvidence);
    const client = new Proxy(db.prisma, {
      get(target, key) {
        if (key === 'mediaEvidence')
          return new Proxy(target.mediaEvidence, {
            get(delegate, op) {
              if (op === 'findMany')
                return (args: Parameters<typeof originalFind>[0]) =>
                  originalFind({ ...args, where: { AND: [args?.where ?? {}, { deviceId: f.deviceId }] } });
              return Reflect.get(delegate, op);
            },
          });
        return Reflect.get(target, key);
      },
    });
    const first = await scanPendingMediaEvidence({ ...f.deps, client }, { pageSize: 2, maxPages: 2 });
    expect(first).toMatchObject({ pages: 2, visited: 4, pending: 4, failed: 0, stop: 'BUDGET' });
    const second = await scanPendingMediaEvidence({ ...f.deps, client }, { pageSize: 3, maxPages: 2 });
    expect(second).toMatchObject({ visited: 4, pending: 4, failed: 0, stop: 'IDLE' });
    for (const e of entries) expect((await f.get(e.id)).attemptCount).toBe(1);
    expect((await scanPendingMediaEvidence({ ...f.deps, client })).visited).toBe(0);
  });
  test('stale Outbox and concurrent scans cannot create duplicate associations', async () => {
    const f = await fixture(),
      e = await f.register();
    await f.source('EVENT', e.messageId);
    await Promise.all([
      runMediaEvidenceWorker(f.deps),
      scanPendingMediaEvidence(f.deps),
      resolveMediaEvidence(f.deps, e.id),
    ]);
    expect(await f.get(e.id)).toMatchObject({ status: 'LINKED', attemptCount: 1 });
  });
  test('resolver rollback preserves PENDING/deadline/counters and permits a clean retry', async () => {
    const f = await fixture(),
      e = await f.register();
    await f.source('EVENT', e.messageId);
    await db.pg
      .exec(`CREATE FUNCTION img12_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMG12_INJECTED'; END $$;
      CREATE TRIGGER img12_fail BEFORE UPDATE ON media_evidence FOR EACH ROW EXECUTE FUNCTION img12_fail();`);
    try {
      await expect(resolveMediaEvidence(f.deps, e.id)).rejects.toThrow();
      expect(await f.get(e.id)).toEqual(e);
    } finally {
      await db.pg.exec('DROP TRIGGER img12_fail ON media_evidence; DROP FUNCTION img12_fail();');
    }
    expect(await resolveMediaEvidence(f.deps, e.id)).toBe('LINKED');
  });
  test('failed immediate attempt cannot roll back the committed receipt/image; Outbox recovers', async () => {
    const f = await fixture(),
      sourceId = `SRC-${randomUUID()}`;
    await f.source('EVENT', sourceId);
    const pending = await f.upload('EVENT', sourceId);
    await db.pg
      .exec(`CREATE FUNCTION img12_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMG12_INJECTED'; END $$;
      CREATE TRIGGER img12_fail BEFORE UPDATE ON media_evidence FOR EACH ROW EXECUTE FUNCTION img12_fail();`);
    try {
      await expect(createMediaHandler(f.mediaDeps)(pending.msg)).resolves.toEqual({ handled: true });
    } finally {
      await db.pg.exec('DROP TRIGGER img12_fail ON media_evidence; DROP FUNCTION img12_fail();');
    }
    const e = await db.prisma.mediaEvidence.findUniqueOrThrow({ where: { triggerId: pending.trigger.id } });
    expect(e.status).toBe('PENDING');
    expect(e.attemptCount).toBe(0);
    expect(await db.prisma.ingestionReceipt.count({ where: { deviceId: f.deviceId, topicType: 'media' } })).toBe(1);
    await runMediaEvidenceWorker(f.deps);
    expect((await f.get(e.id)).status).toBe('LINKED');
  });
  test('a failing scan row does not prevent later rows from progressing within the page', async () => {
    const f = await fixture(),
      a = await f.register(),
      b = await f.register();
    await db.pg.exec(`CREATE FUNCTION img12_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${a.id}' THEN RAISE EXCEPTION 'IMG12_ONE_ROW'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER img12_fail BEFORE UPDATE ON media_evidence FOR EACH ROW EXECUTE FUNCTION img12_fail();`);
    try {
      const result = await scanPendingMediaEvidence(f.deps);
      expect(result.failed).toBe(1);
      expect((await f.get(a.id)).attemptCount).toBe(0);
      expect((await f.get(b.id)).attemptCount).toBe(1);
    } finally {
      await db.pg.exec('DROP TRIGGER img12_fail ON media_evidence; DROP FUNCTION img12_fail();');
    }
    expect(await resolveMediaEvidence(f.deps, a.id)).toBe('PENDING');
  });

  test('minute scan terminalizes an expired row whose next attempt was clamped to its deadline', async () => {
    const f = await fixture(),
      e = await f.register();
    f.advance(86370000);
    expect(await resolveMediaEvidence(f.deps, e.id)).toBe('PENDING');
    expect((await f.get(e.id)).nextAttemptAt).toEqual(e.deadlineAt);
    f.advance(30000);
    const result = await scanPendingMediaEvidence(f.deps);
    expect(result.unmatched).toBeGreaterThanOrEqual(1);
    expect(await f.get(e.id)).toMatchObject({
      status: 'UNMATCHED',
      failureReason: 'SOURCE_TIMEOUT',
      nextAttemptAt: null,
    });
  });

  test('budget stop and invalid scan limits are explicit; missing IDs are harmless', async () => {
    const f = await fixture(),
      e = await f.register();
    expect(await scanPendingMediaEvidence(f.deps, { shouldContinue: () => false })).toMatchObject({
      pages: 0,
      visited: 0,
      stop: 'BUDGET',
    });
    expect((await f.get(e.id)).attemptCount).toBe(0);
    for (const options of [{ pageSize: 0 }, { pageSize: 101 }, { maxPages: 0 }, { maxPages: 21 }])
      await expect(scanPendingMediaEvidence(f.deps, options)).rejects.toThrow('INVALID_MEDIA_EVIDENCE_SCAN_BUDGET');
    expect(await resolveMediaEvidence(f.deps, randomUUID())).toBe('NOT_FOUND');
  });
});
