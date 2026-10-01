/**
 * BE-CERT-01 Certificate Status API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 状态边界日：ACTIVE/EXPIRING（阈值日当天与 +1 天）/不足一天/EXPIRED/REVOKED；
 * - 跨设备查询拒绝（query.deviceId 与 mTLS 身份不一致 → 403）；
 * - 响应不包含 PEM/私钥；未认证 401。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { certificateFingerprintFromPem } from '@fdp/auth';
import { createCertificateStatusHandler, deriveCertificateStatus } from '../src/index.js';
import type { CertificateStatusHandlerDeps, CertificateStatusRequest } from '../src/index.js';
import { createDeviceApiLambdaHandler } from '../src/runtime/device-lambda.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';

const NOW = new Date('2026-08-27T08:00:00Z');
const now = () => NOW;
const DAY_MS = 86_400_000;

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function fixturePem(seed: string): string {
  const body = Buffer.from(`test-cert-${seed}`, 'utf8').toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

let seq = 0;
/** 落库一台 Active 设备 + ACTIVE 证书；返回 PEM 与 certificateId。 */
async function plantActiveCert(options: { notAfterOffsetMs?: number; deviceId?: string } = {}) {
  seq += 1;
  const deviceId = options.deviceId ?? `dev-cert-${seq}`;
  if (!options.deviceId) {
    await prisma.device.create({
      data: {
        id: deviceId,
        serialNumber: `SN-CERT-${seq}`,
        model: 'BNX-100',
        hardwareVersion: 'HW1.0',
        manufacturer: 'Hiddenjoy',
        manufactureDate: new Date('2026-01-01T00:00:00Z'),
        lifecycleStatus: 'Active',
      },
    });
  }
  const pem = fixturePem(`${seq}`);
  const certificateId = `cert-cs-${seq}`;
  await prisma.deviceCertificate.create({
    data: {
      id: certificateId,
      deviceId,
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      notBefore: new Date(NOW.getTime() - 30 * DAY_MS),
      notAfter: new Date(NOW.getTime() + (options.notAfterOffsetMs ?? 45 * DAY_MS)),
    },
  });
  return { pem, certificateId, deviceId };
}

function makeHandler(overrides: Partial<CertificateStatusHandlerDeps> = {}) {
  return createCertificateStatusHandler({ client: prisma, now, ...overrides });
}

function statusReq(pem: string | undefined, query: Record<string, string> = {}): CertificateStatusRequest {
  return {
    ...(pem ? { identity: { clientCertPem: pem } } : {}),
    query,
    requestId: 'req-cert-status',
  };
}

interface StatusPayload {
  certificateId: string;
  status: string;
  expiryDate: string;
  daysRemaining: number;
}

