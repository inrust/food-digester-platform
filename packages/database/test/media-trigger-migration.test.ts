/** IMG-09: actual migration + generated Prisma against isolated PGlite; no target DB. */
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../src/generated/client.js';
import { readAllMigrationSql } from './helpers.js';
const migration = readFileSync(
  new URL('../prisma/migrations/20261106010000_media_trigger_evidence/migration.sql', import.meta.url),
  'utf8',
);
const all = readAllMigrationSql();
const now = new Date();
const hash = 'a'.repeat(64);
let pg: PGlite, prisma: PrismaClient;
let history: Record<string, unknown>;
async function snapshot() {
  const rows: Record<string, unknown> = {};
  for (const table of ['media_upload_sessions', 'media_objects', 'alarms', 'device_events']) {
    const omit = table === 'media_upload_sessions' ? " - 'trigger_id' - 'size_bytes'" : '';
    rows[table] = (await pg.query(`SELECT to_jsonb(t)${omit} AS row FROM ${table} t ORDER BY id`)).rows;
  }
  return rows;
}
beforeAll(async () => {
  const offset = all.indexOf(migration);
  expect(offset).toBeGreaterThan(0);
  pg = new PGlite({ extensions: { btree_gist } });
  await pg.exec(all.slice(0, offset));
  await pg.exec(`INSERT INTO customers(id,name,updated_at) VALUES ('history-c1','history 1',now()),('history-c2','history 2',now());
    INSERT INTO devices(id,serial_number,model,hardware_version,manufacturer,manufacture_date,customer_id,lifecycle_status,updated_at)
    VALUES ('history-d1','HIST1','M','1','B','2026-01-01','history-c1','Active',now()),('history-d2','HIST2','M','1','B','2026-01-01','history-c2','Active',now());
    INSERT INTO media_upload_sessions(id,device_id,customer_id,media_type,file_name,size_kb,declared_sha256,status,presigned_url_expires_at)
    VALUES ('old-issued','history-d1','history-c1','IMAGE','old.jpg',2,NULL,'ISSUED',now()+interval '15 minutes'),
      ('old-completed','history-d1','history-c1','IMAGE','done.jpg',2,'${hash.toUpperCase()}','COMPLETED',now()-interval '1 day'),
      ('old-expired','history-d1','history-c1','VIDEO','old.mp4',200,NULL,'EXPIRED',now()-interval '1 day');
    INSERT INTO media_objects(id,device_id,customer_id,upload_session_id,media_type,capture_time,file_name,object_path,size_kb,sha256,status)
    VALUES ('old-media','history-d1','history-c1','old-completed','IMAGE',now(),'done.jpg','media/old/done.jpg',2,NULL,'AVAILABLE'),
      ('old-deleted','history-d1','history-c1',NULL,'VIDEO',now(),'old.mp4','media/old/old.mp4',200,NULL,'DELETED');
    INSERT INTO alarms(id,device_id,customer_id,code,category,severity,status,detected_time,updated_at) VALUES ('old-alarm','history-d1','history-c1','C','M','INFO','CLEARED',now(),now());
    INSERT INTO device_events(id,device_id,customer_id,event_type,occurred_at) VALUES ('old-event','history-d1','history-c1','USER_ACTION',now());`);
  history = await snapshot();
  await pg.exec(migration);
  prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
}, 60000);
afterAll(async () => {
  await prisma?.$disconnect();
  await pg?.close();
});

