/** IMG-09 compatibility: old REST/MQTT/metadata flows on the migrated schema. */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { certificateFingerprintFromPem } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { createDeviceMediaHandler } from '../src/media/device-handler.js';
import { createAdminMediaHandlers } from '../src/media/admin-handler.js';
import type { MediaDeps } from '../src/media/service.js';
import { handleMediaMetadata } from '@fdp/media';
import { createTestDb } from './helpers.js';
const now = new Date('2026-11-06T10:00:00Z');
const fixture = new URL('../../../contracts/rest/fixtures/device-images/', import.meta.url);
const image = readFileSync(new URL('capture.jpg', fixture));
const oldRequest = JSON.parse(readFileSync(new URL('legacy-upload-request.json', fixture), 'utf8'));
const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from('local-migration-certificate').toString('base64')}\n-----END CERTIFICATE-----`;
const actor: ActorContext = {
  actorId: 'viewer',
  username: 'viewer',
  actorType: 'customer',
  roles: ['CustomerViewer'],
  customerId: 'compat-c',
  tokenUse: 'access',
};
let db: Awaited<ReturnType<typeof createTestDb>>, deps: MediaDeps;
const objects = new Map<string, Buffer>();
beforeAll(async () => {
  db = await createTestDb();
  await db.prisma.customer.create({ data: { id: 'compat-c', name: 'compat' } });
  await db.prisma.device.create({
    data: {
      id: 'compat-d',
      serialNumber: 'COMPAT',
      customerId: 'compat-c',
      model: 'M',
      hardwareVersion: '1',
      manufacturer: 'B',
      manufactureDate: now,
      lifecycleStatus: 'Active',
    },
  });
  await db.prisma.deviceCertificate.create({
    data: {
      id: 'compat-cert',
      deviceId: 'compat-d',
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      notBefore: new Date('2026-01-01Z'),
      notAfter: new Date('2027-01-01Z'),
    },
  });
  deps = {
    client: db.prisma,
    now: () => now,
    storage: {
      statObject: async (key) => (objects.has(key) ? { sizeBytes: objects.get(key)!.length } : null),
      computeSha256: async (key) =>
        objects.has(key) ? createHash('sha256').update(objects.get(key)!).digest('hex') : null,
    },
    urlSigner: {
      signUpload: async ({ key }) => `https://upload.test/${key}`,
      signDownload: async ({ key }) => `https://download.test/${key}`,
    },
    uploadPolicy: {
      getMediaTypes: () => ['IMAGE', 'VIDEO'],
      getMaxSizeKb: (type) => (type === 'IMAGE' ? 10240 : 204800),
      getDailyUploadQuotaPerDevice: () => 100,
      getUploadUrlTtlSeconds: () => 900,
      getDownloadUrlTtlSeconds: () => 900,
    },
  };
}, 60000);
afterAll(async () => {
  await db?.prisma.$disconnect();
  await db?.pg.close();
});
test('published old request still returns its original shape, then registers and downloads without trigger/evidence', async () => {
  const response = await createDeviceMediaHandler(deps)({
    identity: { clientCertPem: pem },
    body: oldRequest,
    requestId: 'legacy-request',
  });
  expect(response.status).toBe(201);
  const body = response.body as { data: { sessionId: string; objectPath: string; sizeBytes: number }; meta: unknown };
  expect(body.data.sizeBytes).toBe(image.length);
  expect(body.data).not.toHaveProperty('triggerRef');
  const session = await db.prisma.mediaUploadSession.findUniqueOrThrow({ where: { id: body.data.sessionId } });
  expect(session.triggerId).toBeNull();
  expect(session.sizeBytes).toBeNull();
  objects.set(body.data.objectPath, image);
  const message = {
    meta: { id: 'LEGACY-MEDIA-MESSAGE', ts: now.toISOString() },
    data: {
      mediaType: oldRequest.mediaType,
      captureTime: now.toISOString(),
      fileName: oldRequest.fileName,
      objectPath: body.data.objectPath,
      sizeKb: oldRequest.sizeKb,
      durationSec: 0,
    },
  };
  const result = await handleMediaMetadata(deps, 'compat-d', message);
  expect(result.applied).toBe(true);
  expect((await handleMediaMetadata(deps, 'compat-d', message)).replayed).toBe(true);
  const media = await db.prisma.mediaObject.findUniqueOrThrow({
    where: { sourceMessageId: message.meta.id },
    include: { evidenceImage: true },
  });
  expect(media.evidenceImage).toBeNull();
  expect(media.uploadSessionId).toBe(session.id);
  expect((await db.prisma.mediaUploadSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe(
    'COMPLETED',
  );
  expect(await db.prisma.mediaTrigger.count()).toBe(0);
  expect(await db.prisma.mediaEvidence.count()).toBe(0);
  const admin = createAdminMediaHandlers(deps);
  const list = await admin.listMedia({ actor, headers: {}, requestId: 'list-old' });
  expect(list.status).toBe(200);
  expect(JSON.stringify(list.body)).toContain(media.id);
  const download = await admin.createDownloadUrl({
    actor,
    headers: {},
    params: { mediaId: media.id },
    requestId: 'download-old',
  });
  expect(download.status).toBe(200);
  await db.prisma.mediaObject.update({ where: { id: media.id }, data: { status: 'DELETED' } });
  expect(
    (await admin.createDownloadUrl({ actor, headers: {}, params: { mediaId: media.id }, requestId: 'deleted-old' }))
      .status,
  ).toBe(404);
});
test('old VIDEO requests and nullable hash/size historical records remain readable', async () => {
  const response = await createDeviceMediaHandler(deps)({
    identity: { clientCertPem: pem },
    body: { ...oldRequest, mediaType: 'VIDEO', fileName: 'old.mp4' },
    requestId: 'legacy-video',
  });
  expect(response.status).toBe(201);
  expect((response.body as { data: unknown }).data).not.toHaveProperty('triggerRef');
  const s = await db.prisma.mediaUploadSession.create({
    data: {
      deviceId: 'compat-d',
      customerId: 'compat-c',
      mediaType: 'IMAGE',
      fileName: 'historical.jpg',
      sizeKb: 8,
      status: 'COMPLETED',
      presignedUrlExpiresAt: new Date('2020-01-01Z'),
    },
  });
  const m = await db.prisma.mediaObject.create({
    data: {
      deviceId: 'compat-d',
      customerId: 'compat-c',
      mediaType: 'IMAGE',
      fileName: s.fileName,
      sizeKb: s.sizeKb,
      objectPath: 'media/history/original.jpg',
      captureTime: new Date('2020-01-01Z'),
      uploadSessionId: s.id,
    },
  });
  const admin = createAdminMediaHandlers(deps);
  expect(
    (await admin.createDownloadUrl({ actor, headers: {}, params: { mediaId: m.id }, requestId: 'history-download' }))
      .status,
  ).toBe(200);
  expect((await db.prisma.mediaUploadSession.findUniqueOrThrow({ where: { id: s.id } })).sizeBytes).toBeNull();
  expect((await db.prisma.mediaObject.findUniqueOrThrow({ where: { id: m.id } })).sha256).toBeNull();
});

test('a valid pre-migration in-flight session can finish registration after upgrade without inferred trigger or byte count', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
  const { PrismaPGlite } = await import('pglite-prisma-adapter');
  const { PrismaClient } = await import('@fdp/database');
  const { readAllMigrationSql } = await import('./helpers.js');
  const sql = readAllMigrationSql();
  const migration = readFileSync(
    new URL(
      '../../../packages/database/prisma/migrations/20261106010000_media_trigger_evidence/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const fresh = new PGlite({ extensions: { btree_gist } });
  let client: InstanceType<typeof PrismaClient> | undefined;
  try {
    const offset = sql.indexOf(migration);
    expect(offset).toBeGreaterThan(0);
    await fresh.exec(sql.slice(0, offset));
    await fresh.exec(`INSERT INTO customers(id,name,updated_at) VALUES ('before-c','before',now());
      INSERT INTO devices(id,serial_number,model,hardware_version,manufacturer,manufacture_date,customer_id,lifecycle_status,updated_at)
        VALUES ('before-d','BEFORE-D','M','1','B','2026-01-01','before-c','Active',now());`);
    await fresh.query(
      `INSERT INTO media_upload_sessions(id,device_id,customer_id,media_type,file_name,size_kb,declared_sha256,status,presigned_url_expires_at)
      VALUES ('before-session','before-d','before-c','IMAGE','capture.jpg',1,$1,'ISSUED',$2)`,
      [oldRequest.sha256.toUpperCase(), new Date(now.getTime() + 900000)],
    );
    await fresh.exec(migration);
    client = new PrismaClient({ adapter: new PrismaPGlite(fresh) });
    const key = 'media/before-c/before-d/before-session/capture.jpg';
    objects.set(key, image);
    const result = await handleMediaMetadata({ ...deps, client }, 'before-d', {
      meta: { id: 'BEFORE-UPGRADE-MEDIA', ts: now.toISOString() },
      data: {
        mediaType: 'IMAGE',
        fileName: 'capture.jpg',
        sizeKb: 1,
        objectPath: key,
        captureTime: now.toISOString(),
        durationSec: 0,
      },
    });
    expect(result.applied).toBe(true);
    const row = await client.mediaUploadSession.findUniqueOrThrow({ where: { id: 'before-session' } });
    expect(row.status).toBe('COMPLETED');
    expect(row.triggerId).toBeNull();
    expect(row.sizeBytes).toBeNull();
    const media = await client.mediaObject.findUniqueOrThrow({
      where: { sourceMessageId: 'BEFORE-UPGRADE-MEDIA' },
      include: { evidenceImage: true },
    });
    expect(media.evidenceImage).toBeNull();
    expect(media.sha256).toBe(oldRequest.sha256);
  } finally {
    await client?.$disconnect();
    await fresh.close();
  }
}, 60000);