describe('GET /api/v1/device/certificate/status', () => {
  test('ACTIVE：剩余 45 天 → ACTIVE，daysRemaining/expiryDate 按 UTC', async () => {
    const { pem, certificateId } = await plantActiveCert({ notAfterOffsetMs: 45 * DAY_MS });
    const res = await makeHandler()(statusReq(pem));
    assert.equal(res.status, 200);
    const body = res.body as StatusPayload;
    assertOpenApiResponse('getCertificateStatus', res.status, res.body);
    assert.equal(body.certificateId, certificateId);
    assert.equal(body.status, 'ACTIVE');
    assert.equal(body.daysRemaining, 45);
    assert.equal(body.expiryDate, new Date(NOW.getTime() + 45 * DAY_MS).toISOString().slice(0, 10));
    assert.deepEqual(Object.keys(body).sort(), [
      'certificateId',
      'daysRemaining',
      'expiryDate',
      'mqttVerifiedAt',
      'restVerifiedAt',
      'rotationConfirmedAt',
      'rotationDeadlineAt',
      'status',
    ]);
    // 响应不包含 PEM/私钥
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('BEGIN CERTIFICATE') && !/privateKey|certificatePem/i.test(serialized));
  });

  test('状态边界日：阈值当天（30 天）→ EXPIRING；阈值 +1 天 → ACTIVE；不足一天 → EXPIRING 且 daysRemaining=0', async () => {
    const at30 = await plantActiveCert({ notAfterOffsetMs: 30 * DAY_MS });
    const res30 = await makeHandler()(statusReq(at30.pem));
    assert.equal((res30.body as StatusPayload).status, 'EXPIRING');
    assert.equal((res30.body as StatusPayload).daysRemaining, 30);

    const at31 = await plantActiveCert({ notAfterOffsetMs: 31 * DAY_MS });
    const res31 = await makeHandler()(statusReq(at31.pem));
    assert.equal((res31.body as StatusPayload).status, 'ACTIVE');
    assert.equal((res31.body as StatusPayload).daysRemaining, 31);

    const underDay = await plantActiveCert({ notAfterOffsetMs: 12 * 3600_000 });
    const res12h = await makeHandler()(statusReq(underDay.pem));
    assert.equal((res12h.body as StatusPayload).status, 'EXPIRING');
    assert.equal((res12h.body as StatusPayload).daysRemaining, 0);
  });

  test('自定义 EXPIRING 阈值生效（expiringSoonDays=7：剩 10 天 → ACTIVE）', async () => {
    const { pem } = await plantActiveCert({ notAfterOffsetMs: 10 * DAY_MS });
    const res = await makeHandler({ expiringSoonDays: 7 })(statusReq(pem));
    assert.equal((res.body as StatusPayload).status, 'ACTIVE');
    const res7 = await makeHandler({ expiringSoonDays: 10 })(statusReq(pem));
    assert.equal((res7.body as StatusPayload).status, 'EXPIRING');
  });

  test('跨设备查询拒绝：query.deviceId 与 mTLS 身份不一致 → 403 FORBIDDEN；一致放行', async () => {
    const { pem, deviceId } = await plantActiveCert();
    const other = await plantActiveCert();
    const res = await makeHandler()(statusReq(pem, { deviceId: other.deviceId }));
    assert.equal(res.status, 403);
    assert.equal((res.body as { error: { code: string } }).error.code, 'FORBIDDEN');
    // 与身份一致则放行
    const okRes = await makeHandler()(statusReq(pem, { deviceId }));
    assert.equal(okRes.status, 200);
  });

  test('未认证：缺证书/未登记证书/过期证书 → 401', async () => {
    const handler = makeHandler();
    assert.equal((await handler(statusReq(undefined))).status, 401);
    assert.equal((await handler(statusReq(fixturePem('unregistered')))).status, 401);
    const expired = await plantActiveCert({ notAfterOffsetMs: -DAY_MS });
    assert.equal((await handler(statusReq(expired.pem))).status, 401);
  });

  test('Device API 无 Bearer JWT、仅可信且已登记的 mTLS 证书时返回契约 200', async () => {
    const { pem } = await plantActiveCert();
    const unused = async () => ({ status: 500, body: {} });
    const lambda = createDeviceApiLambdaHandler({
      certificateStatus: makeHandler(),
      certificateRotate: unused,
      sync: unused,
      deactivate: unused,
      otaDownload: unused,
      mediaUpload: unused,
    });
    const response = await lambda({
      httpMethod: 'GET',
      path: '/api/v1/device/certificate/status',
      headers: {},
      requestContext: {
        requestId: 'req-mtls-only',
        identity: { clientCert: { clientCertPem: pem } },
      },
    });
    assert.equal(response.statusCode, 200);
    assertOpenApiResponse('getCertificateStatus', response.statusCode, response.body);
  });
});

describe('deriveCertificateStatus 纯函数边界', () => {
  const base = { storedStatus: 'ACTIVE', revokedAt: null };

  test('REVOKED：storedStatus 或 revokedAt 任一置位 → REVOKED，daysRemaining=0', () => {
    const notAfter = new Date(NOW.getTime() + 100 * DAY_MS);
    assert.equal(deriveCertificateStatus({ ...base, storedStatus: 'REVOKED', notAfter }, NOW, 30).status, 'REVOKED');
    assert.equal(deriveCertificateStatus({ ...base, revokedAt: NOW, notAfter }, NOW, 30).daysRemaining, 0);
  });

  test('EXPIRED：刚好到达 notAfter → EXPIRED；前一天 → EXPIRING', () => {
    const atBoundary = deriveCertificateStatus({ ...base, notAfter: NOW }, NOW, 30);
    assert.equal(atBoundary.status, 'EXPIRED');
    assert.equal(atBoundary.daysRemaining, 0);
    const dayBefore = deriveCertificateStatus({ ...base, notAfter: NOW }, new Date(NOW.getTime() - DAY_MS), 30);
    assert.equal(dayBefore.status, 'EXPIRING');
    assert.equal(dayBefore.daysRemaining, 1);
  });
});
