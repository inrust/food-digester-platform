import forge from 'node-forge';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createRateLimiter, InMemoryRateLimitStore } from '@fdp/auth';
import { createAdminOnboardingHandlers, createOnboardingRequestHandler } from '../src/index.js';
import { createTestDb } from './helpers.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.prisma.$disconnect();
  await db.pg.close();
});
const csr = forge.pki.createCertificationRequest();
const keys = forge.pki.rsa.generateKeyPair(2048);
csr.publicKey = keys.publicKey;
csr.setSubject([{ name: 'commonName', value: 'first-request' }]);
csr.sign(keys.privateKey, forge.md.sha256.create());
const body = {
  serialNumber: '05DCFF33-32594232-43027614',
  model: 'BNX-100',
  hardwareVersion: '1',
  manufacturer: 'Bio-Nexa',
  manufactureDate: '2026-01-01',
  csrPem: forge.pki.certificationRequestToPem(csr),
};
const limiter = createRateLimiter(new InMemoryRateLimitStore(), { limit: 1000, windowSeconds: 60 });
const submit = (serialNumber: string) =>
  createOnboardingRequestHandler({ client: db.prisma, rateLimiter: limiter })({
    headers: {},
    body: { ...body, serialNumber },
    requestId: 'http-trace',
  });

describe('设备先申请，管理员后审核', () => {
  test('没有任何库存也能创建 PENDING；不提前创建设备或绑定公钥', async () => {
    const response = await submit(body.serialNumber);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ requestId: expect.any(String), status: 'PENDING' });
    expect(await db.prisma.device.count()).toBe(0);
    expect(await db.prisma.devicePublicKey.count()).toBe(0);
    expect(await db.prisma.onboardingProvisioningJob.count()).toBe(0);
    const duplicate = await submit(body.serialNumber);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      error: { code: 'CONFLICT', message: expect.stringContaining('already been submitted') },
    });
    expect(await db.prisma.onboardingRequest.count()).toBe(1);
  });

  test.each(['APPROVED', 'REJECTED', 'TIMED_OUT'])('%s 历史申请也不能再次提交', async (status) => {
    const serialNumber = `SN-FIRST-${status.replaceAll('_', '-')}`;
    expect((await submit(serialNumber)).status).toBe(201);
    await db.prisma.onboardingRequest.updateMany({ where: { serialNumber }, data: { status } });
    const original = await db.prisma.onboardingRequest.findFirstOrThrow({ where: { serialNumber } });
    expect((await submit(serialNumber)).status).toBe(409);
    expect(await db.prisma.onboardingRequest.findFirstOrThrow({ where: { serialNumber } })).toEqual(original);
    expect(await db.prisma.onboardingRequest.count({ where: { serialNumber } })).toBe(1);
  });

  test('五个并发首次提交恰好一个 201、四个 409', async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => submit('SN-FIRST-RACE')));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(await db.prisma.onboardingRequest.count({ where: { serialNumber: 'SN-FIRST-RACE' } })).toBe(1);
  });

  test('真实 CSR 首次申请可直接批准，创建设备并排队发证', async () => {
    const request = await db.prisma.onboardingRequest.findFirstOrThrow({ where: { serialNumber: body.serialNumber } });
    const handlers = createAdminOnboardingHandlers({ client: db.prisma });
    const response = await handlers.approve({
      actor: {
        actorId: 'first-request-admin',
        username: 'admin',
        actorType: 'platform',
        roles: ['PlatformSuperAdmin'],
        customerId: null,
        tokenUse: 'access',
      },
      headers: { 'If-Match': '1' },
      params: { requestId: request.id },
      query: {},
      requestId: 'approve-first-request',
    });
    expect(response.status).toBe(200);
    const device = await db.prisma.device.findUniqueOrThrow({ where: { serialNumber: body.serialNumber } });
    expect(device.lifecycleStatus).toBe('OnboardingApproved');
    expect(
      await db.prisma.devicePublicKey.findFirst({ where: { fingerprint: request.publicKeyFingerprint } }),
    ).toMatchObject({ deviceId: device.id });
    expect(await db.prisma.onboardingProvisioningJob.findUnique({ where: { requestId: request.id } })).toMatchObject({
      status: 'PENDING',
    });
  });
});
