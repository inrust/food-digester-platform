/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** IMG-19 local composition: real Lambda/HTTP/MQTT/Prisma paths, migrated PGlite and local storage ports. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { certificateFingerprintFromPem } from '@fdp/auth';
import type { SecurePackageService } from '@fdp/auth';
import { withLiveImageAuthority } from '@fdp/aws-clients';
import {
  getMediaTypes,
  getMaxSizeKb,
  getDailyUploadQuotaPerDevice,
  getUploadUrlTtlSeconds,
  getDownloadUrlTtlSeconds,
} from '@fdp/contracts/media/media-upload-policy.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';
import { matchDeliveredOperation } from '../src/runtime/delivered-operations.js';
import { TestControlStore } from './live-image-fixtures.js';
import {
  createLiveImageLeaseHandlers,
  createLiveImageFrameHandler,
  createLiveImageLatestHandler,
  PostgresLiveImageAuthorization,
} from '../src/live-image/index.js';
import { createDeviceMediaHandler } from '../src/media/device-handler.js';
import { createAdminMediaHandlers } from '../src/media/admin-handler.js';
import { createAdminAlarmHandlers } from '../src/admin/alarm/handler.js';
import { createDeviceApiLambdaHandler } from '../src/runtime/device-lambda.js';
import { createAdminLambdaRouter, createAdminRoute } from '../src/runtime/admin-lambda.js';
import type { AdminOnboardingRouteSet, ApiGatewayAdminEvent } from '../src/runtime/admin-lambda.js';
import { createAdminAuthenticatedAccountHook } from '../src/runtime/admin-account-hook.js';
import { withAdminCors } from '../src/runtime/admin-cors.js';
import { generateTestKeySet, signToken, testConfig } from '../../../packages/auth/test/helpers.js';
import { createApiClient, createHttpApiFetch } from '../../admin-web/src/api/http-client.js';
import { SessionManager } from '../../admin-web/src/session/session-manager.js';
import { InMemorySessionStore } from '../../admin-web/src/session/session-store.js';
import { createIngestionHandler } from '../../ingestion-worker/src/ingest/handler.js';
import { createBusinessDispatcher } from '../../ingestion-worker/src/ingest/dispatcher.js';
import { runMediaEvidenceWorker } from '../../ingestion-worker/src/media/evidence-worker.js';

