import { contractHandler } from '../../../contracts/testing/device-contract.js';
import forge from 'node-forge';
import { createSign, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import {
  CERTIFICATE_PACKAGE_RETENTION_SECONDS,
  createLocalTestKeyProvider,
  createRateLimiter,
  InMemoryRateLimitStore,
  SecurePackageService,
  SecurePackageError,
} from '@fdp/auth';
import { createOnboardingRequestHandler, createOnboardingStatusHandler } from '../src/index.js';
import { createTestDb } from './helpers.js';

const NOW = new Date('2026-09-29T08:00:00Z');
let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;
const keys = forge.pki.rsa.generateKeyPair(2048);
function csrFor(pair: forge.pki.rsa.KeyPair): string {
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = pair.publicKey;
  csr.setSubject([{ name: 'commonName', value: 'SN-CSR-1' }]);
  csr.sign(pair.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}
const csrPem = csrFor(keys);

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
  await prisma.device.create({
    data: {
      id: 'dev-csr-1',
      serialNumber: 'SN-CSR-1',
      model: 'BNX-100',
      hardwareVersion: '1',
      manufacturer: 'Bio-Nexa',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'PendingOnboarding',
    },
  });
}, 60_000);
afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

const limiter = createRateLimiter(new InMemoryRateLimitStore(), { limit: 1000, windowSeconds: 60 }, () => NOW);
const body = {
  serialNumber: 'SN-CSR-1',
  model: 'BNX-100',
  hardwareVersion: '1',
  manufacturer: 'Bio-Nexa',
  manufactureDate: '2026-01-01',
  csrPem,
};

function signedHeaders(requestId: string, nonce: string) {
  const timestamp = String(NOW.getTime());
  const source = `GET\n/api/v1/device/onboarding/status\n${requestId}\n${timestamp}\n${nonce}`;
  const signature = createSign('sha256').update(source).sign(forge.pki.privateKeyToPem(keys.privateKey), 'base64');
  return { 'x-onboarding-timestamp': timestamp, 'x-onboarding-nonce': nonce, 'x-onboarding-signature': signature };
}