async function trigger(overrides: Record<string, unknown> = {}) {
  return prisma.mediaTrigger.create({
    data: {
      id: randomUUID(),
      customerId: 'history-c1',
      deviceId: 'history-d1',
      kind: 'ALARM',
      messageId: `ALM-${randomUUID()}`,
      fileName: 'capture.jpg',
      sizeBytes: 811,
      sizeKb: 1,
      sha256Normalized: hash,
      ...overrides,
    },
  });
}
async function boundSession(t: Awaited<ReturnType<typeof trigger>>, overrides: Record<string, unknown> = {}) {
  return prisma.mediaUploadSession.create({
    data: {
      deviceId: t.deviceId,
      customerId: t.customerId,
      mediaType: 'IMAGE',
      fileName: t.fileName,
      sizeKb: t.sizeKb,
      sizeBytes: t.sizeBytes,
      declaredSha256: t.sha256Normalized,
      triggerId: t.id,
      status: 'ISSUED',
      presignedUrlExpiresAt: new Date(now.getTime() + 900000),
      ...overrides,
    },
  });
}
async function registered(overrides: Record<string, unknown> = {}) {
  const t = await trigger(overrides),
    s = await boundSession(t);
  await prisma.mediaUploadSession.update({ where: { id: s.id }, data: { status: 'COMPLETED', completedAt: now } });
  const m = await prisma.mediaObject.create({
    data: {
      deviceId: t.deviceId,
      customerId: t.customerId,
      uploadSessionId: s.id,
      mediaType: 'IMAGE',
      captureTime: now,
      fileName: t.fileName,
      sizeKb: t.sizeKb,
      objectPath: `media/${t.customerId}/${t.deviceId}/${s.id}/${t.fileName}`,
      sha256: hash,
      durationSec: 0,
    },
  });
  const e = await prisma.mediaEvidence.create({
    data: {
      triggerId: t.id,
      mediaId: m.id,
      customerId: t.customerId,
      deviceId: t.deviceId,
      kind: t.kind,
      messageId: t.messageId,
      registeredAt: now,
      deadlineAt: new Date(now.getTime() + 86400000),
      nextAttemptAt: now,
    },
  });
  return { t, s, m, e };
}
async function target(t: Awaited<ReturnType<typeof trigger>>) {
  if (t.kind === 'ALARM')
    return prisma.alarm.create({
      data: {
        deviceId: t.deviceId,
        customerId: t.customerId,
        code: 'C',
        category: 'M',
        severity: 'INFO',
        detectedTime: now,
        sourceMessageId: t.messageId,
      },
    });
  return prisma.deviceEvent.create({
    data: {
      deviceId: t.deviceId,
      customerId: t.customerId,
      eventType: 'USER_ACTION',
      occurredAt: now,
      sourceMessageId: t.messageId,
    },
  });
}
async function rejected(sql: string, params: unknown[] = [], code = '23514') {
  await expect(pg.query(sql, params)).rejects.toMatchObject({ code });
}

