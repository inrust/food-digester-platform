/** IMG-13: actual migrated Prisma, registered images and resolver; AWS stays local. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ActorContext, Permission, Role } from '@fdp/auth';
import { certificateFingerprintFromPem } from '@fdp/auth';
import * as permissions from '../../../packages/auth/src/permissions.js';
import { generateTestKeySet, signToken, testConfig } from '../../../packages/auth/test/helpers.js';
import { handleMediaMetadata, resolveMediaEvidence } from '@fdp/media';
import type { MediaUploadSessionView } from '../src/media/service.js';
import { createDeviceMediaHandler } from '../src/media/device-handler.js';
import { createAdminMediaHandlers } from '../src/media/admin-handler.js';
import { createAdminAlarmHandlers } from '../src/admin/alarm/handler.js';
import { getAlarm, listDeviceEvents } from '../src/admin/alarm/service.js';
import type { AdminHttpRequest } from '../src/admin/onboarding/handler.js';
import { createAdminLambdaRouter, createAdminRoute } from '../src/runtime/admin-lambda.js';
import type { AdminOnboardingRouteSet } from '../src/runtime/admin-lambda.js';
import { createIngestionHandler } from '../../ingestion-worker/src/ingest/handler.js';
import { createMediaHandler } from '../../ingestion-worker/src/media/handler.js';
import { createAlarmHandler } from '../../ingestion-worker/src/signals/alarm.js';
import { createEventHandler } from '../../ingestion-worker/src/signals/event.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';

const jpeg = readFileSync(new URL('../../../contracts/rest/fixtures/device-images/capture.jpg', import.meta.url));
const hash = createHash('sha256').update(jpeg).digest('hex');
// Keep the frozen registration clock behind the database/Prisma update clock.
const NOW = new Date('2026-11-06T09:00:00Z');
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 60000);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db?.prisma.$disconnect();
  await db?.pg.close();
});
type Kind = 'ALARM' | 'EVENT';
const actor = (customerId: string | null, role: Role = 'CustomerViewer'): ActorContext => ({
  actorId: randomUUID(),
  username: 'reader',
  actorType: customerId ? 'customer' : 'platform',
  roles: [role],
  customerId,
  tokenUse: 'access',
});
const request = (reader: ActorContext | undefined, extra: Partial<AdminHttpRequest> = {}): AdminHttpRequest => ({
  actor: reader,
  headers: {},
  requestId: randomUUID(),
  ...extra,
});
function deny(permission: Permission) {
  const original = permissions.hasPermission;
  vi.spyOn(permissions, 'hasPermission').mockImplementation(
    (role, value) => value !== permission && original(role, value),
  );
}
async function fixture() {
  const suffix = randomUUID(),
    customerId = `c-${suffix}`,
    deviceId = `d-${suffix}`;
  const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(suffix).toString('base64')}\n-----END CERTIFICATE-----`;
  await db.prisma.customer.create({ data: { id: customerId, name: suffix } });
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
      id: suffix,
      deviceId,
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      notBefore: new Date('2026-01-01Z'),
      notAfter: new Date('2027-01-01Z'),
    },
  });
  const objects = new Map<string, Buffer>();
  const signer = vi.fn(async () => 'https://local.test/download');
  const deps = {
    client: db.prisma,
    now: () => NOW,
    storage: {
      statObject: async (key: string) => (objects.has(key) ? { sizeBytes: objects.get(key)!.length } : null),
      computeSha256: async (key: string) => (objects.has(key) ? hash : null),
    },
    urlSigner: { signUpload: async () => 'https://local.test/upload', signDownload: signer },
    uploadPolicy: {
      getMediaTypes: () => ['IMAGE', 'VIDEO'],
      getMaxSizeKb: () => 10240,
      getDailyUploadQuotaPerDevice: () => 100,
      getUploadUrlTtlSeconds: () => 900,
      getDownloadUrlTtlSeconds: () => 900,
    },
  };
  const source = async (kind: Kind, legacy = false) => {
    const sourceMessageId = legacy ? null : `SRC-${randomUUID()}`;
    const row =
      kind === 'ALARM'
        ? await db.prisma.alarm.create({
            data: {
              customerId,
              deviceId,
              sourceMessageId,
              code: 'SAME-CODE',
              category: 'MACHINE',
              severity: 'WARNING',
              detectedTime: new Date(NOW.getTime() - 5000),
            },
          })
        : await db.prisma.deviceEvent.create({
            data: { customerId, deviceId, sourceMessageId, eventType: 'START', occurredAt: NOW },
          });
    return { ...row, kind };
  };
  const upload = async (kind: Kind, messageId: string) => {
    const response = await createDeviceMediaHandler(deps)({
      identity: { clientCertPem: pem },
      requestId: randomUUID(),
      body: {
        mediaType: 'IMAGE',
        fileName: 'capture.jpg',
        sizeBytes: jpeg.length,
        sizeKb: Math.ceil(jpeg.length / 1024),
        sha256: hash,
        triggerRef: { kind, messageId },
      },
    });
    expect(response.status).toBe(201);
    assertOpenApiResponse('createMediaUploadSession', 201, response.body);
    const view = (response.body as { data: MediaUploadSessionView }).data;
    objects.set(view.objectPath, jpeg);
    return view;
  };
  const metadata = (view: MediaUploadSessionView) => ({
    meta: { id: `MED-${randomUUID()}`, ts: NOW.toISOString(), seq: 1, schemaVer: '1.0' },
    data: {
      mediaType: 'IMAGE',
      captureTime: NOW.toISOString(),
      fileName: view.fileName,
      sizeKb: view.sizeKb,
      objectPath: view.objectPath,
      durationSec: 0,
    },
  });
  const image = async (
    row: Awaited<ReturnType<typeof source>>,
    state: 'LINKED' | 'PENDING' | 'UNMATCHED' = 'LINKED',
  ) => {
    const view = await upload(row.kind, row.sourceMessageId!);
    const result = await handleMediaMetadata(deps, deviceId, metadata(view));
    expect(result.applied).toBe(true);
    const e = await db.prisma.mediaEvidence.findUniqueOrThrow({ where: { mediaId: result.mediaId! } });
    if (state !== 'PENDING')
      expect(
        await resolveMediaEvidence(
          { client: db.prisma, now: () => (state === 'UNMATCHED' ? new Date(NOW.getTime() + 86400000) : NOW) },
          e.id,
        ),
      ).toBe(state);
    return { mediaId: result.mediaId!, evidenceId: e.id, view };
  };
  const reader = actor(customerId),
    handlers = createAdminAlarmHandlers(deps);
  const read = async (row: Awaited<ReturnType<typeof source>>, who: ActorContext | undefined = reader) => {
    const response =
      row.kind === 'ALARM'
        ? await handlers.alarmDetail(request(who, { params: { alarmId: row.id } }))
        : await handlers.listEvents(request(who, { query: { deviceId } }));
    assertOpenApiResponse(row.kind === 'ALARM' ? 'getAlarm' : 'listDeviceEvents', response.status, response.body);
    const body = response.body as { data?: Record<string, any> | Record<string, any>[] };
    const data = Array.isArray(body.data) ? body.data.find((item) => item.eventId === row.id) : body.data;
    return { response, data };
  };
  return {
    customerId,
    deviceId,
    certId: suffix,
    pem,
    deps,
    objects,
    signer,
    source,
    upload,
    metadata,
    image,
    reader,
    handlers,
    read,
  };
}

describe('IMG-13 read contract and permission intersection', () => {
  test.each(['ALARM', 'EVENT'] as const)(
    '%s LINKED returns only AVAILABLE image metadata and existing authorized download',
    async (kind) => {
      const f = await fixture(),
        row = await f.source(kind),
        image = await f.image(row);
      const result = await f.read(row);
      expect(result.data?.evidenceImage).toEqual({
        mediaId: image.mediaId,
        captureTime: NOW.toISOString(),
        status: 'AVAILABLE',
      });
      const json = JSON.stringify(result.response.body);
      for (const hidden of [
        'objectPath',
        'sha256',
        'sourceMessageId',
        'triggerRef',
        'imageBase64',
        'uploadUrl',
        'downloadUrl',
      ])
        expect(json).not.toContain(hidden);
      expect(f.signer).not.toHaveBeenCalled();
      const download = await createAdminMediaHandlers(f.deps).createDownloadUrl(
        request(f.reader, { params: { mediaId: image.mediaId } }),
      );
      expect(download.status).toBe(200);
      assertOpenApiResponse('createMediaDownloadUrl', 200, download.body);
      expect(f.signer).toHaveBeenCalledTimes(1);
    },
  );
  test.each(['ALARM', 'EVENT'] as const)(
    '%s DELETED preserves association metadata but refuses a download URL',
    async (kind) => {
      const f = await fixture(),
        row = await f.source(kind),
        image = await f.image(row);
      const e = await db.prisma.mediaEvidence.findUniqueOrThrow({ where: { id: image.evidenceId } });
      await db.prisma.mediaObject.update({ where: { id: image.mediaId }, data: { status: 'DELETED' } });
      expect((await f.read(row)).data?.evidenceImage).toEqual({
        mediaId: image.mediaId,
        captureTime: NOW.toISOString(),
        status: 'DELETED',
      });
      const download = await createAdminMediaHandlers(f.deps).createDownloadUrl(
        request(f.reader, { params: { mediaId: image.mediaId } }),
      );
      expect(download.status).toBe(404);
      assertOpenApiResponse('createMediaDownloadUrl', 404, download.body);
      expect(f.signer).not.toHaveBeenCalled();
      expect(await db.prisma.mediaEvidence.findUnique({ where: { id: e.id } })).toEqual(e);
    },
  );
  test.each(['ALARM', 'EVENT'] as const)(
    '%s no image, PENDING and UNMATCHED return explicit null without writing',
    async (kind) => {
      const f = await fixture(),
        row = await f.source(kind);
      expect((await f.read(row)).data?.evidenceImage).toBeNull();
      const image = await f.image(row, 'PENDING');
      const pending = await db.prisma.mediaEvidence.findUniqueOrThrow({ where: { id: image.evidenceId } });
      expect((await f.read(row)).data?.evidenceImage).toBeNull();
      expect(await db.prisma.mediaEvidence.findUnique({ where: { id: pending.id } })).toEqual(pending);
      await resolveMediaEvidence({ client: db.prisma, now: () => pending.deadlineAt }, pending.id);
      expect((await f.read(row)).data?.evidenceImage).toBeNull();
      expect((await db.prisma.mediaEvidence.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('UNMATCHED');
    },
  );
  test.each(['ALARM', 'EVENT'] as const)(
    '%s legacy source with null messageId stays readable with null image',
    async (kind) => {
      const f = await fixture(),
        row = await f.source(kind, true);
      const spy = vi.spyOn(db.prisma.mediaEvidence, 'findMany');
      expect((await f.read(row)).data?.evidenceImage).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    },
  );
  test.each(['ALARM', 'EVENT'] as const)(
    '%s missing media:read omits the field and never queries images',
    async (kind) => {
      const f = await fixture(),
        row = await f.source(kind),
        image = await f.image(row);
      deny('media:read');
      const spy = vi.spyOn(db.prisma.mediaEvidence, 'findMany');
      const result = await f.read(row);
      expect(result.response.status).toBe(200);
      expect(result.data).not.toHaveProperty('evidenceImage');
      expect(JSON.stringify(result.response.body)).not.toContain(image.mediaId);
      expect(spy).not.toHaveBeenCalled();
    },
  );
  test.each(['ALARM', 'EVENT'] as const)('%s media permission alone cannot bypass source permission', async (kind) => {
    const f = await fixture(),
      row = await f.source(kind);
    await f.image(row);
    deny('alarm:read');
    const spy = vi.spyOn(db.prisma.mediaEvidence, 'findMany');
    const result = await f.read(row);
    expect(result.response.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    await expect(
      kind === 'ALARM' ? getAlarm(f.deps, f.reader, row.id) : listDeviceEvents(f.deps, f.reader),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  test.each(['ALARM', 'EVENT'] as const)('%s unauthenticated requests cannot read images', async (kind) => {
    const f = await fixture(),
      row = await f.source(kind);
    await f.image(row);
    const spy = vi.spyOn(db.prisma.mediaEvidence, 'findMany');
    const response =
      kind === 'ALARM'
        ? await f.handlers.alarmDetail(request(undefined, { params: { alarmId: row.id } }))
        : await f.handlers.listEvents(request(undefined, { query: { deviceId: f.deviceId } }));
    expect(response.status).toBe(401);
    assertOpenApiResponse(kind === 'ALARM' ? 'getAlarm' : 'listDeviceEvents', 401, response.body);
    expect(spy).not.toHaveBeenCalled();
  });
  test.each(['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'] as const)(
    '%s follows the current permission matrix',
    async (role) => {
      const f = await fixture(),
        row = await f.source('ALARM'),
        image = await f.image(row);
      const who = actor(role.startsWith('Customer') ? f.customerId : null, role);
      expect((await f.read(row, who)).data?.evidenceImage.mediaId).toBe(image.mediaId);
    },
  );
  test('a grant held by a later platform role remains effective', async () => {
    const f = await fixture(),
      row = await f.source('ALARM'),
      image = await f.image(row);
    const original = permissions.hasPermission;
    vi.spyOn(permissions, 'hasPermission').mockImplementation(
      (role, permission) => !(role === 'PlatformOperator' && permission === 'media:read') && original(role, permission),
    );
    expect(
      (await f.read(row, { ...actor(null, 'PlatformOperator'), roles: ['PlatformOperator', 'Auditor'] })).data
        ?.evidenceImage.mediaId,
    ).toBe(image.mediaId);
  });
});

describe('IMG-13 scope, lifecycle and bounded query', () => {
  test('foreign detail is 404; foreign events/media IDs never enter a customer response', async () => {
    const a = await fixture(),
      b = await fixture(),
      alarm = await b.source('ALARM'),
      event = await b.source('EVENT');
    const picture = await b.image(alarm);
    await b.image(event);
    const spy = vi.spyOn(db.prisma.mediaEvidence, 'findMany');
    const detail = await a.handlers.alarmDetail(request(a.reader, { params: { alarmId: alarm.id } }));
    expect(detail.status).toBe(404);
    assertOpenApiResponse('getAlarm', 404, detail.body);
    const events = await a.handlers.listEvents(
      request(a.reader, { query: { deviceId: b.deviceId, customerId: b.customerId } }),
    );
    expect(events.status).toBe(200);
    expect((events.body as { data: unknown[] }).data).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(JSON.stringify([detail.body, events.body])).not.toContain(picture.mediaId);
    const download = await createAdminMediaHandlers(a.deps).createDownloadUrl(
      request(a.reader, { params: { mediaId: picture.mediaId } }),
    );
    expect(download.status).toBe(404);
    expect(a.signer).not.toHaveBeenCalled();
  });
  test('acknowledge and clear preserve the original image; mutation responses and alarm list keep their scope', async () => {
    const f = await fixture(),
      row = await f.source('ALARM'),
      picture = await f.image(row),
      admin = actor(null, 'PlatformOperator');
    for (const action of ['acknowledge', 'clear'] as const) {
      const response = await f.handlers[action](
        request(admin, { params: { alarmId: row.id }, body: { reason: 'resolved' } }),
      );
      expect(response.status).toBe(200);
      assertOpenApiResponse(action === 'clear' ? 'clearAlarm' : 'acknowledgeAlarm', 200, response.body);
      expect((response.body as { data: unknown }).data).not.toHaveProperty('evidenceImage');
      expect((await f.read(row)).data?.evidenceImage.mediaId).toBe(picture.mediaId);
    }
    expect((await f.read(row)).data?.status).toBe('CLEARED');
    const list = await f.handlers.listAlarms(request(f.reader, { query: { deviceId: f.deviceId } }));
    expect((list.body as { data: unknown[] }).data[0]).not.toHaveProperty('evidenceImage');
  });
  test.each(['ALARM', 'EVENT'] as const)(
    '%s original tenant retains historical image after device assignment changes',
    async (kind) => {
      const f = await fixture(),
        other = await fixture(),
        row = await f.source(kind),
        image = await f.image(row);
      await db.prisma.device.update({ where: { id: f.deviceId }, data: { customerId: other.customerId } });
      expect((await f.read(row)).data?.evidenceImage.mediaId).toBe(image.mediaId);
      const foreign = await f.read(row, other.reader);
      expect(kind === 'ALARM' ? foreign.response.status : foreign.data).toBe(kind === 'ALARM' ? 404 : undefined);
      const download = await createAdminMediaHandlers(f.deps).createDownloadUrl(
        request(f.reader, { params: { mediaId: image.mediaId } }),
      );
      expect(download.status).toBe(200);
    },
  );
  test('same-code alarms and same-type events return their own media, never a nearby source image', async () => {
    const f = await fixture();
    for (const kind of ['ALARM', 'EVENT'] as const) {
      const a = await f.source(kind),
        b = await f.source(kind),
        first = await f.image(a),
        second = await f.image(b);
      expect((await f.read(a)).data?.evidenceImage.mediaId).toBe(first.mediaId);
      expect((await f.read(b)).data?.evidenceImage.mediaId).toBe(second.mediaId);
    }
  });
  test('event pages batch only visible rows, exclude lookahead, and preserve cursor/filter behavior', async () => {
    const f = await fixture(),
      sources = [];
    for (let i = 0; i < 4; i++) {
      const row = await f.source('EVENT');
      await f.image(row);
      sources.push(row);
    }
    const spy = vi.spyOn(db.prisma.mediaEvidence, 'findMany');
    const first = await f.handlers.listEvents(
      request(f.reader, { query: { deviceId: f.deviceId, eventType: 'START', limit: '2' } }),
    );
    assertOpenApiResponse('listDeviceEvents', 200, first.body);
    const page = first.body as { data: { eventId: string; evidenceImage: unknown }[]; meta: { nextCursor: string } };
    expect(page.data).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls[0]![0])).toContain(page.data[0]!.eventId);
    for (const row of sources.filter((row) => !page.data.some((item) => item.eventId === row.id)))
      expect(JSON.stringify(spy.mock.calls[0]![0])).not.toContain(row.id);
    spy.mockClear();
    const second = await f.handlers.listEvents(
      request(f.reader, { query: { deviceId: f.deviceId, limit: '2', cursor: page.meta.nextCursor } }),
    );
    const rest = second.body as { data: { eventId: string }[]; meta: { nextCursor: null } };
    expect(rest.data).toHaveLength(2);
    expect(rest.meta.nextCursor).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new Set([...page.data, ...rest.data].map((item) => item.eventId)).size).toBe(4);
  });
  test('fresh queries observe deletion and permission removal instead of cached image metadata', async () => {
    const f = await fixture(),
      row = await f.source('ALARM'),
      picture = await f.image(row);
    expect((await f.read(row)).data?.evidenceImage.status).toBe('AVAILABLE');
    await db.prisma.mediaObject.update({ where: { id: picture.mediaId }, data: { status: 'DELETED' } });
    expect((await f.read(row)).data?.evidenceImage.status).toBe('DELETED');
    deny('media:read');
    expect((await f.read(row)).data).not.toHaveProperty('evidenceImage');
  });
  test.each(['customerId', 'deviceId', 'mediaType', 'status'] as const)(
    'an invalid media %s projection fails closed even if a delegate returns it',
    async (field) => {
      const f = await fixture(),
        row = await f.source('ALARM');
      await f.image(row);
      const original = db.prisma.mediaEvidence.findMany.bind(db.prisma.mediaEvidence);
      // Test-only corrupt projection adapter; the awaited value deliberately violates the ORM result.
      vi.spyOn(db.prisma.mediaEvidence, 'findMany').mockImplementationOnce((async (
        args: Parameters<typeof original>[0],
      ) => {
        const rows = await original(args);
        return rows.map((entry: any) => ({
          ...entry,
          media: { ...entry.media, [field]: 'FOREIGN_OR_INVALID' },
        })) as never;
      }) as unknown as typeof original);
      expect((await f.read(row)).data?.evidenceImage).toBeNull();
    },
  );
  test('image lookup errors return a safe failure rather than a false no-image result', async () => {
    const f = await fixture(),
      row = await f.source('ALARM');
    await f.image(row);
    vi.spyOn(db.prisma.mediaEvidence, 'findMany').mockRejectedValueOnce(new Error('select private source details'));
    const response = await f.handlers.alarmDetail(request(f.reader, { params: { alarmId: row.id } }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('private');
  });
});

describe('IMG-13 local ingestion to JWT query', () => {
  test.each(['ALARM', 'EVENT'] as const)(
    '%s normal local entry chain returns evidenceImage and rejects a foreign JWT',
    async (kind) => {
      const f = await fixture(),
        sourceId = `SRC-${randomUUID()}`,
        quarantine = vi.fn();
      const ingress = createIngestionHandler({
        client: db.prisma,
        quarantine: { send: quarantine },
        onValidated: async (message) => {
          if (message.envelope.iotType === 'media') await createMediaHandler(f.deps)(message);
          else if (message.envelope.iotType === 'alarm') await createAlarmHandler(f.deps)(message);
          else await createEventHandler(f.deps)(message);
        },
      });
      const record = (type: string, meta: Record<string, unknown>, data: Record<string, unknown>) => ({
        messageId: randomUUID(),
        body: JSON.stringify({
          iotTopic: `bnx/device/${f.deviceId}/${type}`,
          iotDeviceId: f.deviceId,
          iotType: type,
          iotReceivedAt: NOW.getTime(),
          iotPrincipal: `arn:aws:iot:local:0:cert/${f.certId}`,
          meta,
          data,
        }),
      });
      const sourceRecord = record(
        kind.toLowerCase(),
        { id: sourceId, ts: NOW.toISOString(), seq: 1, schemaVer: '1.0' },
        kind === 'ALARM'
          ? {
              code: 'SAME-CODE',
              category: 'MACHINE',
              severity: 'WARNING',
              status: 'ACTIVE',
              detectedTime: NOW.toISOString(),
            }
          : { eventType: 'START', source: 'LOCAL' },
      );
      expect((await ingress({ Records: [sourceRecord] })).batchItemFailures).toEqual([]);
      const view = await f.upload(kind, sourceId),
        metadata = f.metadata(view),
        mediaRecord = record('media', metadata.meta, metadata.data);
      expect((await ingress({ Records: [mediaRecord, mediaRecord, sourceRecord] })).batchItemFailures).toEqual([]);
      expect(quarantine).not.toHaveBeenCalled();
      const evidence = await db.prisma.mediaEvidence.findUniqueOrThrow({
        where: {
          mediaId: (await db.prisma.mediaObject.findUniqueOrThrow({ where: { uploadSessionId: view.sessionId } })).id,
        },
      });
      expect(evidence.status).toBe('LINKED');
      const keys = await generateTestKeySet();
      // The router eagerly builds its full operation map; unrelated routes fail if invoked.
      const unused = new Proxy(
        {},
        {
          get: () => async () => {
            throw new Error('UNEXPECTED_ROUTE');
          },
        },
      );
      const routes = new Proxy(
        { alarms: f.handlers },
        {
          get: (target, key) => (key === 'liveImage' ? undefined : (Reflect.get(target, key) ?? unused)),
        },
      ) as unknown as AdminOnboardingRouteSet;
      const handler = createAdminLambdaRouter(testConfig(keys.jwks), (event) => createAdminRoute(event, routes));
      const path = kind === 'ALARM' ? `/api/v1/admin/alarms/${evidence.alarmId}` : '/api/v1/admin/events';
      const token = await signToken(keys, { groups: ['CustomerViewer'], customerId: f.customerId });
      const event = {
        path,
        httpMethod: 'GET',
        headers: { authorization: `Bearer ${token}` },
        queryStringParameters: { deviceId: f.deviceId },
      };
      const response = await handler(event);
      expect(response.statusCode).toBe(200);
      assertOpenApiResponse(kind === 'ALARM' ? 'getAlarm' : 'listDeviceEvents', 200, response.body);
      const body = JSON.parse(response.body);
      const data = kind === 'ALARM' ? body.data : body.data[0];
      expect(data.evidenceImage.mediaId).toBe(evidence.mediaId);
      const otherToken = await signToken(keys, { groups: ['CustomerViewer'], customerId: 'foreign-customer' });
      const forbidden = await handler({ ...event, headers: { authorization: `Bearer ${otherToken}` } });
      expect(forbidden.statusCode).toBe(kind === 'ALARM' ? 404 : 200);
      expect(forbidden.body).not.toContain(evidence.mediaId);
    },
  );
});
