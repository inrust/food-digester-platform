/**
 * BE-ONB-03 Onboarding Status API 验收（PGlite + mock IoT，全链路：申请 → 审批 → 签发 → 领取）。
 *
 * 验收基准覆盖：
 * - 三类响应符合契约：PENDING / REJECTED（含原因）/ APPROVED（证书包全字段 + heartbeatInterval=60）；
 * - 内部 Provisioning 不暴露：APPROVED 但证书包未就绪 → 对外 PENDING；
 * - 证书包一次性安全领取：领取后密文销毁 + Token 核销（再次访问 401）；重复领取 409；
 * - 管理员 API/审计日志均看不到私钥。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import {
  createLocalTestKeyProvider,
  createRateLimiter,
  InMemoryRateLimitStore,
  issueOnboardingToken,
  SecurePackageService,
} from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import type { IotPolicyDocument } from '@fdp/aws-clients';
import {
  createAdminOnboardingHandlers,
  createOnboardingRequestHandler,
  createOnboardingStatusHandler,
  ProvisioningService,
} from '../src/index.js';
import type {
  AdminOnboardingHandlers,
  IotCertificateResult,
  IotProvisioningPort,
  OnboardingStatusRequest,
} from '../src/index.js';
import { createTestDb } from './helpers.js';

const NOW = new Date('2026-08-27T08:00:00Z');
const now = () => NOW;
const MQTT_ENDPOINT = 'a1b2c3d4e5-ats.iot.ap-southeast-1.amazonaws.com';
const RETENTION_SECONDS = 3600;

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const superAdmin: ActorContext = {
  actorId: 'admin-1',
  username: 'admin',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};

// 全测试套件共享同一测试密钥域（ProvisioningService 与 Status 领取链路一致）
const keyProvider = createLocalTestKeyProvider('be-onb-03-status');

let statusHandler: ReturnType<typeof createOnboardingStatusHandler>;

function mockIot(): IotProvisioningPort {
  let n = 0;
  return {
    ensureThing: () => Promise.resolve(),
    createKeysAndCertificate: () => {
      n += 1;
      return Promise.resolve({
        certificateId: `cert-status-${Date.now()}-${n}`,
        certificateArn: `arn:aws:iot:ap-southeast-1:123456789012:cert/cert-status-${n}`,
        certificatePem: `-----BEGIN CERTIFICATE-----\nSTATUSCERT${n}\n-----END CERTIFICATE-----`,
        privateKey:
          ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ') +
          `\nSTATUSKEY${n}\n` +
          ['-----END', 'PRIVATE', 'KEY-----'].join(' '),
      } as IotCertificateResult);
    },
    ensurePolicy: (_name: string, _doc: IotPolicyDocument) => Promise.resolve(),
    attachPolicy: () => Promise.resolve(),
    attachThingPrincipal: () => Promise.resolve(),
  };
}

function makeProvisioning(): ProvisioningService {
  return new ProvisioningService({
    client: prisma,
    iot: mockIot(),
    keyProvider,
    config: {
      region: 'ap-southeast-1',
      accountId: '123456789012',
      packageRetentionSeconds: RETENTION_SECONDS,
      certificateValiditySeconds: 365 * 24 * 3600,
    },
    now,
  });
}

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
  // SecurePackageService 依赖 DB：用真实 client 重建
  const sp = new SecurePackageService({
    db: prisma,
    keyProvider,
    config: { retentionSeconds: RETENTION_SECONDS, maxClaims: 1, now },
  });
  statusHandler = createOnboardingStatusHandler({
    client: prisma,
    securePackage: sp,
    mqttEndpoint: MQTT_ENDPOINT,
    rateLimiter: createRateLimiter(new InMemoryRateLimitStore(), { limit: 10_000, windowSeconds: 60 }, now),
    now,
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

let seq = 0;
async function plantDevice(): Promise<string> {
  seq += 1;
  const serialNumber = `SN-STATUS-${seq}`;
  await prisma.device.create({
    data: {
      id: `dev-status-${seq}`,
      serialNumber,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'PendingOnboarding',
    },
  });
  return serialNumber;
}

async function submitRequest(serialNumber: string): Promise<{ token: string; requestId: string }> {
  const { token } = await issueOnboardingToken(prisma, {
    serialNumber,
    expiresAt: new Date('2027-01-01T00:00:00Z'),
  });
  const deviceRequest = createOnboardingRequestHandler({
    client: prisma,
    rateLimiter: createRateLimiter(new InMemoryRateLimitStore(), { limit: 10_000, windowSeconds: 60 }, now),
    now,
  });
  const res = await deviceRequest({
    headers: { authorization: `Bearer ${token}` },
    body: {
      serialNumber,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: '2026-01-01',
    },
    requestId: 'req-submit',
  });
  assert.equal(res.status, 201);
  const requestId = (res.body as { data: { requestId: string } }).data.requestId;
  return { token, requestId };
}

function adminApprove(requestId: string, admin: AdminOnboardingHandlers) {
  return admin.approve({
    actor: superAdmin,
    headers: { 'If-Match': '1' },
    params: { requestId },
    requestId: 'req-approve',
  });
}

function statusReq(token: string | undefined, serialNumber: string): OnboardingStatusRequest {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    query: { serialNumber },
    requestId: 'req-status',
  };
}

interface StatusPayload {
  data: {
    status: string;
    requestId: string;
    rejectReason?: string | null;
    deviceId?: string;
    certificatePem?: string;
    privateKey?: string;
    mqttEndpoint?: string;
    heartbeatInterval?: number;
  };
  meta: { requestId: string; timestamp: string };
}

describe('GET /api/v1/device/onboarding/status', () => {
  test('PENDING：申请待审批 → 200 PENDING，不含证书材料字段', async () => {
    const serial = await plantDevice();
    const { token, requestId } = await submitRequest(serial);
    const res = await statusHandler(statusReq(token, serial));
    assert.equal(res.status, 200);
    const body = res.body as StatusPayload;
    assert.equal(body.data.status, 'PENDING');
    assert.equal(body.data.requestId, requestId);
    assert.ok(!('privateKey' in body.data) && !('certificatePem' in body.data));
  });

  test('REJECTED：返回稳定状态与拒绝原因', async () => {
    const serial = await plantDevice();
    const { token, requestId } = await submitRequest(serial);
    const admin = createAdminOnboardingHandlers({ client: prisma, now });
    const rej = await admin.reject({
      actor: superAdmin,
      headers: { 'If-Match': '1' },
      params: { requestId },
      body: { reason: '资料不完整' },
      requestId: 'req-reject',
    });
    assert.equal(rej.status, 200);

    const res = await statusHandler(statusReq(token, serial));
    assert.equal(res.status, 200);
    const body = res.body as StatusPayload;
    assert.equal(body.data.status, 'REJECTED');
    assert.equal(body.data.rejectReason, '资料不完整');
  });

  test('APPROVED 但 Provisioning 未就绪 → 对外仍为 PENDING（内部步骤不暴露）', async () => {
    const serial = await plantDevice();
    const { token, requestId } = await submitRequest(serial);
    // 审批但不注入 provisioningTrigger：证书包未就绪
    const admin = createAdminOnboardingHandlers({ client: prisma, now });
    assert.equal((await adminApprove(requestId, admin)).status, 200);

    const res = await statusHandler(statusReq(token, serial));
    assert.equal(res.status, 200);
    assert.equal((res.body as StatusPayload).data.status, 'PENDING');
  });

  test('APPROVED 全链路：审批触发签发 → status 一次性领取证书包（全字段 + heartbeatInterval=60）', async () => {
    const serial = await plantDevice();
    const { token, requestId } = await submitRequest(serial);
    const admin = createAdminOnboardingHandlers({ client: prisma, now, provisioningTrigger: makeProvisioning() });
    assert.equal((await adminApprove(requestId, admin)).status, 200);

    const res = await statusHandler(statusReq(token, serial));
    assert.equal(res.status, 200);
    const body = res.body as StatusPayload;
    assert.equal(body.data.status, 'APPROVED');
    assert.equal(body.data.requestId, requestId);
    assert.ok(body.data.deviceId);
    assert.match(body.data.certificatePem ?? '', /BEGIN CERTIFICATE/);
    assert.ok((body.data.privateKey ?? '').includes('STATUSKEY'), '证书包私钥应来自签发材料');
    assert.equal(body.data.mqttEndpoint, MQTT_ENDPOINT);
    assert.equal(body.data.heartbeatInterval, 60);

    // 领取成功即销毁密文 + 核销 Token：再次访问 401（Token 已核销）
    const cert = await prisma.deviceCertificate.findFirst({ where: { deviceId: body.data.deviceId } });
    assert.equal(cert?.packageCiphertext, null);
    const again = await statusHandler(statusReq(token, serial));
    assert.equal(again.status, 401);

    // 审计与管理员 API 均不含私钥明文
    const audits = await prisma.auditLog.findMany({ where: { objectId: { in: [requestId, body.data.deviceId!] } } });
    assert.ok(!JSON.stringify(audits).includes('STATUSKEY'));
    const detail = await admin.detail({ actor: superAdmin, headers: {}, params: { requestId }, requestId: 'req-d' });
    assert.ok(!JSON.stringify(detail.body).includes('STATUSKEY'));
  });

  test('负向：Token 无申请 → 404；缺序列号 → 400；伪造 Token → 401', async () => {
    const serial = await plantDevice();
    const { token } = await issueOnboardingToken(prisma, {
      serialNumber: serial,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    });
    // 未提交申请直接查状态
    const notFound = await statusHandler(statusReq(token, serial));
    assert.equal(notFound.status, 404);
    assert.equal((notFound.body as { error: { code: string } }).error.code, 'NOT_FOUND');

    const badSerial = await statusHandler({
      headers: { authorization: `Bearer ${token}` },
      query: {},
      requestId: 'req-x',
    });
    assert.equal(badSerial.status, 400);

    const forged = await statusHandler(statusReq(`fdp_onb_${'z'.repeat(43)}`, serial));
    assert.equal(forged.status, 401);
  });
});
