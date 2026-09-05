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
import { assert, expect } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import {
  CERTIFICATE_PACKAGE_RETENTION_SECONDS,
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
const RETENTION_SECONDS = CERTIFICATE_PACKAGE_RETENTION_SECONDS;

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
let recoveryProvisioning: ProvisioningService;
let iotCertificateSequence = 0;

function mockIot(): IotProvisioningPort {
  return {
    ensureThing: () => Promise.resolve(),
    createKeysAndCertificate: () => {
      iotCertificateSequence += 1;
      const n = iotCertificateSequence;
      return Promise.resolve({
        certificateId: `cert-status-${Date.now()}-${n}`,
        certificateArn: `arn:aws:iot:ap-southeast-1:123456789012:cert/cert-status-${n}`,
        certificatePem: `-----BEGIN CERTIFICATE-----\n${Buffer.from(`status-cert-${n}`).toString('base64')}\n-----END CERTIFICATE-----`,
        privateKey:
          ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ') +
          `\nSTATUSKEY${n}\n` +
          ['-----END', 'PRIVATE', 'KEY-----'].join(' '),
      } as IotCertificateResult);
    },
    ensurePolicy: (_name: string, _doc: IotPolicyDocument) => Promise.resolve(),
    attachPolicy: () => Promise.resolve(),
    attachThingPrincipal: () => Promise.resolve(),
    revokeCertificate: () => Promise.resolve(),
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
  recoveryProvisioning = makeProvisioning();
  statusHandler = createOnboardingStatusHandler({
    client: prisma,
    securePackage: sp,
    mqttEndpoint: MQTT_ENDPOINT,
    rateLimiter: createRateLimiter(new InMemoryRateLimitStore(), { limit: 10_000, windowSeconds: 60 }, now),
    now,
    deliveryRecovery: recoveryProvisioning,
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

  test('DEC-017 TIMED_OUT：外部稳定映射为 REJECTED/ONBOARDING_TIMEOUT', async () => {
    const serial = await plantDevice();
    const { token, requestId } = await submitRequest(serial);
    await prisma.onboardingRequest.update({
      where: { id: requestId },
      data: { status: 'TIMED_OUT', rejectReason: 'ONBOARDING_TIMEOUT', timedOutAt: NOW },
    });

    const res = await statusHandler(statusReq(token, serial));
    assert.equal(res.status, 200);
    const body = res.body as StatusPayload;
    assert.equal(body.data.status, 'REJECTED');
    assert.equal(body.data.rejectReason, 'ONBOARDING_TIMEOUT');
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

    // 返回时仅完成交付预留；适配层确认响应提交后才销毁密文并核销 Token。
    let cert = await prisma.deviceCertificate.findFirst({ where: { deviceId: body.data.deviceId } });
    assert.isNotNull(cert?.packageCiphertext);
    assert.isNotNull(cert?.claimedAt);
    assert.ok(res.onCommitted);
    await res.onCommitted?.();
    if (!cert) assert.fail('certificate row is required');
    cert = await prisma.deviceCertificate.findFirst({ where: { id: cert.id } });
    assert.isNull(cert?.packageCiphertext);
    const again = await statusHandler(statusReq(token, serial));
    assert.equal(again.status, 401);

    // 审计与管理员 API 均不含私钥明文
    const audits = await prisma.auditLog.findMany({ where: { objectId: { in: [requestId, body.data.deviceId!] } } });
    assert.ok(!JSON.stringify(audits).includes('STATUSKEY'));
    const detail = await admin.detail({ actor: superAdmin, headers: {}, params: { requestId }, requestId: 'req-d' });
    assert.ok(!JSON.stringify(detail.body).includes('STATUSKEY'));
  });

  test('响应未确认重试：撤销未确认证书、重签并在下一轮安全交付', async () => {
    const serial = await plantDevice();
    const { token, requestId } = await submitRequest(serial);
    const provisioning = makeProvisioning();
    const admin = createAdminOnboardingHandlers({ client: prisma, now, provisioningTrigger: provisioning });
    assert.equal((await adminApprove(requestId, admin)).status, 200);

    const first = await statusHandler(statusReq(token, serial));
    assert.equal(first.status, 200);
    assert.equal((first.body as StatusPayload).data.status, 'APPROVED');
    const firstDeviceId = (first.body as StatusPayload).data.deviceId as string;
    const firstCertificateId = (
      await prisma.deviceCertificate.findFirst({
        where: { deviceId: firstDeviceId, status: 'PENDING_CLAIM', packageCiphertext: { not: null } },
      })
    )?.id;
    assert.ok(firstCertificateId);

    // 不调用 first.onCommitted，模拟连接在成功响应确认前中断。
    const recovery = await statusHandler(statusReq(token, serial));
    assert.equal(recovery.status, 200);
    assert.equal((recovery.body as StatusPayload).data.status, 'PENDING');
    const old = await prisma.deviceCertificate.findFirst({ where: { id: firstCertificateId } });
    assert.equal(old?.status, 'REVOKED');
    assert.isNull(old?.packageCiphertext);

    const retried = await statusHandler(statusReq(token, serial));
    assert.equal(retried.status, 200);
    assert.equal((retried.body as StatusPayload).data.status, 'APPROVED');
    const newId = (retried.body as StatusPayload).data.deviceId;
    assert.ok(newId);
    await retried.onCommitted?.();
    assert.equal((await statusHandler(statusReq(token, serial))).status, 401);
  });

  test('交付确认第一写点冲突时不核销 Token', async () => {
    const serial = await plantDevice();
    const { token, requestId } = await submitRequest(serial);
    const admin = createAdminOnboardingHandlers({ client: prisma, now, provisioningTrigger: makeProvisioning() });
    assert.equal((await adminApprove(requestId, admin)).status, 200);
    const response = await statusHandler(statusReq(token, serial));
    const request = await prisma.onboardingRequest.findUniqueOrThrow({ where: { id: requestId } });
    const deviceId = (response.body as StatusPayload).data.deviceId;
    assert.ok(deviceId);
    const cert = await prisma.deviceCertificate.findFirstOrThrow({ where: { deviceId } });
    await prisma.deviceCertificate.update({ where: { id: cert.id }, data: { packageCiphertext: null } });

    await expect(response.onCommitted?.()).rejects.toThrow('交付确认状态已变化');
    assert.isNull((await prisma.onboardingToken.findUniqueOrThrow({ where: { id: request.tokenId } })).usedAt);
  });

  test('Token 核销冲突会回滚同一事务内的证书包清理', async () => {
    const serial = await plantDevice();
    const { token, requestId } = await submitRequest(serial);
    const admin = createAdminOnboardingHandlers({ client: prisma, now, provisioningTrigger: makeProvisioning() });
    assert.equal((await adminApprove(requestId, admin)).status, 200);
    const response = await statusHandler(statusReq(token, serial));
    const request = await prisma.onboardingRequest.findUniqueOrThrow({ where: { id: requestId } });
    const deviceId = (response.body as StatusPayload).data.deviceId;
    assert.ok(deviceId);
    const cert = await prisma.deviceCertificate.findFirstOrThrow({ where: { deviceId } });
    await prisma.onboardingToken.update({ where: { id: request.tokenId }, data: { usedAt: NOW } });

    await expect(response.onCommitted?.()).rejects.toThrow('Token 核销状态已变化');
    assert.isNotNull(
      (await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: cert.id } })).packageCiphertext,
      '第二写点失败必须回滚证书包清理',
    );
  });

  test('DEC-017：截止边界即使评估器延迟也失败关闭，不再返回证书包', async () => {
    const serial = await plantDevice();
    const { token, requestId } = await submitRequest(serial);
    const admin = createAdminOnboardingHandlers({
      client: prisma,
      now,
      provisioningTrigger: makeProvisioning(),
    });
    assert.equal((await adminApprove(requestId, admin)).status, 200);
    await prisma.onboardingRequest.update({ where: { id: requestId }, data: { onboardingDeadlineAt: NOW } });

    const res = await statusHandler(statusReq(token, serial));
    assert.equal(res.status, 200);
    const body = res.body as StatusPayload;
    assert.equal(body.data.status, 'REJECTED');
    assert.equal(body.data.rejectReason, 'ONBOARDING_TIMEOUT');
    assert.isUndefined(body.data.privateKey);
  });

  test('DEC-003/017：截止前证书包过期时撤销旧证书并重签，对外保持 PENDING', async () => {
    const serial = await plantDevice();
    const { token, requestId } = await submitRequest(serial);
    const admin = createAdminOnboardingHandlers({
      client: prisma,
      now,
      provisioningTrigger: makeProvisioning(),
    });
    assert.equal((await adminApprove(requestId, admin)).status, 200);
    const device = await prisma.device.findUniqueOrThrow({ where: { serialNumber: serial } });
    const old = await prisma.deviceCertificate.findFirstOrThrow({
      where: { deviceId: device.id, status: 'PENDING_CLAIM' },
    });
    await prisma.deviceCertificate.update({ where: { id: old.id }, data: { packageExpiresAt: NOW } });
    await prisma.onboardingRequest.update({
      where: { id: requestId },
      data: { onboardingDeadlineAt: new Date(NOW.getTime() + 24 * 3600 * 1000) },
    });

    const res = await statusHandler(statusReq(token, serial));
    assert.equal(res.status, 200);
    assert.equal((res.body as StatusPayload).data.status, 'PENDING');
    assert.equal((await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: old.id } })).status, 'REVOKED');
    assert.equal(await prisma.deviceCertificate.count({ where: { deviceId: device.id, status: 'PENDING_CLAIM' } }), 1);
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
