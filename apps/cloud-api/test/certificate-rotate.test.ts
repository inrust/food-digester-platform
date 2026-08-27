/**
 * BE-CERT-02 Certificate Rotate API 验收（PGlite 真实 PostgreSQL + 全部 migration + mock IoT）。
 *
 * 验收基准覆盖：
 * - 正向：创建新证书包并返回五字段；双证书窗口（旧证仍 ACTIVE 可用）；
 * - 旧证书错误/撤销/跨设备均拒绝（400/401/403）；
 * - 重试不产生无限证书（同旧证书未确认轮换 → 409，无新增 AWS 发证/证书行）；
 * - 私钥不落库、不进审计。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { certificateFingerprintFromPem, createLocalTestKeyProvider, verifyDeviceCertificate } from '@fdp/auth';
import type { IotPolicyDocument } from '@fdp/aws-clients';
import { createCertificateRotateHandler } from '../src/index.js';
import type { CertificateRotateHandlerDeps, IotCertificateResult, IotProvisioningPort } from '../src/index.js';
import { createTestDb } from './helpers.js';

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
  const body = Buffer.from(`rotate-cert-${seed}`, 'utf8').toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

let iotSeq = 0;
function mockIot(options: { failNextAttach?: boolean } = {}): IotProvisioningPort & { createCalls: number } {
  const state = {
    createCalls: 0,
    async ensureThing() {},
    async createKeysAndCertificate(): Promise<IotCertificateResult> {
      state.createCalls += 1;
      iotSeq += 1;
      const id = `cert-rot-${iotSeq}`;
      return {
        certificateId: id,
        certificateArn: `arn:aws:iot:ap-southeast-1:123456789012:cert/${id}`,
        certificatePem: fixturePem(`new-${iotSeq}`),
        privateKey:
          ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ') +
          `\nROTKEY${iotSeq}\n` +
          ['-----END', 'PRIVATE', 'KEY-----'].join(' '),
      };
    },
    async ensurePolicy(_name: string, _doc: IotPolicyDocument) {},
    async attachPolicy() {
      if (options.failNextAttach) {
        options.failNextAttach = false;
        throw new Error('simulated AWS failure');
      }
    },
    async attachThingPrincipal() {},
  };
  return state;
}

let seq = 0;
/** 落库 Active 设备 + ACTIVE 旧证书；返回旧证书信息。 */
async function plantDeviceWithOldCert() {
  seq += 1;
  const deviceId = `dev-rot-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-ROT-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
    },
  });
  const oldPem = fixturePem(`old-${seq}`);
  const oldCertificateId = `cert-old-${seq}`;
  await prisma.deviceCertificate.create({
    data: {
      id: oldCertificateId,
      deviceId,
      fingerprint: certificateFingerprintFromPem(oldPem),
      status: 'ACTIVE',
      notBefore: new Date(NOW.getTime() - 30 * DAY_MS),
      notAfter: new Date(NOW.getTime() + 200 * DAY_MS),
    },
  });
  return { deviceId, oldPem, oldCertificateId };
}

function makeHandler(iot: IotProvisioningPort): ReturnType<typeof createCertificateRotateHandler> {
  const deps: CertificateRotateHandlerDeps = {
    client: prisma,
    iot,
    keyProvider: createLocalTestKeyProvider('be-cert-02'),
    config: {
      region: 'ap-southeast-1',
      accountId: '123456789012',
      packageRetentionSeconds: 3600,
      certificateValiditySeconds: 365 * 24 * 3600,
    },
    now,
  };
  return createCertificateRotateHandler(deps);
}

interface RotatePayload {
  data: {
    certificateId: string;
    certificatePem: string;
    privateKey: string;
    effectiveDate: string;
    expiryDate: string;
  };
  meta: { requestId: string; timestamp: string };
}

describe('POST /api/v1/device/certificate/rotate', () => {
  test('正向：返回五字段证书包；双证书窗口（旧证仍可用）；私钥不落库/审计', async () => {
    const { deviceId, oldPem, oldCertificateId } = await plantDeviceWithOldCert();
    const iot = mockIot();
    const handler = makeHandler(iot);

    const res = await handler({
      identity: { clientCertPem: oldPem },
      body: { currentCertificateId: oldCertificateId },
      requestId: 'req-rotate',
    });
    assert.equal(res.status, 200);
    const body = res.body as RotatePayload;
    assert.ok(body.data.certificateId);
    assert.match(body.data.certificatePem, /BEGIN CERTIFICATE/);
    assert.ok(body.data.privateKey.includes('ROTKEY'));
    assert.equal(body.data.effectiveDate, NOW.toISOString());
    assert.match(body.data.expiryDate, /^\d{4}-\d{2}-\d{2}$/);

    // 双证书窗口：新证书 ACTIVE + rotatedFromId；旧证书仍 ACTIVE 可用（AUTH-03 认证通过）
    const newCert = await prisma.deviceCertificate.findFirst({ where: { id: body.data.certificateId } });
    assert.equal(newCert?.status, 'ACTIVE');
    assert.equal(newCert?.rotatedFromId, oldCertificateId);
    assert.ok(newCert?.packageCiphertext, '证书包应信封加密保存');
    const oldAuth = await verifyDeviceCertificate(prisma, { clientCertPem: oldPem }, { now: now() });
    assert.equal(oldAuth.deviceId, deviceId, '切换前旧证可用');

    // 私钥不落库/审计
    const certRows = await prisma.deviceCertificate.findMany({ where: { deviceId } });
    assert.ok(!JSON.stringify(certRows.map(({ packageCiphertext: _c, ...rest }) => rest)).includes('ROTKEY'));
    const audits = await prisma.auditLog.findMany({ where: { objectId: body.data.certificateId } });
    assert.ok(audits.some((a) => a.action === 'CERT_ROTATION_START'));
    assert.ok(!JSON.stringify(audits).includes('ROTKEY'));
  });

  test('旧证书错误/跨设备拒绝：缺字段 400；与身份不符 403（含他设备证书）', async () => {
    const { oldPem, oldCertificateId } = await plantDeviceWithOldCert();
    const other = await plantDeviceWithOldCert();
    const handler = makeHandler(mockIot());

    const missing = await handler({ identity: { clientCertPem: oldPem }, body: {}, requestId: 'r1' });
    assert.equal(missing.status, 400);

    const mismatched = await handler({
      identity: { clientCertPem: oldPem },
      body: { currentCertificateId: other.oldCertificateId },
      requestId: 'r2',
    });
    assert.equal(mismatched.status, 403);
    assert.equal((mismatched.body as { error: { code: string } }).error.code, 'FORBIDDEN');

    const ok = await handler({
      identity: { clientCertPem: oldPem },
      body: { currentCertificateId: oldCertificateId },
      requestId: 'r3',
    });
    assert.equal(ok.status, 200);
  });

  test('旧证书撤销/过期 → 401（认证层先行拒绝）', async () => {
    const { oldPem, oldCertificateId } = await plantDeviceWithOldCert();
    await prisma.deviceCertificate.updateMany({
      where: { id: oldCertificateId },
      data: { status: 'REVOKED', revokedAt: NOW },
    });
    const res = await makeHandler(mockIot())({
      identity: { clientCertPem: oldPem },
      body: { currentCertificateId: oldCertificateId },
      requestId: 'r4',
    });
    assert.equal(res.status, 401);
  });

  test('重试不产生无限证书：未确认轮换重复请求 409，无新增 AWS 发证与证书行', async () => {
    const { deviceId, oldPem, oldCertificateId } = await plantDeviceWithOldCert();
    const iot = mockIot();
    const handler = makeHandler(iot);

    assert.equal(
      (
        await handler({
          identity: { clientCertPem: oldPem },
          body: { currentCertificateId: oldCertificateId },
          requestId: 'r5',
        })
      ).status,
      200,
    );
    const retry = await handler({
      identity: { clientCertPem: oldPem },
      body: { currentCertificateId: oldCertificateId },
      requestId: 'r6',
    });
    assert.equal(retry.status, 409);
    assert.equal((retry.body as { error: { code: string } }).error.code, 'CONFLICT');
    assert.equal(iot.createCalls, 1, '不得重复调用 AWS 发证');
    assert.equal(
      await prisma.deviceCertificate.count({ where: { deviceId, status: 'ACTIVE' } }),
      2, // 旧 + 新（双证书窗口）
    );
  });

  test('部分失败（发证后 attach 失败）可重试：不建孤儿业务记录，重试成功', async () => {
    const { deviceId, oldPem, oldCertificateId } = await plantDeviceWithOldCert();
    const iot = mockIot({ failNextAttach: true });
    const handler = makeHandler(iot);

    const first = await handler({
      identity: { clientCertPem: oldPem },
      body: { currentCertificateId: oldCertificateId },
      requestId: 'r7',
    });
    assert.equal(first.status, 500);
    assert.equal(await prisma.deviceCertificate.count({ where: { deviceId, rotatedFromId: oldCertificateId } }), 0);

    const retry = await handler({
      identity: { clientCertPem: oldPem },
      body: { currentCertificateId: oldCertificateId },
      requestId: 'r8',
    });
    assert.equal(retry.status, 200);
    assert.equal(await prisma.deviceCertificate.count({ where: { deviceId, rotatedFromId: oldCertificateId } }), 1);
  });
});