describe('IMG-09 additive migration and immutable declarations', () => {
  test('historical rows retain every prior field; new tables are empty and session columns remain NULL', async () => {
    expect(await snapshot()).toEqual(history);
    expect(await prisma.mediaTrigger.count()).toBe(0);
    expect(await prisma.mediaEvidence.count()).toBe(0);
    for (const session of await prisma.mediaUploadSession.findMany()) {
      expect(session.triggerId).toBeNull();
      expect(session.sizeBytes).toBeNull();
    }
    const old = await prisma.mediaObject.findUniqueOrThrow({
      where: { id: 'old-media' },
      include: { uploadSession: true, evidenceImage: true },
    });
    expect(old.evidenceImage).toBeNull();
    expect(old.uploadSession?.triggerId).toBeNull();
    expect(old.sha256).toBeNull();
  });
  test('old unbound requests still permit multiple sessions and nullable declarations', async () => {
    for (let i = 0; i < 2; i++) {
      const s = await prisma.mediaUploadSession.create({
        data: {
          deviceId: 'history-d1',
          customerId: 'history-c1',
          mediaType: 'IMAGE',
          fileName: 'legacy.jpg',
          sizeKb: 1,
          presignedUrlExpiresAt: now,
        },
      });
      expect(s.triggerId).toBeNull();
      expect(s.sizeBytes).toBeNull();
      expect(s.declaredSha256).toBeNull();
    }
  });
  test.each([
    { kind: 'VIDEO' },
    { mediaType: 'VIDEO' },
    { messageId: 'bad_id' },
    { messageId: 'a'.repeat(129) },
    { fileName: '../a.jpg' },
    { sizeBytes: 0 },
    { sizeBytes: 10485761, sizeKb: 10241 },
    { sizeKb: 2 },
    { sha256Normalized: 'A'.repeat(64) },
  ])('rejects invalid trigger declarations %j', async (data) => {
    await expect(trigger(data)).rejects.toBeDefined();
  });
  test('trigger reference is case-sensitive and scoped by customer/device/kind', async () => {
    const messageId = `Case-${randomUUID()}`;
    const t = await trigger({ messageId });
    await expect(trigger({ messageId })).rejects.toMatchObject({ code: 'P2002' });
    await expect(trigger({ messageId: messageId.toLowerCase() })).resolves.toBeDefined();
    await expect(trigger({ messageId, kind: 'EVENT' })).resolves.toBeDefined();
    await expect(trigger({ messageId, customerId: 'history-c2', deviceId: 'history-d2' })).resolves.toBeDefined();
    await expect(trigger({ messageId, customerId: 'history-c2' })).rejects.toBeDefined();
    for (const [column, value] of [
      ['message_id', 'OTHER'],
      ['file_name', 'other.jpg'],
      ['sha256_normalized', 'b'.repeat(64)],
      ['customer_id', 'history-c2'],
    ]) {
      await rejected(`UPDATE media_triggers SET ${column}=$1 WHERE id=$2`, [value, t.id]);
    }
    await rejected('DELETE FROM media_triggers WHERE id=$1', [t.id]);
  });
  test('bound sessions require the same exact immutable declaration', async () => {
    const t = await trigger();
    for (const data of [
      { sizeBytes: null },
      { declaredSha256: null },
      { declaredSha256: 'b'.repeat(64) },
      { fileName: 'other.jpg' },
      { mediaType: 'VIDEO' },
      { sizeBytes: 812 },
      { customerId: 'history-c2' },
    ])
      await expect(boundSession(t, data)).rejects.toBeDefined();
    const s = await boundSession(t);
    await expect(boundSession(t)).rejects.toMatchObject({ code: 'P2002' });
    for (const [col, val] of [
      ['trigger_id', null],
      ['size_bytes', 812],
      ['file_name', 'changed.jpg'],
      ['declared_sha256', 'b'.repeat(64)],
      ['presigned_url_expires_at', new Date(now.getTime() + 1800000)],
    ])
      await rejected(`UPDATE media_upload_sessions SET ${col}=$1 WHERE id=$2`, [val, s.id]);
    await rejected('UPDATE media_upload_sessions SET trigger_id=$1 WHERE id=$2', [t.id, 'old-issued']);
    await prisma.mediaUploadSession.update({ where: { id: s.id }, data: { status: 'EXPIRED' } });
    const next = await boundSession(t);
    expect(next.id).not.toBe(s.id);
    await rejected("UPDATE media_upload_sessions SET status='ISSUED' WHERE id=$1", [s.id]);
  });
  test('bound file metadata is immutable while media soft deletion remains supported', async () => {
    const { m, e } = await registered();
    for (const [col, val] of [
      ['sha256', 'b'.repeat(64)],
      ['file_name', 'changed.jpg'],
      ['object_path', 'media/changed.jpg'],
      ['upload_session_id', null],
    ])
      await rejected(`UPDATE media_objects SET ${col}=$1 WHERE id=$2`, [val, m.id]);
    await prisma.mediaObject.update({ where: { id: m.id }, data: { status: 'DELETED' } });
    expect(
      (await prisma.mediaEvidence.findUniqueOrThrow({ where: { id: e.id }, include: { media: true } })).media.status,
    ).toBe('DELETED');
    await rejected('DELETE FROM media_objects WHERE id=$1', [m.id], '23001');
    await rejected('DELETE FROM media_upload_sessions WHERE id=$1', [
      (await prisma.mediaObject.findUniqueOrThrow({ where: { id: m.id } })).uploadSessionId,
    ]);
    await rejected('DELETE FROM media_evidence WHERE id=$1', [e.id]);
  });
});