describe('无预置 Token 的 CSR Onboarding', () => {
  test('匿名申请、相同公钥幂等、换钥冲突；签名轮询拒绝重放', async () => {
    const request = checkedCreateOnboardingRequestHandler({ client: prisma, rateLimiter: limiter, now: () => NOW });
    const first = await request({ headers: {}, body, requestId: 'api-1' });
    expect(first.status).toBe(201);
    const requestId = (first.body as { requestId: string }).requestId;
    expect((await request({ headers: {}, body, requestId: 'api-2' })).status).toBe(200);
    const other = csrFor(forge.pki.rsa.generateKeyPair(2048));
    const conflict = await request({ headers: {}, body: { ...body, csrPem: other }, requestId: 'api-3' });
    expect(conflict.status).toBe(409);
    const stored = await prisma.onboardingRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(stored.csrPem).toBe(csrPem);
    expect(stored.publicKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const securePackage = new SecurePackageService({
      db: prisma,
      keyProvider: createLocalTestKeyProvider('csr-test'),
      config: { retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS, maxClaims: 1, now: () => NOW },
    });
    const status = checkedCreateOnboardingStatusHandler({
      client: prisma,
      securePackage,
      mqttEndpoint: 'example.iot',
      restEndpoint: 'https://device-api.test',
      rateLimiter: limiter,
      now: () => NOW,
      deliveryRecovery: {
        recoverUnconfirmedDelivery: async () => {},
        recoverExpiredPackage: async () => {},
        convergeOnboardingTimeout: async () => {},
      },
    });
    expect((await request({ headers: { AUTHORIZATION: 'Bearer obsolete' }, body, requestId: 'api-old' })).status).toBe(
      400,
    );
    expect(
      (await status({ headers: { AUTHORIZATION: 'Bearer obsolete' }, query: { requestId }, requestId: 'api-old' }))
        .status,
    ).toBe(401);
    expect(
      (await request({ headers: {}, body: { ...body, csrPem: 'invalid' }, requestId: 'api-invalid' })).status,
    ).toBe(400);
    expect(
      (await request({ headers: {}, body: { ...body, csrPem: undefined }, requestId: 'api-missing-csr' })).status,
    ).toBe(400);
    const headers = signedHeaders(requestId, randomBytes(24).toString('base64url'));
    const poll = { headers, query: { requestId }, requestId: 'api-4' };
    expect((await status(poll)).body).toEqual({ status: 'PENDING' });
    expect((await status(poll)).status).toBe(401);
    const wrong = await status({
      headers: { ...headers, 'x-onboarding-nonce': randomBytes(24).toString('base64url') },
      query: { requestId },
      requestId: 'api-5',
    });
    expect(wrong.status).toBe(401);

    await prisma.onboardingRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED', rejectReason: 'QA-02 rejected fixture' },
    });
    expect(
      (
        await status({
          headers: signedHeaders(requestId, randomBytes(24).toString('base64url')),
          query: { requestId },
          requestId: 'qa02-rejected',
        })
      ).body,
    ).toEqual({ status: 'REJECTED', reason: 'QA-02 rejected fixture' });
    await prisma.onboardingRequest.update({ where: { id: requestId }, data: { status: 'APPROVED' } });
    await prisma.deviceCertificate.create({
      data: {
        id: 'cert-csr-1',
        deviceId: 'dev-csr-1',
        fingerprint: 'a'.repeat(64),
        status: 'PENDING_CLAIM',
        certificatePem: 'PUBLIC-CERTIFICATE',
        notBefore: NOW,
        notAfter: new Date(NOW.getTime() + 86_400_000),
      },
    });
    await securePackage.storePackage(
      'cert-csr-1',
      Buffer.from(JSON.stringify({ certificatePem: 'PUBLIC-CERTIFICATE', certificateChain: 'PUBLIC-CA' })),
    );
    for (const code of ['NOT_FOUND', 'CONFLICT'] as const) {
      const failingStatus = checkedCreateOnboardingStatusHandler({
        client: prisma,
        now: () => NOW,
        rateLimiter: limiter,
        securePackage: {
          preparePackageDelivery: async () => {
            throw new SecurePackageError(code);
          },
        } as unknown as SecurePackageService,
        mqttEndpoint: 'example.iot',
        restEndpoint: 'https://device-api.test',
        deliveryRecovery: {
          recoverUnconfirmedDelivery: async () => {},
          recoverExpiredPackage: async () => {},
          convergeOnboardingTimeout: async () => {},
        },
      });
      const failure = await failingStatus({
        headers: signedHeaders(requestId, randomBytes(24).toString('base64url')),
        query: { requestId },
        requestId: `qa02-package-${code}`,
      });
      expect(failure.status).toBe(code === 'NOT_FOUND' ? 404 : 409);
    }
    const approved = await status({
      headers: signedHeaders(requestId, randomBytes(24).toString('base64url')),
      query: { requestId },
      requestId: 'api-6',
    });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: 'APPROVED', certificate: { certificatePem: 'PUBLIC-CERTIFICATE' } });
    expect((approved.body as { certificate: Record<string, unknown> }).certificate).not.toHaveProperty('privateKey');
    await approved.onCommitted?.();
    expect(
      (await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: 'cert-csr-1' } })).packageCiphertext,
    ).toBeNull();
    expect(
      (
        await request({
          headers: {},
          body: { ...body, serialNumber: 'SN-QA02-NOT-FOUND' },
          requestId: 'qa02-serial-not-found',
        })
      ).status,
    ).toBe(404);
    expect((await status({ headers: {}, query: {}, requestId: 'qa02-missing-query' })).status).toBe(400);
    const limited = createRateLimiter(new InMemoryRateLimitStore(), { limit: 1, windowSeconds: 60 }, () => NOW);
    const limitedRequest = checkedCreateOnboardingRequestHandler({
      client: prisma,
      now: () => NOW,
      rateLimiter: limited,
    });
    const limitedInput = { headers: {}, body: { ...body, serialNumber: 'SN-QA02-RATE' }, requestId: 'qa02-rate' };
    expect((await limitedRequest(limitedInput)).status).toBe(404);
    expect((await limitedRequest(limitedInput)).status).toBe(429);
    const limitedStatus = checkedCreateOnboardingStatusHandler({
      client: prisma,
      now: () => NOW,
      rateLimiter: createRateLimiter(new InMemoryRateLimitStore(), { limit: 1, windowSeconds: 60 }, () => NOW),
      securePackage,
      mqttEndpoint: 'example.iot',
      restEndpoint: 'https://device-api.test',
      deliveryRecovery: {
        recoverUnconfirmedDelivery: async () => {},
        recoverExpiredPackage: async () => {},
        convergeOnboardingTimeout: async () => {},
      },
    });
    const limitedPoll = {
      headers: signedHeaders(requestId, randomBytes(24).toString('base64url')),
      query: { requestId },
      requestId: 'qa02-rate-status',
    };
    expect((await limitedStatus(limitedPoll)).status).toBe(200);
    expect((await limitedStatus(limitedPoll)).status).toBe(429);
  });
});

const checkedCreateOnboardingRequestHandler: typeof createOnboardingRequestHandler = (deps) =>
  contractHandler('submitOnboardingRequest', createOnboardingRequestHandler(deps));

const checkedCreateOnboardingStatusHandler: typeof createOnboardingStatusHandler = (deps) =>
  contractHandler('getOnboardingStatus', createOnboardingStatusHandler(deps));
