/** IMG-10 actual Prisma + migrated PGlite; signing/S3 stay local. */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { certificateFingerprintFromPem } from '@fdp/auth';
import { withLiveImageAuthority } from '@fdp/aws-clients';
import type { DbClient, PrismaClient } from '@fdp/database';
import { createDeviceMediaHandler } from '../src/media/device-handler.js';
import type { DeviceMediaResponse } from '../src/media/device-handler.js';
import type { MediaDeps, MediaTriggerRef, MediaUploadSessionView } from '../src/media/service.js';
import { handleMediaMetadata } from '@fdp/media';
import { createTestDb } from './helpers.js';
import { TestControlStore } from './live-image-fixtures.js';
import { assertOpenApiResponse } from './openapi-response.js';
const jpeg = readFileSync(new URL('../../../contracts/rest/fixtures/device-images/capture.jpg', import.meta.url));
const legacy = JSON.parse(
  readFileSync(
    new URL('../../../contracts/rest/fixtures/device-images/legacy-upload-request.json', import.meta.url),
    'utf8',
  ),
);
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 60000);
afterAll(async () => {
  await db?.prisma.$disconnect();
  await db?.pg.close();
});
const data = (response: DeviceMediaResponse) => (response.body as { data: MediaUploadSessionView }).data;
const code = (response: DeviceMediaResponse) => (response.body as { error: { code: string } }).error.code;
async function fixture(quota = 100, wrapped = false) {
  const suffix = randomUUID(),
    customerId = `c-${suffix}`,
    deviceId = `d-${suffix}`;
  const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(suffix).toString('base64')}\n-----END CERTIFICATE-----`;
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
  const cert = await db.prisma.deviceCertificate.create({
    data: {
      id: suffix,
      deviceId,
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      notBefore: new Date('2026-01-01Z'),
      notAfter: new Date('2027-01-01Z'),
    },
  });
  let clock = Date.parse('2026-11-06T08:00:00Z');
  const sign = vi
    .fn<MediaDeps['urlSigner']['signUpload']>()
    .mockImplementation(async ({ key, expiresAt }) => `https://local.test/${key}?until=${expiresAt.toISOString()}`);
  const objects = new Map<string, Buffer>();
  const deps = {
    client: (wrapped ? withLiveImageAuthority(db.prisma, new TestControlStore()) : db.prisma) as DbClient,
    now: () => new Date(clock),
    storage: {
      statObject: async (key) => (objects.has(key) ? { sizeBytes: objects.get(key)!.length } : null),
      computeSha256: async () => legacy.sha256,
    },
    urlSigner: { signUpload: sign, signDownload: async () => 'https://download.test/' },
    uploadPolicy: {
      getMediaTypes: () => ['IMAGE', 'VIDEO'],
      getMaxSizeKb: (type) => (type === 'IMAGE' ? 10240 : 204800),
      getDailyUploadQuotaPerDevice: () => quota,
      getUploadUrlTtlSeconds: () => 900,
      getDownloadUrlTtlSeconds: () => 900,
    },
  } satisfies MediaDeps;
  const ref: MediaTriggerRef = { kind: 'ALARM', messageId: `ALM-${suffix}` };
  const body = { ...legacy, triggerRef: ref };
  const request = async (input: unknown = body): Promise<DeviceMediaResponse> => {
    const response = await createDeviceMediaHandler(deps)({
      identity: { clientCertPem: pem },
      body: input,
      requestId: `req-${suffix}`,
    });
    assertOpenApiResponse('createMediaUploadSession', response.status, response.body);
    return response;
  };
  return {
    customerId,
    deviceId,
    cert,
    pem,
    ref,
    body,
    deps,
    sign,
    objects,
    request,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    setTime: (ms: number) => {
      clock = ms;
    },
  };
}
async function seed(f: Awaited<ReturnType<typeof fixture>>, count: number, at = new Date(f.now())) {
  await db.prisma.mediaUploadSession.createMany({
    data: Array.from({ length: count }, () => ({
      id: randomUUID(),
      deviceId: f.deviceId,
      customerId: f.customerId,
      mediaType: 'IMAGE',
      fileName: 'earlier.jpg',
      sizeKb: 1,
      status: 'EXPIRED',
      createdAt: at,
      presignedUrlExpiresAt: at,
    })),
  });
}
function beforeTransaction(client: DbClient, work: () => Promise<void>): DbClient {
  let once = true;
  return new Proxy(client as PrismaClient, {
    get(target, key) {
      if (key === '$transaction')
        return async (...args: unknown[]) => {
          if (once) {
            once = false;
            await work();
          }
          return (target.$transaction as (...args: unknown[]) => Promise<unknown>).apply(target, args);
        };
      return Reflect.get(target, key);
    },
  });
}
async function register(f: Awaited<ReturnType<typeof fixture>>, view: MediaUploadSessionView) {
  f.objects.set(view.objectPath, jpeg);
  const result = await handleMediaMetadata(f.deps, f.deviceId, {
    meta: { id: `MED-${randomUUID()}`, ts: new Date(f.now()).toISOString() },
    data: {
      mediaType: 'IMAGE',
      fileName: view.fileName,
      sizeKb: view.sizeKb,
      objectPath: view.objectPath,
      captureTime: new Date(f.now()).toISOString(),
      durationSec: 0,
    },
  });
  expect(result.applied).toBe(true);
  return result.mediaId!;
}