export const jpeg = readFileSync(
  new URL('../../../contracts/rest/fixtures/device-images/capture.jpg', import.meta.url),
);
export const jpegHash = createHash('sha256').update(jpeg).digest('hex');
export async function imageIntegrationFixture(db: Awaited<ReturnType<typeof createTestDb>>) {
  const suffix = randomUUID(),
    customerId = `c-${suffix}`,
    deviceId = `d-${suffix}`,
    certId = `crt-${suffix}`;
  const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(suffix).toString('base64')}\n-----END CERTIFICATE-----`;
  let time = Date.parse('2026-11-07T08:00:00Z');
  const now = () => new Date(time);
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
  await db.prisma.deviceLatestState.create({ data: { deviceId, customerId, operationalStatus: 'Active' } });
  await db.prisma.deviceCertificate.create({
    data: {
      id: certId,
      deviceId,
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      notBefore: new Date('2026-01-01Z'),
      notAfter: new Date('2028-01-01Z'),
    },
  });
  const store = new TestControlStore();
  store.now = () => time;
  const client = withLiveImageAuthority(db.prisma, store);
  const authorization = new PostgresLiveImageAuthorization(client, now);
  const liveDeps = { store, authorization, now },
    live = createLiveImageLeaseHandlers(liveDeps);
  const objects = new Map<string, Buffer>();
  const storage = {
    statObject: vi.fn(async (key: string) => (objects.has(key) ? { sizeBytes: objects.get(key)!.length } : null)),
    computeSha256: vi.fn(async (key: string) =>
      objects.has(key) ? createHash('sha256').update(objects.get(key)!).digest('hex') : null,
    ),
  };
  const uploadPolicy = {
    getMediaTypes,
    getMaxSizeKb: (type: string) => (type === 'IMAGE' || type === 'VIDEO' ? getMaxSizeKb(type) : undefined),
    getDailyUploadQuotaPerDevice,
    getUploadUrlTtlSeconds,
    getDownloadUrlTtlSeconds,
  };
  const mediaDeps = {
    client,
    now,
    storage,
    uploadPolicy,
    urlSigner: {
      signUpload: vi.fn(async ({ key }: { key: string }) => `https://s3.example.invalid/${key}?fixture=upload`),
      signDownload: vi.fn(async ({ key }: { key: string }) => `https://s3.example.invalid/${key}?fixture=download`),
    },
  };
  const unused = vi.fn(async () => {
    throw new Error('UNEXPECTED_UNRELATED_ROUTE');
  });
  const deviceLambda = createDeviceApiLambdaHandler({
    certificateStatus: unused,
    certificateRotate: unused,
    sync: unused,
    deactivate: unused,
    otaDownload: unused,
    mediaUpload: createDeviceMediaHandler(mediaDeps),
    liveImageState: live.getDeviceState,
    liveImageFrame: createLiveImageFrameHandler(liveDeps),
  });
  const unusedGroup = new Proxy({}, { get: () => unused });
  const routes = new Proxy(
    {
      liveImage: {
        renewViewer: live.renewViewer,
        releaseViewer: live.releaseViewer,
        latest: createLiveImageLatestHandler(liveDeps),
      },
      media: createAdminMediaHandlers(mediaDeps),
      alarms: createAdminAlarmHandlers({ client, now }),
    },
    { get: (target, key) => Reflect.get(target, key) ?? unusedGroup },
  ) as unknown as AdminOnboardingRouteSet;
  const keys = await generateTestKeySet();
  const adminLambda = createAdminLambdaRouter(testConfig(keys.jwks), (event) => createAdminRoute(event, routes), {
    onAuthenticated: createAdminAuthenticatedAccountHook(client, async () => {}, false),
  });
  const calls: { path: string; method: string; query: string }[] = [];
  async function viewer(name: string, scope = customerId) {
    const id = `u-${randomUUID()}`,
      sub = `sub-${randomUUID()}`;
    await client.user.create({
      data: {
        id,
        email: `${id}@example.invalid`,
        displayName: name,
        cognitoSub: sub,
        status: 'ACTIVE',
        roles: { create: { roleCode: 'CustomerViewer' } },
        scopes: { create: { customerId: scope } },
      },
    });
    const token = await signToken(keys, {
      sub,
      username: name,
      groups: ['CustomerViewer'],
      customerId: scope,
      tokenUse: 'id',
    });
    const session = new SessionManager({
      store: new InMemorySessionStore(),
      refreshTokens: async () => {
        throw new Error('UNEXPECTED_REFRESH');
      },
      signOut: async () => {},
    });
    session.establish({
      username: name,
      roles: ['CustomerViewer'],
      customerId: scope,
      idToken: token,
      accessToken: await signToken(keys, { sub, groups: ['CustomerViewer'], customerId: scope }),
      refreshToken: 'local-refresh',
      expiresInSeconds: 3600,
      obtainedAtMs: Date.now(),
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      init?.signal?.throwIfAborted();
      const url = new URL(String(input));
      if (url.origin !== 'https://local.invalid') throw new Error('NETWORK_DISABLED');
      calls.push({ path: url.pathname, method: init?.method ?? 'GET', query: url.search });
      const event: ApiGatewayAdminEvent = {
        path: url.pathname,
        httpMethod: init?.method ?? 'GET',
        headers: {
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          origin: 'https://admin.example.invalid',
        },
        body: typeof init?.body === 'string' ? init.body : null,
        queryStringParameters: Object.fromEntries(url.searchParams),
        requestContext: { requestId: randomUUID() },
      };
      const result = await withAdminCors(event, 'https://admin.example.invalid', () => adminLambda(event));
      const operation = matchDeliveredOperation('admin-api', event.httpMethod!, event.path!);
      if (operation && result.statusCode !== 204)
        assertOpenApiResponse(operation.operation.operationId, result.statusCode, result.body);
      if (url.pathname.includes('/live-image/')) {
        if (
          result.headers['Cache-Control'] !== 'no-store' ||
          result.headers['Access-Control-Allow-Origin'] !== 'https://admin.example.invalid'
        )
          throw new Error('INVALID_PREVIEW_RESPONSE_HEADERS');
      }
      init?.signal?.throwIfAborted();
      return new Response(result.statusCode === 204 ? null : result.body, {
        status: result.statusCode,
        headers: { ...result.headers },
      });
    };
    return {
      id,
      sub,
      token,
      api: createApiClient({ baseUrl: 'https://local.invalid/api/v1', session, fetch: createHttpApiFetch(fetch) }),
    };
  }
  const alice = await viewer('alice'),
    bob = await viewer('bob');
  const device = async (path: string, body?: unknown) => {
    const result = await deviceLambda({
      path: `/api/v1/device/${path}`,
      httpMethod: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      requestContext: { identity: { clientCert: { clientCertPem: pem } }, requestId: randomUUID() },
    });
    const payload = JSON.parse(result.body);
    const operation = matchDeliveredOperation(
      'device-api',
      body === undefined ? 'GET' : 'POST',
      `/api/v1/device/${path}`,
    );
    if (operation) assertOpenApiResponse(operation.operation.operationId, result.statusCode, payload);
    return { status: result.statusCode, headers: result.headers, body: payload };
  };
  const quarantine = { send: vi.fn(async () => {}) };
  const ingestion = createIngestionHandler({
    client,
    quarantine,
    onValidated: createBusinessDispatcher({
      client,
      now,
      mediaStorage: storage,
      mediaUploadPolicy: uploadPolicy,
      securePackage: {} as SecurePackageService,
      certificateRevoker: { revokeCertificate: unused },
    }),
  });
  const sequences = new Map<string, number>();
  const record = (type: string, id: string, data: Record<string, unknown>) => {
    const seq = (sequences.get(type) ?? 0) + 1;
    sequences.set(type, seq);
    return {
      messageId: randomUUID(),
      body: JSON.stringify({
        iotTopic: `bnx/device/${deviceId}/${type}`,
        iotType: type,
        iotDeviceId: deviceId,
        iotPrincipal: `arn:aws:iot:local:0:cert/${certId}`,
        iotReceivedAt: time,
        meta: { id, ts: now().toISOString(), seq },
        data,
      }),
    };
  };
  const source = (kind: 'EVENT' | 'ALARM', id: string) =>
    record(
      kind === 'EVENT' ? 'event' : 'alarm',
      id,
      kind === 'EVENT'
        ? { eventType: 'MACHINE_STARTED', source: 'LOCAL' }
        : {
            code: 'TEMP_HIGH',
            status: 'ACTIVE',
            severity: 'HIGH',
            category: 'TEMPERATURE',
            detectedTime: now().toISOString(),
          },
    );
  const declaration = (kind: 'EVENT' | 'ALARM', messageId: string) => ({
    mediaType: 'IMAGE',
    fileName: 'capture.jpg',
    sizeBytes: jpeg.length,
    sizeKb: Math.ceil(jpeg.length / 1024),
    sha256: jpegHash,
    triggerRef: { kind, messageId },
  });
  const frame = (streamId: string, capturedAt = now().toISOString()) => ({
    streamId,
    frameId: randomUUID(),
    capturedAt,
    mimeType: 'image/jpeg',
    imageBase64: jpeg.toString('base64'),
  });
  return {
    db,
    client,
    store,
    objects,
    storage,
    mediaDeps,
    customerId,
    deviceId,
    certId,
    alice,
    bob,
    viewer,
    calls,
    device,
    frame,
    now,
    advance: (ms: number) => {
      time += ms;
    },
    record,
    source,
    declaration,
    ingest: (Records: ReturnType<typeof record>[]) => ingestion({ Records }),
    quarantine,
    worker: () => runMediaEvidenceWorker({ client, now }, { pageSize: 2, maxPages: 3 }),
  };
}
