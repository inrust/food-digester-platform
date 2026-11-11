import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { ActorContext } from '@fdp/auth';
import { certificateFingerprintFromPem } from '@fdp/auth';
import { withLiveImageAuthority } from '@fdp/aws-clients';
import type { PrismaClient } from '@fdp/database';
import { createTestDb } from './helpers.js';
import { TestControlStore, deferred } from './live-image-fixtures.js';
import { PostgresLiveImageAuthorization } from '../src/live-image/postgres-authorization.js';
import { LiveImageLeaseService } from '../src/live-image/service.js';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
// AUTH-03 hashes DER bytes; test public PEM is sufficient, TLS chain remains Gateway's responsibility.
const pem = generateKeyPairSync('rsa', { modulusLength: 1024 })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString()
  .replaceAll('PUBLIC KEY', 'CERTIFICATE');
const now = new Date('2026-11-06T08:00:00Z');
const actor: ActorContext = {
  actorId: 'sub-a',
  username: 'viewer',
  actorType: 'customer',
  roles: ['CustomerAdmin'],
  customerId: 'customer-a',
  tokenUse: 'access',
};
const viewer = '10000000-0000-4000-8000-000000000001';
let db: Awaited<ReturnType<typeof createTestDb>>,
  client: PrismaClient,
  store: TestControlStore,
  guard: PostgresLiveImageAuthorization,
  leases: LiveImageLeaseService;
