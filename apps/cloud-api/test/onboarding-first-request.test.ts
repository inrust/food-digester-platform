import forge from 'node-forge';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createRateLimiter, InMemoryRateLimitStore } from '@fdp/auth';
import { createAdminOnboardingHandlers, createOnboardingRequestHandler } from '../src/index.js';
import { csrFixture } from './certificate-fixtures.js';
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
const submit = (serialNumber: string, fields: Partial<typeof body> = {}) =>
  createOnboardingRequestHandler({ client: db.prisma, rateLimiter: limiter })({
    headers: {},
    body: { ...body, ...fields, serialNumber },
    requestId: 'http-trace',
  });
const approve = (requestId: string) =>
  createAdminOnboardingHandlers({ client: db.prisma }).approve({
    actor: {
      actorId: 'first-request-admin',
      username: 'admin',
      actorType: 'platform',
      roles: ['PlatformSuperAdmin'],
      customerId: null,
      tokenUse: 'access',
    },
    headers: { 'If-Match': '1' },
    params: { requestId },
    query: {},
    requestId: 'approve-first-request',
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

  test.each(['APPROVED', 'REJECTED', 'TIMED_OUT'])('%s 申请在未完成超时撤证时不能再次提交', async (status) => {
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
    const response = await approve(request.id);
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

  test('撤证完成后并发重提只保留一个新申请，且可重新审批同一设备', async () => {
    const serialNumber = 'SN-FIRST-REAPPLY';
    const { csrPem: initialCsrPem } = csrFixture('original-request');
    expect((await submit(serialNumber, { csrPem: initialCsrPem })).status).toBe(201);
    const original = await db.prisma.onboardingRequest.findUniqueOrThrow({ where: { serialNumber } });
    expect((await approve(original.id)).status).toBe(200);
    const device = await db.prisma.device.findUniqueOrThrow({ where: { serialNumber } });
    const timeout = new Date();
    await db.prisma.onboardingRequest.update({
      where: { id: original.id },
      data: { status: 'TIMED_OUT', rejectReason: 'ONBOARDING_TIMEOUT', timedOutAt: timeout },
    });
    await db.prisma.device.update({ where: { id: device.id }, data: { lifecycleStatus: 'PendingOnboarding' } });
    const certificate = await db.prisma.deviceCertificate.create({
      data: {
        id: 'cert-first-request-timed-out',
        fingerprint: 'first-request-timed-out',
        deviceId: device.id,
        status: 'REVOKED',
        notBefore: timeout,
        notAfter: new Date(timeout.getTime() + 86400_000),
        revokedAt: timeout,
      },
    });
    await db.prisma.onboardingProvisioningJob.update({
      where: { requestId: original.id },
      data: { status: 'COMPLETED', issuedCertificateId: certificate.id, completedAt: timeout },
    });
    await db.prisma.onboardingProofNonce.create({
      data: { requestId: original.id, nonceHash: 'previous-proof', expiresAt: timeout },
    });
    expect(await submit(serialNumber)).toMatchObject({
      status: 409,
      body: { error: { code: 'CONFLICT', message: expect.stringContaining('revocation is pending') } },
    });
    await db.prisma.onboardingRequest.update({
      where: { id: original.id },
      data: { revocationCompletedAt: timeout },
    });

    const { csrPem } = csrFixture('resubmitted-request');
    const responses = await Promise.all(Array.from({ length: 5 }, () => submit(serialNumber, { csrPem })));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409, 409]);
    const latest = await db.prisma.onboardingRequest.findUniqueOrThrow({ where: { serialNumber } });
    expect(responses.find((response) => response.status === 201)?.body).toEqual({
      requestId: latest.id,
      status: 'PENDING',
    });
    expect(latest).toMatchObject({
      csrPem,
      status: 'PENDING',
      version: 1,
      rejectReason: null,
      reviewedBy: null,
      reviewedAt: null,
      onboardingDeadlineAt: null,
      timedOutAt: null,
      revocationCompletedAt: null,
    });
    expect(latest.publicKeyFingerprint).not.toBe(original.publicKeyFingerprint);
    expect(await db.prisma.onboardingRequest.findUnique({ where: { id: original.id } })).toBeNull();
    expect(await db.prisma.onboardingProofNonce.count({ where: { requestId: original.id } })).toBe(0);
    expect(await db.prisma.onboardingProvisioningJob.count({ where: { requestId: original.id } })).toBe(0);
    expect(await db.prisma.onboardingProvisioningJob.count({ where: { requestId: latest.id } })).toBe(0);
    expect(
      await db.prisma.auditLog.findFirst({
        where: { objectId: original.id, action: 'onboarding.request.resubmit' },
      }),
    ).toMatchObject({ afterValue: { requestId: latest.id } });
    expect((await approve(original.id)).status).toBe(404);
    expect((await approve(latest.id)).status).toBe(200);
    expect(await db.prisma.device.findUniqueOrThrow({ where: { serialNumber } })).toMatchObject({
      id: device.id,
      lifecycleStatus: 'OnboardingApproved',
    });
    expect(await db.prisma.deviceCertificate.findUnique({ where: { id: certificate.id } })).toEqual(certificate);
    expect(await db.prisma.onboardingProvisioningJob.findUnique({ where: { requestId: latest.id } })).toMatchObject({
      status: 'PENDING',
    });
  });
});
