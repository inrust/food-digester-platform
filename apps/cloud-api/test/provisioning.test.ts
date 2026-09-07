/**
 * BE-ONB-03 Provisioning Service 验收（PGlite + 内存 mock IoT Port）。
 *
 * 验收基准覆盖：
 * - 正向：Thing/Policy/attach/发证全链调用；证书记录 PENDING_CLAIM；私钥立即信封加密落库；
 * - 幂等：重复触发不重复调用 AWS 发证、不重复创建业务 Device 与证书记录；
 * - 部分失败可重试：attach 失败后重试成功，业务 Device 始终唯一；封包前失败的孤儿证书按
 *   DEC-003 丢失处置标记 REVOKED 后重签；
 * - 私钥安全：数据库与审计日志不出现私钥明文。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert, expect } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { CERTIFICATE_PACKAGE_RETENTION_SECONDS, createLocalTestKeyProvider, SecurePackageService } from '@fdp/auth';
import type { IotPolicyDocument } from '@fdp/aws-clients';
import { ProvisioningService, rotateCertificate } from '../src/index.js';
import type { IotCertificateResult, IotProvisioningPort } from '../src/index.js';
import type { AdminOnboardingRequestRecord } from '../src/index.js';
import { createTestDb } from './helpers.js';

const NOW = new Date('2026-08-27T08:00:00Z');
const now = () => NOW;

const CONFIG = {
  region: 'ap-southeast-1',
  accountId: '123456789012',
  certificateValiditySeconds: 365 * 24 * 3600,
} as const;

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

// ---------- 内存 mock IoT Port ----------

interface MockIot extends IotProvisioningPort {
  readonly calls: string[];
  readonly things: Set<string>;
  readonly policies: Map<string, IotPolicyDocument>;
  readonly certs: IotCertificateResult[];
  failNextAttachPolicy: boolean;
  failNextRevoke: boolean;
}

function mockIot(): MockIot {
  const instance = Math.random().toString(36).slice(2, 8);
  const state: MockIot = {
    calls: [],
    things: new Set(),
    policies: new Map(),
    certs: [],
    failNextAttachPolicy: false,
    failNextRevoke: false,
    async ensureThing(thingName) {
      state.calls.push(`ensureThing:${thingName}`);
      state.things.add(thingName);
    },
    async createKeysAndCertificate() {
      const n = state.certs.length + 1;
      const cert: IotCertificateResult = {
        certificateId: `cert-${instance}-${n}`,
        certificateArn: `arn:aws:iot:ap-southeast-1:123456789012:cert/cert-${instance}-${n}`,
        certificatePem: `-----BEGIN CERTIFICATE-----\n${Buffer.from(`MOCKCERT-${instance}-${n}`).toString('base64')}\n-----END CERTIFICATE-----`,
        privateKey:
          ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ') +
          `\nMOCKKEY${instance}${n}\n` +
          ['-----END', 'PRIVATE', 'KEY-----'].join(' '),
      };
      state.calls.push(`createKeysAndCertificate:${cert.certificateId}`);
      state.certs.push(cert);
      return cert;
    },
    async tagCertificate(certificateArn, tags) {
      state.calls.push(`tagCertificate:${certificateArn}:${JSON.stringify(tags)}`);
    },
    async ensurePolicy(policyName, policyDocument) {
      state.calls.push(`ensurePolicy:${policyName}`);
      state.policies.set(policyName, policyDocument);
    },
    async attachPolicy(policyName, targetArn) {
      if (state.failNextAttachPolicy) {
        state.failNextAttachPolicy = false;
        state.calls.push(`attachPolicy:FAIL`);
        throw new Error('simulated AWS failure');
      }
      state.calls.push(`attachPolicy:${policyName}->${targetArn}`);
    },
    async attachThingPrincipal(thingName, principalArn) {
      state.calls.push(`attachThingPrincipal:${thingName}->${principalArn}`);
    },
    async revokeCertificate(certificateId) {
      if (state.failNextRevoke) {
        state.failNextRevoke = false;
        state.calls.push(`revokeCertificate:FAIL:${certificateId}`);
        throw new Error('simulated revoke failure');
      }
      state.calls.push(`revokeCertificate:${certificateId}`);
    },
  };
  return state;
}

let seq = 0;
async function plantApprovedRequest(): Promise<{ request: AdminOnboardingRequestRecord; deviceId: string }> {
  seq += 1;
  const serialNumber = `SN-PROV-${seq}`;
  const deviceId = `dev-prov-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'OnboardingApproved',
    },
  });
  const token = await prisma.onboardingToken.create({
    data: {
      tokenHash: `prov-token-${seq}`,
      serialNumber,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    },
  });
  const row = await prisma.onboardingRequest.create({
    data: {
      id: `req-prov-${seq}`,
      tokenId: token.id,
      serialNumber,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      status: 'APPROVED',
      reviewedBy: 'admin-1',
      reviewedAt: NOW,
      version: 2,
    },
  });
  const request: AdminOnboardingRequestRecord = row;
  return { deviceId, request };
}

function makeService(iot: MockIot): ProvisioningService {
  return new ProvisioningService({
    client: prisma,
    iot,
    keyProvider: createLocalTestKeyProvider('be-onb-03'),
    config: CONFIG,
    now,
  });
}

describe('ProvisioningService', () => {
  test('正向：Thing/Policy/attach 全链调用；证书 PENDING_CLAIM；私钥仅以信封密文落库', async () => {
    const { request, deviceId } = await plantApprovedRequest();
    const iot = mockIot();
    const service = makeService(iot);

    const result = await service.provision(request);
    assert.equal(result.deviceId, deviceId);
    assert.isFalse(result.replayed);

    // IoT 调用链完整且 Thing Name = deviceId
    assert.deepEqual(
      iot.calls.map((c) => c.split(':')[0]),
      [
        'ensureThing',
        'createKeysAndCertificate',
        'tagCertificate',
        'ensurePolicy',
        'attachPolicy',
        'attachThingPrincipal',
      ],
    );
    assert.ok(iot.things.has(deviceId));
    const policy = iot.policies.get(`fdp-device-${deviceId}`);
    assert.ok(policy, 'AUTH-04 单设备 Policy 已创建');
    // Policy 无通配符（AUTH-04 字面量 ARN）
    assert.ok(!JSON.stringify(policy).includes('*'));

    // 证书记录：PENDING_CLAIM + 指纹 + 有效期；私钥明文不落库
    const row = await prisma.deviceCertificate.findFirst({ where: { id: result.certificateId } });
    assert.equal(row?.status, 'PENDING_CLAIM');
    assert.ok(row?.fingerprint);
    assert.ok(row?.packageCiphertext);
    assert.equal(row?.packageKmsKeyId, 'local-test-key');
    const requestRow = await prisma.onboardingRequest.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(requestRow.onboardingDeadlineAt?.toISOString(), '2026-08-28T08:00:00.000Z');
    assert.equal(requestRow.timedOutAt, null);
    const plainColumns = JSON.stringify({ ...row, packageCiphertext: undefined });
    assert.ok(!plainColumns.includes('MOCKKEY'), '私钥明文不得出现在证书记录列');
    assert.ok(!plainColumns.includes('PRIVATE KEY'));

    // 审计：provisioning + 封包存储均留痕，且不含私钥
    const audits = await prisma.auditLog.findMany({ where: { objectId: { in: [deviceId, result.certificateId] } } });
    const actions = audits.map((a) => a.action).sort();
    assert.ok(actions.includes('onboarding.provision'));
    assert.ok(actions.includes('CERT_PACKAGE_STORE'));
    assert.ok(!JSON.stringify(audits).includes('MOCKKEY'));
  });

  test('幂等：重复触发短路，不重复调用 AWS 发证、不重复创建 Device/证书记录', async () => {
    const { request, deviceId } = await plantApprovedRequest();
    const iot = mockIot();
    const service = makeService(iot);

    await service.provision(request);
    const replay = await service.provision(request);
    assert.isTrue(replay.replayed);
    assert.equal(iot.calls.filter((c) => c.startsWith('createKeysAndCertificate')).length, 1);
    assert.equal(await prisma.device.count({ where: { id: deviceId } }), 1);
    assert.equal(await prisma.deviceCertificate.count({ where: { deviceId, status: 'PENDING_CLAIM' } }), 1);
  });

  test('部分失败可重试：attachPolicy 失败 → 重试成功；业务 Device 不重复创建；孤儿证书 REVOKED 后重签', async () => {
    const { request, deviceId } = await plantApprovedRequest();
    const iot = mockIot();
    const service = makeService(iot);

    // 第一次：attachPolicy 抛错；补偿立即撤销 AWS 证书并保留可对账的 REVOKED 记录。
    iot.failNextAttachPolicy = true;
    let firstError: unknown;
    try {
      await service.provision(request);
    } catch (err) {
      firstError = err;
    }
    assert.ok(firstError instanceof Error && firstError.message.includes('simulated AWS failure'));
    assert.equal(await prisma.device.count({ where: { id: deviceId } }), 1);
    assert.equal(await prisma.deviceCertificate.count({ where: { deviceId, status: 'REVOKED' } }), 1);
    assert.ok(iot.calls.some((call) => call.startsWith('revokeCertificate:')));

    // 第二次重试至成功。
    const retry = await service.provision(request);
    assert.isFalse(retry.replayed);
    assert.equal(await prisma.device.count({ where: { id: deviceId } }), 1, '业务 Device 不得重复创建');
    assert.equal(await prisma.deviceCertificate.count({ where: { deviceId, status: 'PENDING_CLAIM' } }), 1);
    // 第一次证书已补偿撤销，第二次产生可交付证书。
    assert.equal(iot.certs.length, 2);
  });

  test('封包前失败的遗留记录：重试按 DEC-003 丢失处置 REVOKED 旧记录并重签', async () => {
    const { request, deviceId } = await plantApprovedRequest();
    // 模拟前次在“证书记录已建、封包未做”状态中断
    await prisma.deviceCertificate.create({
      data: {
        id: 'cert-orphan',
        deviceId,
        fingerprint: 'orphan-fp',
        status: 'PENDING_CLAIM',
        notBefore: NOW,
        notAfter: new Date('2027-08-27T00:00:00Z'),
      },
    });
    const iot = mockIot();
    const service = makeService(iot);
    const result = await service.provision(request);

    assert.isFalse(result.replayed);
    const orphan = await prisma.deviceCertificate.findFirst({ where: { id: 'cert-orphan' } });
    assert.equal(orphan?.status, 'REVOKED');
    assert.ok(orphan?.revokedAt);
    const fresh = await prisma.deviceCertificate.findFirst({ where: { id: result.certificateId } });
    assert.ok(fresh?.packageCiphertext, '新证书必须带加密证书包');
  });

  test('补偿撤证失败时持久化 issuedCertificateId，下一次 Job 尝试先对账撤证再重签', async () => {
    const { request, deviceId } = await plantApprovedRequest();
    const job = await prisma.onboardingProvisioningJob.create({
      data: {
        requestId: request.id,
        status: 'COMPLETED',
        attempts: 1,
        nextAttemptAt: NOW,
        completedAt: NOW,
      },
    });
    const iot = mockIot();
    const service = makeService(iot);
    iot.failNextAttachPolicy = true;
    iot.failNextRevoke = true;
    let issuedCertificateId: string | null = null;
    const attempt = {
      operationId: `op-${request.id}`,
      onCertificateIssued: async (certificateId: string | null) => {
        issuedCertificateId = certificateId;
      },
    };

    await expect(service.provision(request, attempt)).rejects.toThrow('simulated AWS failure');
    assert.ok(issuedCertificateId, '补偿未完成时必须保留 AWS certificateId 对账凭证');
    assert.equal(
      (await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: issuedCertificateId } })).status,
      'PENDING_CLAIM',
    );
    const orphanCertificateId = issuedCertificateId;
    const reopened = await prisma.onboardingProvisioningJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(reopened.status, 'RETRY');
    assert.equal(reopened.issuedCertificateId, orphanCertificateId);
    assert.isNull(reopened.completedAt);

    const retry = await service.provision(request, {
      ...attempt,
      priorIssuedCertificateId: orphanCertificateId,
    });
    assert.isFalse(retry.replayed);
    assert.notEqual(retry.certificateId, orphanCertificateId);
    assert.equal(await prisma.deviceCertificate.count({ where: { deviceId, status: 'REVOKED' } }), 1);
    assert.ok(iot.calls.some((call) => call === `revokeCertificate:${orphanCertificateId}`));
    assert.ok(
      iot.calls.some((call) => call.startsWith('tagCertificate:') && call.includes(`fdp:provisioning-operation-id`)),
    );
  });

  test('过期恢复：AWS 撤证失败保留密文与 FAILED 状态，重试成功后才清包并重签', async () => {
    const { request, deviceId } = await plantApprovedRequest();
    const iot = mockIot();
    const service = makeService(iot);
    const issued = await service.provision(request);
    iot.failNextRevoke = true;

    await expect(service.recoverExpiredCertificate(issued.certificateId)).rejects.toThrow(
      '过期证书包不存在或状态已变化',
    );

    await expect(service.recoverExpiredPackage(request, issued.certificateId)).rejects.toThrow(
      'simulated revoke failure',
    );
    let old = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: issued.certificateId } });
    assert.equal(old.recoveryState, 'RECOVERY_FAILED');
    assert.equal(old.recoveryAttempts, 1);
    assert.isNotNull(old.packageCiphertext, '撤证失败时密文必须保留');

    // EventBridge 生产入口只持有 certificateId，必须反查已批准申请后进入同一恢复状态机。
    const expiredRecovery = new ProvisioningService({
      client: prisma,
      iot,
      keyProvider: createLocalTestKeyProvider('be-onb-03'),
      config: CONFIG,
      now: () => new Date(NOW.getTime() + (CERTIFICATE_PACKAGE_RETENTION_SECONDS + 1) * 1000),
    });
    await expiredRecovery.recoverExpiredCertificate(issued.certificateId);
    old = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: issued.certificateId } });
    assert.equal(old.status, 'REVOKED');
    assert.equal(old.recoveryState, 'RECOVERY_COMPLETED');
    assert.equal(old.recoveryAttempts, 2);
    assert.isNull(old.packageCiphertext);
    assert.equal(await prisma.deviceCertificate.count({ where: { deviceId, status: 'PENDING_CLAIM' } }), 1);
  });

  test('Status 超时收敛：本地状态先原子失败关闭，AWS 撤证失败保持可审计重试状态', async () => {
    const { request, deviceId } = await plantApprovedRequest();
    const iot = mockIot();
    const service = makeService(iot);
    const issued = await service.provision(request);
    iot.failNextRevoke = true;
    const at = new Date(NOW.getTime() + CERTIFICATE_PACKAGE_RETENTION_SECONDS * 1000);

    assert.isTrue(await service.convergeOnboardingTimeout(request.id, at));

    const requestRow = await prisma.onboardingRequest.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(requestRow.status, 'TIMED_OUT');
    assert.equal(requestRow.rejectReason, 'ONBOARDING_TIMEOUT');
    assert.isNull(requestRow.revocationCompletedAt);
    assert.equal(
      (await prisma.device.findUniqueOrThrow({ where: { id: deviceId } })).lifecycleStatus,
      'PendingOnboarding',
    );
    const certificate = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: issued.certificateId } });
    assert.equal(certificate.status, 'REVOKED');
    assert.isNull(certificate.packageCiphertext);
    assert.isNull(certificate.revokedAt);
    assert.equal(
      await prisma.auditLog.count({
        where: {
          objectId: issued.certificateId,
          action: 'onboarding.timeout.certificate_revoke',
          result: 'FAILURE',
        },
      }),
      1,
    );
  });

  test('H-05：轮换证书包过期时撤销新证书后清包，失败可重试且旧证仍可用于重签', async () => {
    const { deviceId } = await plantApprovedRequest();
    const oldCertificateId = `cert-old-rotation-${seq}`;
    const rotationCertificateId = `cert-new-rotation-${seq}`;
    await prisma.deviceCertificate.create({
      data: {
        id: oldCertificateId,
        deviceId,
        fingerprint: `old-rotation-fp-${seq}`,
        status: 'ACTIVE',
        notBefore: NOW,
        notAfter: new Date(NOW.getTime() + 365 * 24 * 3600 * 1000),
      },
    });
    await prisma.deviceCertificate.create({
      data: {
        id: rotationCertificateId,
        deviceId,
        fingerprint: `new-rotation-fp-${seq}`,
        status: 'ACTIVE',
        rotatedFromId: oldCertificateId,
        notBefore: NOW,
        notAfter: new Date(NOW.getTime() + 365 * 24 * 3600 * 1000),
      },
    });
    const keyProvider = createLocalTestKeyProvider('be-onb-03');
    const packageService = new SecurePackageService({
      db: prisma,
      keyProvider,
      config: { retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS, maxClaims: 1, now },
    });
    await packageService.storePackage(rotationCertificateId, Buffer.from('rotation-private-material'));

    const iot = mockIot();
    iot.failNextRevoke = true;
    const recoveryNow = () => new Date(NOW.getTime() + (CERTIFICATE_PACKAGE_RETENTION_SECONDS + 1) * 1000);
    const service = new ProvisioningService({ client: prisma, iot, keyProvider, config: CONFIG, now: recoveryNow });
    await expect(service.recoverExpiredCertificate(rotationCertificateId)).rejects.toThrow('simulated revoke failure');
    let rotation = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: rotationCertificateId } });
    assert.equal(rotation.recoveryState, 'RECOVERY_FAILED');
    assert.isNotNull(rotation.packageCiphertext, '撤证失败时不得提前销毁轮换密文包');

    await service.recoverExpiredCertificate(rotationCertificateId);
    rotation = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: rotationCertificateId } });
    assert.equal(rotation.status, 'REVOKED');
    assert.equal(rotation.recoveryState, 'RECOVERY_COMPLETED');
    assert.isNull(rotation.packageCiphertext);
    assert.equal(
      (await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: oldCertificateId } })).status,
      'ACTIVE',
      '旧证书必须保留，以便设备下次 rotate 请求触发重签',
    );
    assert.ok(
      await prisma.auditLog.findFirst({
        where: { objectId: rotationCertificateId, action: 'CERT_ROTATION_PACKAGE_EXPIRED_RECOVERY' },
      }),
    );

    const replacement = await rotateCertificate(
      { client: prisma, iot, keyProvider, config: CONFIG, now: recoveryNow },
      {
        deviceId,
        certificateId: oldCertificateId,
        certificateFingerprint: `old-rotation-fp-${seq}`,
        customerId: null,
        siteId: null,
        deviceLifecycleStatus: 'Active',
      },
      oldCertificateId,
    );
    assert.notEqual(replacement.certificateId, rotationCertificateId, '设备使用旧证重试时必须签发替代证书');
    assert.equal(replacement.rotatedFromId, oldCertificateId);
    await replacement.confirmDelivery();
  });
});
