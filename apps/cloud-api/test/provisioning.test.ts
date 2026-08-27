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
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { createLocalTestKeyProvider } from '@fdp/auth';
import type { IotPolicyDocument } from '@fdp/aws-clients';
import { ProvisioningService } from '../src/index.js';
import type { IotCertificateResult, IotProvisioningPort } from '../src/index.js';
import type { AdminOnboardingRequestRecord } from '../src/index.js';
import { createTestDb } from './helpers.js';

const NOW = new Date('2026-08-27T08:00:00Z');
const now = () => NOW;

const CONFIG = {
  region: 'ap-southeast-1',
  accountId: '123456789012',
  packageRetentionSeconds: 3600,
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
}

function mockIot(): MockIot {
  const instance = Math.random().toString(36).slice(2, 8);
  const state: MockIot = {
    calls: [],
    things: new Set(),
    policies: new Map(),
    certs: [],
    failNextAttachPolicy: false,
    async ensureThing(thingName) {
      state.calls.push(`ensureThing:${thingName}`);
      state.things.add(thingName);
    },
    async createKeysAndCertificate() {
      const n = state.certs.length + 1;
      const cert: IotCertificateResult = {
        certificateId: `cert-${instance}-${n}`,
        certificateArn: `arn:aws:iot:ap-southeast-1:123456789012:cert/cert-${instance}-${n}`,
        certificatePem: `-----BEGIN CERTIFICATE-----\nMOCKCERT${instance}${n}\n-----END CERTIFICATE-----`,
        privateKey:
          ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ') +
          `\nMOCKKEY${instance}${n}\n` +
          ['-----END', 'PRIVATE', 'KEY-----'].join(' '),
      };
      state.calls.push(`createKeysAndCertificate:${cert.certificateId}`);
      state.certs.push(cert);
      return cert;
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
  return {
    deviceId,
    request: {
      id: `req-prov-${seq}`,
      serialNumber,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      status: 'APPROVED',
      rejectReason: null,
      reviewedBy: 'admin-1',
      reviewedAt: NOW,
      version: 2,
      createdAt: NOW,
    },
  };
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
      ['ensureThing', 'createKeysAndCertificate', 'ensurePolicy', 'attachPolicy', 'attachThingPrincipal'],
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

    // 第一次：attachPolicy 抛错（Thing 与证书已在 AWS 侧产生，DB 无证书记录）
    iot.failNextAttachPolicy = true;
    let firstError: unknown;
    try {
      await service.provision(request);
    } catch (err) {
      firstError = err;
    }
    assert.ok(firstError instanceof Error && firstError.message.includes('simulated AWS failure'));
    assert.equal(await prisma.device.count({ where: { id: deviceId } }), 1);
    assert.equal(await prisma.deviceCertificate.count({ where: { deviceId } }), 0);

    // 第二次：cert 落库成功但封包前崩溃由第三次重试覆盖 —— 这里直接重试至成功
    const retry = await service.provision(request);
    assert.isFalse(retry.replayed);
    assert.equal(await prisma.device.count({ where: { id: deviceId } }), 1, '业务 Device 不得重复创建');
    assert.equal(await prisma.deviceCertificate.count({ where: { deviceId, status: 'PENDING_CLAIM' } }), 1);
    // 第一次产生的 AWS 证书未落库（无孤儿业务记录）；AWS 侧孤儿证书为已知风险（见文档）
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
});