describe('IMG-10 immutable trigger declaration and outcome contracts', () => {
  test.each(['ALARM', 'EVENT'] as const)(
    '%s gets 201 then 200, with original fields/deadline and persisted exact bytes',
    async (kind) => {
      const f = await fixture();
      f.body.triggerRef = { ...f.ref, kind };
      const first = await f.request();
      expect(first.status).toBe(201);
      f.advance(60000);
      const second = await f.request();
      expect(second.status).toBe(200);
      expect({ ...data(second), uploadUrl: undefined }).toEqual({ ...data(first), uploadUrl: undefined });
      const row = await db.prisma.mediaUploadSession.findUniqueOrThrow({
        where: { id: data(first).sessionId },
        include: { trigger: true },
      });
      expect(row.trigger?.sha256Normalized).toBe(legacy.sha256);
      expect(row.sizeBytes).toBe(jpeg.length);
      expect(data(second).triggerRef).toEqual(f.body.triggerRef);
      expect(f.sign.mock.calls[1]![0]).toEqual({
        key: data(first).objectPath,
        expiresAt: row.presignedUrlExpiresAt,
        contentLength: jpeg.length,
        checksumSha256: legacy.sha256,
      });
      expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(1);
      expect(
        await db.prisma.auditLog.count({
          where: { objectId: row.id, action: 'media.upload_session.create', result: 'SUCCESS' },
        }),
      ).toBe(1);
      expect(
        await db.prisma.auditLog.count({
          where: { objectId: row.id, action: 'media.upload_session.reuse', result: 'SUCCESS' },
        }),
      ).toBe(1);
    },
  );
  test.each([
    { fileName: 'different.jpg' },
    { fileName: 'Capture.jpg' },
    { sha256: 'b'.repeat(64) },
    { sizeBytes: 812 },
    { sizeBytes: 1025, sizeKb: 2 },
  ])('changed declaration %j returns only MEDIA_TRIGGER_CONFLICT', async (change) => {
    const f = await fixture();
    expect((await f.request()).status).toBe(201);
    const result = await f.request({ ...f.body, ...change });
    expect(result.status).toBe(409);
    expect(code(result)).toBe('MEDIA_TRIGGER_CONFLICT');
    expect((result.body as { error: unknown }).error).not.toHaveProperty('details');
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(1);
  });
  test('SHA-256 case normalizes without changing the bound declaration', async () => {
    const f = await fixture();
    const first = await f.request({ ...f.body, sha256: legacy.sha256.toUpperCase() });
    expect(first.status).toBe(201);
    const retry = await f.request();
    expect(retry.status).toBe(200);
    expect(data(retry).sessionId).toBe(data(first).sessionId);
  });
  test.each([
    null,
    [],
    {},
    'ALARM',
    { kind: 'VIDEO', messageId: 'A' },
    { kind: 'ALARM', messageId: 'bad_id' },
    { kind: 'EVENT', messageId: ' A' },
    { kind: 'ALARM', messageId: 'a'.repeat(129) },
    { kind: 'ALARM', messageId: 'A', customerId: 'forged' },
  ])('invalid nested trigger %j never signs or consumes quota', async (ref) => {
    const f = await fixture();
    const result = await f.request({ ...f.body, triggerRef: ref });
    expect(result.status).toBe(400);
    expect(f.sign).not.toHaveBeenCalled();
    expect(await db.prisma.mediaTrigger.count({ where: { deviceId: f.deviceId } })).toBe(0);
    expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(0);
  });
  test('VIDEO trigger and forged tenant/device/key fields are rejected', async () => {
    const f = await fixture();
    for (const change of [
      { mediaType: 'VIDEO' },
      { customerId: 'other' },
      { deviceId: 'other' },
      { objectPath: 'media/other' },
    ])
      expect((await f.request({ ...f.body, ...change })).status).toBe(400);
    expect(f.sign).not.toHaveBeenCalled();
  });
  test('reference key distinguishes exact message case and kind', async () => {
    const f = await fixture();
    const results = [
      await f.request(),
      await f.request({ ...f.body, triggerRef: { ...f.ref, messageId: f.ref.messageId.toLowerCase() } }),
      await f.request({ ...f.body, triggerRef: { ...f.ref, kind: 'EVENT' } }),
    ];
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => data(r).sessionId)).size).toBe(3);
  });
  test('different tenants/devices cannot reuse each other’s session for the same reference', async () => {
    const a = await fixture(),
      b = await fixture();
    const first = await a.request(),
      second = await b.request({ ...b.body, triggerRef: a.ref });
    expect(second.status).toBe(201);
    expect(data(second).sessionId).not.toBe(data(first).sessionId);
    expect(data(second).objectPath).toContain(`/${b.customerId}/${b.deviceId}/`);
  });
});