beforeAll(async () => {
  db = await createTestDb();
  await db.pg.exec(readFileSync(new URL('../../../packages/database/prisma/seed.sql', import.meta.url), 'utf8'));
  await db.prisma.customer.createMany({
    data: [
      { id: 'customer-a', name: 'A' },
      { id: 'customer-b', name: 'B' },
    ],
  });
  await db.prisma.device.create({
    data: {
      id: 'camera',
      serialNumber: 'camera',
      model: 'test',
      hardwareVersion: '1',
      manufacturer: 'test',
      manufactureDate: now,
      customerId: 'customer-a',
      lifecycleStatus: 'Active',
    },
  });
  await db.prisma.deviceLatestState.create({
    data: { deviceId: 'camera', customerId: 'customer-a', operationalStatus: 'Active' },
  });
  await db.prisma.user.create({
    data: {
      id: 'user-a',
      email: 'a@example.com',
      displayName: 'A',
      cognitoSub: actor.actorId,
      status: 'ACTIVE',
      roles: { create: { roleCode: 'CustomerAdmin' } },
      scopes: { create: { customerId: 'customer-a' } },
    },
  });
  await db.prisma.deviceCertificate.create({
    data: {
      id: 'cert',
      deviceId: 'camera',
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      notBefore: new Date('2026-01-01Z'),
      notAfter: new Date('2027-01-01Z'),
    },
  });
}, 60000);
afterAll(async () => {
  await db?.prisma.$disconnect();
  await db?.pg.close();
});
beforeEach(async () => {
  await db.prisma.device.update({
    where: { id: 'camera' },
    data: { customerId: 'customer-a', lifecycleStatus: 'Active' },
  });
  await db.prisma.deviceLatestState.update({ where: { deviceId: 'camera' }, data: { operationalStatus: 'Active' } });
  await db.prisma.deviceCertificate.update({ where: { id: 'cert' }, data: { status: 'ACTIVE', revokedAt: null } });
  await db.prisma.user.update({
    where: { id: 'user-a' },
    data: {
      status: 'ACTIVE',
      roles: { deleteMany: {}, create: { roleCode: 'CustomerAdmin' } },
      scopes: { deleteMany: {}, create: { customerId: 'customer-a' } },
    },
  });
  store = new TestControlStore();
  client = withLiveImageAuthority(db.prisma, store);
  guard = new PostgresLiveImageAuthorization(client, () => now);
  leases = new LiveImageLeaseService({ store, authorization: guard, now: () => now });
});
describe('IMG-08 PostgreSQL fresh authorization and authority protocol (PGlite)', () => {
  test.each([null, false, true])('legacy policy %s has no effect on preview eligibility', async (enabled) => {
    if (enabled !== null) await db.prisma.deviceLiveImagePolicy.create({ data: { deviceId: 'camera', enabled } });
    try {
      await expect(leases.getDeviceState({ clientCertPem: pem })).resolves.toMatchObject({ state: 'IDLE' });
      const lease = await leases.renewViewer(actor, 'camera', viewer);
      await expect(leases.getDeviceState({ clientCertPem: pem })).resolves.toMatchObject({
        state: 'ACTIVE',
        streamId: lease.streamId,
      });
    } finally {
      await db.prisma.deviceLiveImagePolicy.deleteMany({ where: { deviceId: 'camera' } });
    }
  });
  test('uses current database roles rather than JWT roles', async () => {
    await leases.renewViewer(actor, 'camera', viewer);
    const old = await store.readControl('camera');
    await client.userRole.deleteMany({ where: { userId: 'user-a' } });
    expect((await store.readControl('camera'))!.authEpoch).toBeGreaterThan(old!.authEpoch);
    expect((await store.readControl('camera'))!.viewers).toEqual([]);
    await expect(leases.renewViewer(actor, 'camera', viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  test.each(['DISABLED', 'INVITED'])('denies fresh account status %s', async (status) => {
    await client.user.update({ where: { id: 'user-a' }, data: { status } });
    await expect(leases.renewViewer(actor, 'camera', viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  test('changed customer scope cannot use old token scope', async () => {
    await leases.renewViewer(actor, 'camera', viewer);
    await client.userScope.updateMany({ where: { userId: 'user-a' }, data: { customerId: 'customer-b' } });
    await expect(leases.renewViewer(actor, 'camera', viewer)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  test.each([
    [
      'assignment',
      (tx: PrismaClient) => tx.device.update({ where: { id: 'camera' }, data: { customerId: 'customer-b' } }),
    ],
    [
      'suspend',
      (tx: PrismaClient) =>
        tx.deviceLatestState.update({ where: { deviceId: 'camera' }, data: { operationalStatus: 'Suspended' } }),
    ],
    [
      'retire',
      (tx: PrismaClient) => tx.device.update({ where: { id: 'camera' }, data: { lifecycleStatus: 'Retired' } }),
    ],
  ] as const)('%s clears prior stream before authority commit', async (_name, mutate) => {
    await leases.renewViewer(actor, 'camera', viewer);
    const old = (await store.readControl('camera'))!;
    await mutate(client);
    const fresh = (await store.readControl('camera'))!;
    expect(fresh.streamId).toBeNull();
    expect(fresh.viewers).toEqual([]);
    expect(fresh.authEpoch).toBeGreaterThan(old.authEpoch);
    await expect(leases.renewViewer(actor, 'camera', viewer)).rejects.toBeDefined();
  });
  test('certificate revocation fails device state even with valid CA/old identity', async () => {
    expect(await leases.getDeviceState({ clientCertPem: pem })).toMatchObject({ state: 'IDLE' });
    await client.deviceCertificate.update({ where: { id: 'cert' }, data: { status: 'REVOKED', revokedAt: now } });
    await expect(leases.getDeviceState({ clientCertPem: pem })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  test('fence exists before SQL and rollback can only recover by opening a fresh stream', async () => {
    const previous = await leases.renewViewer(actor, 'camera', viewer);
    await expect(
      client.$transaction(async (tx) => {
        await tx.device.update({ where: { id: 'camera' }, data: { lifecycleStatus: 'Suspended' } });
        expect((await store.readControl('camera'))!.enabled).toBe(false);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    expect((await db.prisma.device.findUnique({ where: { id: 'camera' } }))!.lifecycleStatus).toBe('Active');
    expect((await store.readControl('camera'))!.enabled).toBe(false);
    await expect(leases.getDeviceState({ clientCertPem: pem })).resolves.toMatchObject({ state: 'IDLE' });
    const next = await leases.renewViewer(actor, 'camera', viewer);
    expect(next.streamId).not.toBe(previous.streamId);
  });
  test('DynamoDB failure aborts authority SQL and never falls back to local state', async () => {
    await leases.renewViewer(actor, 'camera', viewer);
    store.compareAndSwap = async () => {
      throw new Error('DDB unavailable');
    };
    await expect(client.user.update({ where: { id: 'user-a' }, data: { status: 'DISABLED' } })).rejects.toThrow(
      'DDB unavailable',
    );
    expect((await db.prisma.user.findUnique({ where: { id: 'user-a' } }))!.status).toBe('ACTIVE');
  });
  test('array transactions are lazy and atomic, including rollback and raw SQL', async () => {
    const update = client.user.update({ where: { id: 'user-a' }, data: { status: 'DISABLED' } });
    expect((await db.prisma.user.findUnique({ where: { id: 'user-a' } }))!.status).toBe('ACTIVE');
    await expect(
      client.$transaction([
        update,
        client.user.create({ data: { id: 'user-a', email: 'duplicate@example.com', displayName: 'dup' } }),
      ]),
    ).rejects.toBeDefined();
    expect((await db.prisma.user.findUnique({ where: { id: 'user-a' } }))!.status).toBe('ACTIVE');
    await client.$transaction([client.$executeRaw`UPDATE users SET status = 'DISABLED' WHERE id = 'user-a'`]);
    await expect(leases.renewViewer(actor, 'camera', viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  test('unchanged Heartbeat status and certificate bookkeeping do not invalidate preview', async () => {
    await leases.renewViewer(actor, 'camera', viewer);
    const old = await store.readControl('camera');
    await client.deviceLatestState.upsert({
      where: { deviceId: 'camera' },
      create: { deviceId: 'camera', customerId: 'customer-a', operationalStatus: 'Active' },
      update: { operationalStatus: 'Active', lastHeartbeatAt: now },
    });
    // Reproduce the dynamic repository delegate boundary; Prisma ignores undefined fields.
    await (client.deviceLatestState as unknown as { update(args: unknown): Promise<unknown> }).update({
      where: { deviceId: 'camera' },
      data: { operationalStatus: undefined, lastHeartbeatAt: now },
    });
    await client.deviceCertificate.update({ where: { id: 'cert' }, data: { restVerifiedAt: now } });
    expect(await store.readControl('camera')).toEqual(old);
  });
  test('root client mutations inside exclusive service callback reuse transaction, no nested commit', async () => {
    await leases.renewViewer(actor, 'camera', viewer);
    await leases.fenceAuthorization('camera', async () => {
      await client.device.update({ where: { id: 'camera' }, data: { lifecycleStatus: 'Suspended' } });
    });
    expect((await db.prisma.device.findUnique({ where: { id: 'camera' } }))!.lifecycleStatus).toBe('Suspended');
    expect((await store.readControl('camera'))!.enabled).toBe(false);
  });
});

test('in-flight guarded read finishes before queued authority commit; subsequent reads refresh permissions (single PGlite backend)', async () => {
  await leases.renewViewer(actor, 'camera', viewer);
  const entered = deferred(),
    release = deferred();
  let committed = false;
  const read = guard.withRead({ kind: 'viewer', actor, deviceId: 'camera' }, async () => {
    entered.resolve();
    await release.promise;
    return 'old snapshot';
  });
  await entered.promise;
  const write = client.userRole.deleteMany({ where: { userId: 'user-a' } }).then(() => {
    committed = true;
  });
  await Promise.resolve();
  expect(committed).toBe(false);
  release.resolve();
  expect(await read).toBe('old snapshot');
  await write;
  await expect(leases.renewViewer(actor, 'camera', viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
test('row-lock SELECT and repository-owned onboarding rate counters do not invalidate active streams', async () => {
  const { PostgresRateLimitStore } = await import('@fdp/auth');
  await leases.renewViewer(actor, 'camera', viewer);
  const old = await store.readControl('camera');
  await client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM devices WHERE id = $1 FOR UPDATE', 'camera');
  });
  const counters = new PostgresRateLimitStore(client);
  expect(await counters.hit('synthetic-key', now.getTime() / 1000, now.getTime() / 1000 + 60)).toBe(1);
  await counters.prune(now.getTime() / 1000 - 60);
  expect(await store.readControl('camera')).toEqual(old);
});
test('structured logs and audit payloads redact JPEG Base64', async () => {
  const { redactSensitive } = await import('@fdp/observability');
  const { sanitizeAuditPayload } = await import('@fdp/database');
  const payload = { frameId: 'f', imageBase64: '/9j/private-image', nested: { jpeg_base64: '/9j/private-image' } };
  for (const redact of [redactSensitive, sanitizeAuditPayload]) {
    expect(redact(payload)).toEqual({ frameId: 'f', imageBase64: '[REDACTED]', nested: { jpeg_base64: '[REDACTED]' } });
  }
});
test('five HTTP preview routes run renew -> state -> JPEG upload -> READY/UNCHANGED -> release, with fresh PostgreSQL auth', async () => {
  const { createLiveImageLeaseHandlers, createLiveImageFrameHandler, createLiveImageLatestHandler } =
    await import('../src/live-image/handler.js');
  const { createAdminRoute, createAdminLambdaRouter } = await import('../src/runtime/admin-lambda.js');
  const { createDeviceApiLambdaHandler } = await import('../src/runtime/device-lambda.js');
  const { generateTestKeySet, signToken, testConfig } = await import('../../../packages/auth/test/helpers.js');
  const deps = { store, authorization: guard, now: () => now };
  const live = createLiveImageLeaseHandlers(deps),
    keys = await generateTestKeySet();
  const token = await signToken(keys, { sub: actor.actorId, groups: ['CustomerAdmin'], customerId: 'customer-a' });
  const routes = {
    liveImage: {
      renewViewer: live.renewViewer,
      releaseViewer: live.releaseViewer,
      latest: createLiveImageLatestHandler(deps),
    },
  } as unknown as import('../src/runtime/admin-lambda.js').AdminOnboardingRouteSet;
  const admin = createAdminLambdaRouter(testConfig(keys.jwks), (event) => createAdminRoute(event, routes));
  const call = (httpMethod: string, suffix: string, queryStringParameters?: Record<string, string>) =>
    admin({
      httpMethod,
      path: `/api/v1/admin/devices/camera/live-image/${suffix}`,
      headers: { authorization: `Bearer ${token}` },
      ...(queryStringParameters ? { queryStringParameters } : {}),
    });
  const unused = async () => ({ status: 404, body: {} });
  const device = createDeviceApiLambdaHandler({
    certificateStatus: unused,
    certificateRotate: unused,
    sync: unused,
    deactivate: unused,
    otaDownload: unused,
    mediaUpload: unused,
    liveImageState: live.getDeviceState,
    liveImageFrame: createLiveImageFrameHandler(deps),
  });
  const deviceCall = (method: string, suffix: string, body?: unknown) =>
    device({
      httpMethod: method,
      path: `/api/v1/device/live-image/${suffix}`,
      headers: { 'content-type': 'application/json' },
      requestContext: { identity: { clientCert: { clientCertPem: pem } } },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const idle = await deviceCall('GET', 'state');
  expect(idle.statusCode).toBe(200);
  expect(JSON.parse(idle.body).data).toEqual({ state: 'IDLE', pollIntervalMs: 5000 });
  const lease = await call('PUT', `viewers/${viewer}`);
  expect(lease.statusCode).toBe(200);
  const streamId = JSON.parse(lease.body).data.streamId;
  expect(JSON.parse((await deviceCall('GET', 'state')).body).data).toMatchObject({ state: 'ACTIVE', streamId });
  const imageBase64 = readFileSync(
    new URL('../../../contracts/rest/fixtures/device-images/capture.jpg', import.meta.url),
  ).toString('base64');
  const upload = await deviceCall('POST', 'frames', {
    streamId,
    frameId: '20000000-0000-4000-8000-000000000001',
    capturedAt: now.toISOString(),
    mimeType: 'image/jpeg',
    imageBase64,
  });
  expect(upload.statusCode).toBe(200);
  const ready = await call('GET', 'latest', { viewerId: viewer });
  expect(ready.statusCode).toBe(200);
  expect(JSON.parse(ready.body).data).toMatchObject({ state: 'READY', streamId, imageBase64 });
  const unchanged = await call('GET', 'latest', {
    viewerId: viewer,
    knownFrameId: '20000000-0000-4000-8000-000000000001',
  });
  expect(JSON.parse(unchanged.body).data).toMatchObject({ state: 'UNCHANGED' });
  expect(unchanged.body).not.toContain(imageBase64);
  const release = await call('DELETE', `viewers/${viewer}`);
  expect(release.statusCode).toBe(204);
  expect(release.body).toBe('');
  expect((await call('GET', 'latest', { viewerId: viewer })).statusCode).toBe(409);
  expect(JSON.parse((await deviceCall('GET', 'state')).body).data.state).toBe('IDLE');
  await call('PUT', `viewers/${viewer}`);
  await client.userRole.deleteMany({ where: { userId: 'user-a' } });
  expect((await call('GET', 'latest', { viewerId: viewer })).statusCode).toBe(403);
});
test('device and user revocation preserve unrelated device streams; JSON data cannot impersonate Prisma relation writes', async () => {
  const other = 'unrelated-camera';
  await db.prisma.device.create({
    data: {
      id: other,
      serialNumber: other,
      model: 'test',
      hardwareVersion: '1',
      manufacturer: 'test',
      manufactureDate: now,
      customerId: 'customer-b',
      lifecycleStatus: 'Active',
    },
  });
  try {
    await leases.renewViewer(actor, 'camera', viewer);
    const current = (await store.readControl('camera'))!;
    const unrelated = {
      ...current,
      deviceId: other,
      customerId: 'customer-b',
      viewers: [{ ...current.viewers[0]!, actorId: 'other-sub' }],
    };
    store.controls.set(other, unrelated);
    await client.userRole.deleteMany({ where: { userId: 'user-a' } });
    expect(await store.readControl(other)).toEqual(unrelated);
    await client.deviceLatestState.update({ where: { deviceId: 'camera' }, data: { operationalStatus: 'Suspended' } });
    expect(await store.readControl(other)).toEqual(unrelated);
    await client.outboxEvent.create({
      data: {
        eventType: 'SYNTHETIC',
        aggregateType: 'device',
        aggregateId: 'camera',
        payload: { device: { update: { customerId: 'malicious-json' } } },
      },
    });
    expect(await store.readControl(other)).toEqual(unrelated);
  } finally {
    await db.prisma.device.delete({ where: { id: other } });
  }
});