describe('IMG-09 registration and association are separate states', () => {
  test.each(['ALARM', 'EVENT'])('PENDING -> LINKED %s references exactly the original source', async (kind) => {
    const { t, e } = await registered({ kind }),
      row = await target(t);
    const data = kind === 'ALARM' ? { alarmId: row.id } : { eventId: row.id };
    const linked = await prisma.mediaEvidence.update({
      where: { id: e.id },
      data: { status: 'LINKED', nextAttemptAt: null, ...data },
    });
    expect(linked.status).toBe('LINKED');
    if (kind === 'ALARM')
      await prisma.alarm.update({ where: { id: row.id }, data: { status: 'CLEARED', clearedAt: now } });
    expect((await prisma.mediaEvidence.findUniqueOrThrow({ where: { id: e.id } })).status).toBe('LINKED');
    await rejected(
      'DELETE FROM ' + (kind === 'ALARM' ? 'alarms' : 'device_events') + ' WHERE id=$1',
      [row.id],
      '23001',
    );
    await rejected(
      'UPDATE ' + (kind === 'ALARM' ? 'alarms' : 'device_events') + ' SET source_message_id=$1 WHERE id=$2',
      [`REPLACED-${randomUUID()}`, row.id],
      '23001',
    );
    await rejected(
      "UPDATE media_evidence SET status='PENDING',alarm_id=NULL,event_id=NULL,next_attempt_at=registered_at WHERE id=$1",
      [e.id],
    );
  });
  test('one trigger, media and target can be registered only once', async () => {
    const { e } = await registered();
    await rejected(
      'INSERT INTO media_evidence SELECT $1,trigger_id,media_id,customer_id,device_id,kind,message_id,status,alarm_id,event_id,registered_at,deadline_at,next_attempt_at,attempt_count,failure_reason,updated_at FROM media_evidence WHERE id=$2',
      [randomUUID(), e.id],
      '23505',
    );
  });
  test('retry updates preserve deadline and count; terminal UNMATCHED requires a safe reason', async () => {
    const { e } = await registered();
    await prisma.mediaEvidence.update({
      where: { id: e.id },
      data: { attemptCount: 2, nextAttemptAt: new Date(now.getTime() + 60000), failureReason: 'SOURCE_PENDING' },
    });
    await rejected('UPDATE media_evidence SET attempt_count=1 WHERE id=$1', [e.id]);
    await rejected("UPDATE media_evidence SET deadline_at=deadline_at+interval '1 hour' WHERE id=$1", [e.id]);
    await rejected(
      "UPDATE media_evidence SET status='UNMATCHED',next_attempt_at=NULL,failure_reason=NULL WHERE id=$1",
      [e.id],
    );
    await rejected("UPDATE media_evidence SET failure_reason='raw payload with secrets' WHERE id=$1", [e.id]);
    await prisma.mediaEvidence.update({
      where: { id: e.id },
      data: { status: 'UNMATCHED', nextAttemptAt: null, failureReason: 'SOURCE_NOT_FOUND' },
    });
    await rejected('UPDATE media_evidence SET attempt_count=3 WHERE id=$1', [e.id]);
  });
  test('wrong kind, message, tenant or device cannot link', async () => {
    const { t, e } = await registered(),
      wrong = await target(await trigger({ kind: 'EVENT' })),
      alarm = await target(await trigger());
    await rejected("UPDATE media_evidence SET status='LINKED',event_id=$1,next_attempt_at=NULL WHERE id=$2", [
      wrong.id,
      e.id,
    ]);
    await rejected(
      "UPDATE media_evidence SET status='LINKED',alarm_id=$1,next_attempt_at=NULL WHERE id=$2",
      [alarm.id, e.id],
      '23503',
    );
    await rejected("UPDATE media_evidence SET message_id='CHANGED' WHERE id=$1", [e.id]);
    const cross = await prisma.alarm.create({
      data: {
        deviceId: 'history-d2',
        customerId: 'history-c2',
        sourceMessageId: t.messageId,
        code: 'C',
        category: 'M',
        severity: 'INFO',
        detectedTime: now,
      },
    });
    await rejected(
      "UPDATE media_evidence SET status='LINKED',alarm_id=$1,next_attempt_at=NULL WHERE id=$2",
      [cross.id, e.id],
      '23503',
    );
  });
  test('device reassignment cannot move old trigger/evidence to the new customer', async () => {
    const { t, e } = await registered();
    const a = await target(t);
    await prisma.device.update({ where: { id: 'history-d1' }, data: { customerId: 'history-c2' } });
    try {
      const linked = await prisma.mediaEvidence.update({
        where: { id: e.id },
        data: { status: 'LINKED', alarmId: a.id, nextAttemptAt: null },
      });
      expect(linked.customerId).toBe('history-c1');
      await prisma.mediaObject.update({
        where: { id: (await prisma.mediaEvidence.findUniqueOrThrow({ where: { id: e.id } })).mediaId },
        data: { status: 'DELETED' },
      });
      await rejected("UPDATE media_evidence SET customer_id='history-c2' WHERE id=$1", [e.id]);
    } finally {
      await prisma.device.update({ where: { id: 'history-d1' }, data: { customerId: 'history-c1' } });
    }
  });
  test('PENDING can be created before its source exists and no target is guessed', async () => {
    const { e } = await registered({ kind: 'EVENT' });
    expect(e.status).toBe('PENDING');
    expect(e.alarmId).toBeNull();
    expect(e.eventId).toBeNull();
    await rejected('UPDATE media_evidence SET next_attempt_at=NULL WHERE id=$1', [e.id]);
    await rejected("UPDATE media_evidence SET next_attempt_at=deadline_at+interval '1 second' WHERE id=$1", [e.id]);
  });
});