describe('IMG-10 expiry, registration and signing failure', () => {
  test('at expiry new session/key is issued once; trigger declaration and old deadline stay intact', async () => {
    const f = await fixture();
    const a = data(await f.request());
    const trigger = await db.prisma.mediaTrigger.findFirstOrThrow({ where: { deviceId: f.deviceId } });
    f.advance(900000);
    const next = await f.request();
    expect(next.status).toBe(201);
    const b = data(next);
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(b.objectPath).not.toBe(a.objectPath);
    const old = await db.prisma.mediaUploadSession.findUniqueOrThrow({ where: { id: a.sessionId } });
    expect(old.status).toBe('EXPIRED');
    expect(old.presignedUrlExpiresAt.toISOString()).toBe(a.uploadUrlExpiresAt);
    expect(await db.prisma.mediaTrigger.findUniqueOrThrow({ where: { id: trigger.id } })).toEqual(trigger);
    expect(data(await f.request()).sessionId).toBe(b.sessionId);
    expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(2);
  });
  test('registered media yields 409 with mediaId after expiry or soft deletion', async () => {
    const f = await fixture(1),
      view = data(await f.request()),
      mediaId = await register(f, view);
    expect(await db.prisma.mediaEvidence.count({ where: { mediaId } })).toBe(1);
    for (let i = 0; i < 2; i++) {
      f.advance(900000);
      const result = await f.request();
      expect(result.status).toBe(409);
      expect(code(result)).toBe('MEDIA_ALREADY_REGISTERED');
      expect((result.body as { error: { details: unknown } }).error.details).toEqual({ mediaId });
      await db.prisma.mediaObject.update({ where: { id: mediaId }, data: { status: 'DELETED' } });
    }
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(1);
    expect(code(await f.request({ ...f.body, fileName: 'changed.jpg' }))).toBe('MEDIA_TRIGGER_CONFLICT');
  });
  test('registration committed just before the request transaction wins over new issuance', async () => {
    const f = await fixture(),
      view = data(await f.request());
    let mediaId = '';
    f.deps.client = beforeTransaction(f.deps.client, async () => {
      mediaId = await register({ ...f, deps: { ...f.deps, client: db.prisma } }, view);
    });
    const result = await f.request();
    expect(code(result)).toBe('MEDIA_ALREADY_REGISTERED');
    expect((result.body as { error: { details: unknown } }).error.details).toEqual({ mediaId });
    expect(f.sign).toHaveBeenCalledTimes(1);
  });
  test('IMG-11: old metadata I/O loses to a replacement issuance; only the new session registers', async () => {
    const f = await fixture();
    const old = data(await f.request());
    f.objects.set(old.objectPath, jpeg);
    let replacement: MediaUploadSessionView | undefined;
    const result = await handleMediaMetadata(
      {
        ...f.deps,
        storage: {
          ...f.deps.storage,
          computeSha256: async () => {
            f.advance(900000);
            const next = await f.request();
            expect(next.status).toBe(201);
            replacement = data(next);
            return legacy.sha256;
          },
        },
      },
      f.deviceId,
      {
        meta: { id: `MED-old-${randomUUID()}`, ts: new Date(f.now()).toISOString() },
        data: {
          mediaType: 'IMAGE',
          captureTime: new Date(f.now()).toISOString(),
          fileName: old.fileName,
          sizeKb: old.sizeKb,
          objectPath: old.objectPath,
        },
      },
    );
    expect(result).toEqual({ applied: false, reason: 'SESSION_NOT_OPEN' });
    expect(await db.prisma.mediaObject.count({ where: { deviceId: f.deviceId } })).toBe(0);
    expect(await db.prisma.mediaEvidence.count({ where: { deviceId: f.deviceId } })).toBe(0);
    expect(
      await db.prisma.outboxEvent.count({
        where: {
          idempotencyKey: {
            startsWith: 'media-evidence:',
          },
          payload: { path: ['deviceId'], equals: f.deviceId },
        },
      }),
    ).toBe(0);
    expect(replacement).toBeDefined();
    const mediaId = await register(f, replacement!);
    const evidence = await db.prisma.mediaEvidence.findUniqueOrThrow({ where: { mediaId } });
    expect(evidence.status).toBe('PENDING');
    expect(await db.prisma.mediaObject.count({ where: { deviceId: f.deviceId } })).toBe(1);
    expect(await db.prisma.mediaEvidence.count({ where: { deviceId: f.deviceId } })).toBe(1);
    expect(code(await f.request())).toBe('MEDIA_ALREADY_REGISTERED');
    expect((await db.prisma.mediaUploadSession.findUniqueOrThrow({ where: { id: old.sessionId } })).status).toBe(
      'EXPIRED',
    );
  });
  test('COMPLETED without a MediaObject fails closed and never consumes another quota slot', async () => {
    const f = await fixture();
    const view = data(await f.request());
    await db.prisma.mediaUploadSession.update({
      where: { id: view.sessionId },
      data: { status: 'COMPLETED', completedAt: new Date(f.now()) },
    });
    const result = await f.request();
    expect(result.status).toBe(500);
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(1);
  });
  test('signing failure persists one attempt; identical retry reuses it and does not leak errors', async () => {
    const f = await fixture(1);
    f.sign.mockRejectedValueOnce(new Error('private signing credentials SQL failure'));
    const failure = await f.request();
    expect(failure.status).toBe(500);
    expect(JSON.stringify(failure.body)).not.toContain('private');
    const persisted = await db.prisma.mediaUploadSession.findFirstOrThrow({ where: { deviceId: f.deviceId } });
    const retry = await f.request();
    expect(retry.status).toBe(200);
    expect(data(retry).sessionId).toBe(persisted.id);
    expect(data(retry).uploadUrlExpiresAt).toBe(persisted.presignedUrlExpiresAt.toISOString());
    expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(1);
  });
  test('deadline reached while signing never returns an already expired URL', async () => {
    const f = await fixture();
    f.sign.mockImplementationOnce(async () => {
      f.advance(900001);
      return 'https://expired.test/';
    });
    expect((await f.request()).status).toBe(500);
    const retry = await f.request();
    expect(retry.status).toBe(201);
    expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(2);
  });
});

describe('IMG-10 concurrent quota, UTC day and fresh authorization', () => {
  test.each([false, true])(
    'concurrent same-trigger requests share the final quota slot, authority wrapper=%s',
    async (wrapped) => {
      const f = await fixture(100, wrapped);
      await seed(f, 99);
      const result = await Promise.all(Array.from({ length: 8 }, () => f.request()));
      expect(result.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
      expect(new Set(result.map((r) => data(r).sessionId)).size).toBe(1);
      expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(100);
      expect(await db.prisma.mediaTrigger.count({ where: { deviceId: f.deviceId } })).toBe(1);
    },
  );
  test('different triggers compete for the last slot, and denied claim rolls back its trigger', async () => {
    const f = await fixture(100);
    await seed(f, 99);
    const result = await Promise.all([
      f.request(),
      f.request({ ...f.body, triggerRef: { ...f.ref, messageId: `OTHER-${randomUUID()}` } }),
    ]);
    expect(result.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(code(result.find((r) => r.status === 409)!)).toBe('CONFLICT');
    expect(await db.prisma.mediaTrigger.count({ where: { deviceId: f.deviceId } })).toBe(1);
    expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(100);
  });
  test('two declarations race: exactly one binds and the other conflicts', async () => {
    const f = await fixture();
    const results = await Promise.all([f.request(), f.request({ ...f.body, fileName: 'other.jpg' })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(code(results.find((r) => r.status === 409)!)).toBe('MEDIA_TRIGGER_CONFLICT');
    expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(1);
  });
  test('parallel expired retries issue one replacement and reuse it', async () => {
    const f = await fixture(2);
    const old = data(await f.request());
    f.advance(900000);
    const results = await Promise.all(Array.from({ length: 5 }, () => f.request()));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => data(r).sessionId)).size).toBe(1);
    expect(data(results[0]!).sessionId).not.toBe(old.sessionId);
    expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(2);
  });
  test('legacy and triggered attempts share quota, while legacy retries remain new 201 sessions', async () => {
    const f = await fixture(3);
    expect((await f.request(legacy)).status).toBe(201);
    expect((await f.request(legacy)).status).toBe(201);
    const last = await f.request();
    expect(last.status).toBe(201);
    expect((await f.request()).status).toBe(200);
    expect(code(await f.request(legacy))).toBe('CONFLICT');
    expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(3);
  });
  test('quota rejection during replacement rolls back EXPIRED mutation; next UTC day can issue', async () => {
    const f = await fixture(1);
    const old = data(await f.request());
    f.advance(900000);
    expect(code(await f.request())).toBe('CONFLICT');
    expect((await db.prisma.mediaUploadSession.findUniqueOrThrow({ where: { id: old.sessionId } })).status).toBe(
      'ISSUED',
    );
    f.advance(86400000);
    const next = await f.request();
    expect(next.status).toBe(201);
    expect(data(next).sessionId).not.toBe(old.sessionId);
  });
  test('quota date and expiry are captured after a wait crossing UTC midnight', async () => {
    const f = await fixture(1);
    f.setTime(Date.parse('2026-11-06T23:59:59Z'));
    await seed(f, 1);
    f.deps.client = beforeTransaction(f.deps.client, async () => {
      f.advance(2000);
    });
    const result = await f.request();
    expect(result.status).toBe(201);
    expect(data(result).createdAt).toBe('2026-11-07T00:00:01.000Z');
    expect(data(result).uploadUrlExpiresAt).toBe('2026-11-07T00:15:01.000Z');
  });
  test.each(['revoke', 'assignment', 'suspend', 'retire'] as const)(
    '%s between initial auth and device lock denies signing/reuse',
    async (action) => {
      const f = await fixture();
      await f.request();
      f.deps.client = beforeTransaction(f.deps.client, async () => {
        if (action === 'revoke')
          await db.prisma.deviceCertificate.update({
            where: { id: f.cert.id },
            data: { status: 'REVOKED', revokedAt: new Date(f.now()) },
          });
        else if (action === 'assignment') {
          const other = await db.prisma.customer.create({ data: { name: randomUUID() } });
          await db.prisma.device.update({ where: { id: f.deviceId }, data: { customerId: other.id } });
        } else
          await db.prisma.device.update({
            where: { id: f.deviceId },
            data: { lifecycleStatus: action === 'suspend' ? 'Suspended' : 'Retired' },
          });
      });
      const result = await f.request();
      expect(result.status).toBe(action === 'revoke' ? 401 : 403);
      expect(f.sign).toHaveBeenCalledTimes(1);
      expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(1);
    },
  );
});

test('reuse across UTC midnight ignores exhausted new-day quota and retains the prior-day createdAt/expiry', async () => {
  const f = await fixture(1);
  f.setTime(Date.parse('2026-11-06T23:59:00Z'));
  const first = data(await f.request());
  f.advance(120000);
  await seed(f, 1);
  const retry = await f.request();
  expect(retry.status).toBe(200);
  expect(data(retry).createdAt).toBe(first.createdAt);
  expect(data(retry).uploadUrlExpiresAt).toBe(first.uploadUrlExpiresAt);
  expect(await db.prisma.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(2);
});
test('an audit failure rolls back expiry mutation and replacement quota; retry issues exactly once', async () => {
  const f = await fixture(2);
  const original = data(await f.request());
  f.advance(900000);
  const root = db.prisma;
  let fail = true;
  f.deps.client = new Proxy(root, {
    get(target, key) {
      if (key === '$transaction')
        return (work: (tx: unknown) => Promise<unknown>, options?: object) =>
          target.$transaction(
            async (tx) =>
              work(
                new Proxy(tx, {
                  get(actual, model) {
                    if (model === 'auditLog' && fail)
                      return new Proxy(actual.auditLog, {
                        get(delegate, op) {
                          if (op === 'create')
                            return () => {
                              fail = false;
                              throw new Error('injected audit failure');
                            };
                          return Reflect.get(delegate, op);
                        },
                      });
                    return Reflect.get(actual, model);
                  },
                }),
              ),
            options,
          );
      return Reflect.get(target, key);
    },
  });
  expect((await f.request()).status).toBe(500);
  expect((await root.mediaUploadSession.findUniqueOrThrow({ where: { id: original.sessionId } })).status).toBe(
    'ISSUED',
  );
  expect(await root.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(1);
  expect((await f.request()).status).toBe(201);
  expect(await root.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(2);
});
test('a queue wait crossing the old deadline recomputes expiry instead of reusing the expired attempt', async () => {
  const f = await fixture(2);
  const first = data(await f.request());
  f.advance(899000);
  f.deps.client = beforeTransaction(f.deps.client, async () => {
    f.advance(2000);
  });
  const next = await f.request();
  expect(next.status).toBe(201);
  expect(data(next).sessionId).not.toBe(first.sessionId);
});