test('migration applies reproducibly to two fresh isolated databases', async () => {
  for (let i = 0; i < 2; i++) {
    const fresh = new PGlite({ extensions: { btree_gist } });
    try {
      await fresh.exec(all);
      expect((await fresh.query('SELECT count(*)::int AS n FROM media_triggers')).rows).toEqual([{ n: 0 }]);
    } finally {
      await fresh.close();
    }
  }
}, 60000);

test('concurrent callers cannot create two ISSUED attempts for the same trigger (single PGlite backend)', async () => {
  const t = await trigger();
  const results = await Promise.allSettled([boundSession(t), boundSession(t)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await prisma.mediaUploadSession.count({ where: { triggerId: t.id, status: 'ISSUED' } })).toBe(1);
});
test('SQL failure rolls back the additive migration; original schema remains and a clean retry succeeds', async () => {
  const fresh = new PGlite({ extensions: { btree_gist } });
  try {
    await fresh.exec(all.slice(0, all.indexOf(migration)));
    const before = (
      await fresh.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='media_upload_sessions' ORDER BY column_name",
      )
    ).rows;
    await expect(
      fresh.exec(migration.replace('COMMIT;', 'SELECT * FROM img09_intentionally_missing_table; COMMIT;')),
    ).rejects.toMatchObject({ code: '42P01' });
    await fresh.exec('ROLLBACK');
    expect(
      (
        await fresh.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='media_upload_sessions' ORDER BY column_name",
        )
      ).rows,
    ).toEqual(before);
    expect((await fresh.query("SELECT to_regclass('media_triggers') AS table_name")).rows).toEqual([
      { table_name: null },
    ]);
    await fresh.exec(migration);
    expect((await fresh.query('SELECT count(*)::int AS n FROM media_evidence')).rows).toEqual([{ n: 0 }]);
  } finally {
    await fresh.close();
  }
}, 60000);
test('evidence rejects legacy media and a different upload trigger, and requires session completion', async () => {
  const a = await trigger(),
    b = await trigger(),
    s = await boundSession(a);
  const m = await prisma.mediaObject.create({
    data: {
      deviceId: a.deviceId,
      customerId: a.customerId,
      uploadSessionId: s.id,
      mediaType: 'IMAGE',
      captureTime: now,
      fileName: a.fileName,
      sizeKb: a.sizeKb,
      objectPath: `media/${s.id}/capture.jpg`,
      sha256: hash,
    },
  });
  const data = {
    triggerId: a.id,
    mediaId: m.id,
    customerId: a.customerId,
    deviceId: a.deviceId,
    kind: a.kind,
    messageId: a.messageId,
    registeredAt: now,
    deadlineAt: new Date(now.getTime() + 86400000),
    nextAttemptAt: now,
  };
  await expect(prisma.mediaEvidence.create({ data })).rejects.toBeDefined();
  await prisma.mediaUploadSession.update({ where: { id: s.id }, data: { status: 'COMPLETED', completedAt: now } });
  await expect(
    prisma.mediaEvidence.create({ data: { ...data, triggerId: b.id, messageId: b.messageId } }),
  ).rejects.toBeDefined();
  await expect(prisma.mediaEvidence.create({ data: { ...data, mediaId: 'old-media' } })).rejects.toBeDefined();
  expect((await prisma.mediaEvidence.create({ data })).status).toBe('PENDING');
});
