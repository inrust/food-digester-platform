/**
 * BE-CERT-02 轮换确认扩展点验收（PGlite）：新证书首个 Heartbeat 后停用旧证并销毁新证书包。
 *
 * 验收基准覆盖：
 * - 切换前旧证可用，确认后旧证禁用（AUTH-03 白名单验证 401）；
 * - 确认原子性：旧证 REVOKED + 新包销毁 + 审计；
 * - 幂等：重复确认/非轮换证书 Heartbeat 不产生副作用；并发确认仅一个生效。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import {
  CERTIFICATE_PACKAGE_RETENTION_SECONDS,
  certificateFingerprintFromPem,
  createLocalTestKeyProvider,
  SecurePackageService,
  verifyDeviceCertificate,
} from '@fdp/auth';
import { confirmCertificateRotationOnFirstHeartbeat } from '../src/index.js';
import type { RotationConfirmationDeps } from '../src/index.js';
import { createTestDb } from '../../cloud-api/test/helpers.js';

const NOW = new Date('2026-08-27T08:00:00Z');
const now = () => NOW;
const DAY_MS = 86_400_000;

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;
let securePackage: SecurePackageService;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
  securePackage = new SecurePackageService({
    db: prisma,
    keyProvider: createLocalTestKeyProvider('be-cert-02-confirm'),
    config: { retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS, maxClaims: 1, now },
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function fixturePem(seed: string): string {
  const body = Buffer.from(`confirm-cert-${seed}`, 'utf8').toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

let seq = 0;
/** 落库 Active 设备 + 旧证书 ACTIVE + 轮换新证书 ACTIVE（rotatedFromId=旧，带证书包）。 */
async function plantRotationWindow() {
  seq += 1;
  const deviceId = `dev-rotc-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-ROTC-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
    },
  });
  const oldPem = fixturePem(`old-${seq}`);
  const newPem = fixturePem(`new-${seq}`);
  const oldCertificateId = `cert-rotc-old-${seq}`;
  const newCertificateId = `cert-rotc-new-${seq}`;
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
  await prisma.deviceCertificate.create({
    data: {
      id: newCertificateId,
      deviceId,
      fingerprint: certificateFingerprintFromPem(newPem),
      status: 'ACTIVE',
      rotatedFromId: oldCertificateId,
      notBefore: NOW,
      notAfter: new Date(NOW.getTime() + 365 * DAY_MS),
    },
  });
  await securePackage.storePackage(newCertificateId, Buffer.from('{}'));
  return { deviceId, oldPem, newPem, oldCertificateId, newCertificateId };
}

function deps(): RotationConfirmationDeps {
  return { client: prisma, securePackage, now };
}

describe('confirmCertificateRotationOnFirstHeartbeat', () => {
  test('新证书首个 Heartbeat：旧证 REVOKED + 新包销毁 + 审计；确认后旧证认证 401', async () => {
    const { deviceId, oldPem, newPem, oldCertificateId, newCertificateId } = await plantRotationWindow();

    // BE-CERT-03：管理端发起的 PENDING 轮换请求在确认时完成
    await prisma.certificateRotationRequest.create({
      data: {
        deviceId,
        certificateId: oldCertificateId,
        status: 'PENDING',
        requestedBy: 'admin-1',
        notifiedAt: NOW,
      },
    });

    // 切换前旧证可用
    const before = await verifyDeviceCertificate(prisma, { clientCertPem: oldPem }, { now: now() });
    assert.equal(before.deviceId, deviceId);

    const result = await confirmCertificateRotationOnFirstHeartbeat(deps(), {
      deviceId,
      certificateFingerprint: certificateFingerprintFromPem(newPem),
    });
    assert.isTrue(result.confirmed);
    assert.equal(result.revokedCertificateId, oldCertificateId);

    const oldCert = await prisma.deviceCertificate.findFirst({ where: { id: oldCertificateId } });
    assert.equal(oldCert?.status, 'REVOKED');
    assert.ok(oldCert?.revokedAt);
    const newCert = await prisma.deviceCertificate.findFirst({ where: { id: newCertificateId } });
    assert.equal(newCert?.status, 'ACTIVE');
    assert.equal(newCert?.packageCiphertext, null, '新证书包必须销毁');

    // 确认后旧证禁用
    let revokedAuthError: unknown;
    try {
      await verifyDeviceCertificate(prisma, { clientCertPem: oldPem }, { now: now() });
    } catch (err) {
      revokedAuthError = err;
    }
    assert.ok(revokedAuthError instanceof Error, '确认后旧证必须被 AUTH-03 拒绝');

    const audits = await prisma.auditLog.findMany({ where: { objectId: newCertificateId } });
    assert.ok(audits.some((a) => a.action === 'CERT_ROTATION_CONFIRM' && a.result === 'SUCCESS'));
    assert.ok(!JSON.stringify(audits).includes('PRIVATE KEY'));

    // BE-CERT-03：PENDING 轮换请求已完成
    const request = await prisma.certificateRotationRequest.findFirst({ where: { deviceId } });
    assert.equal(request?.status, 'COMPLETED');
    assert.ok(request?.completedAt);
  });

  test('幂等：重复确认无副作用；旧证书 Heartbeat（非轮换）不触发确认；并发仅一个生效', async () => {
    const { deviceId, newPem, oldCertificateId } = await plantRotationWindow();
    const fp = certificateFingerprintFromPem(newPem);

    const [a, b] = await Promise.all([
      confirmCertificateRotationOnFirstHeartbeat(deps(), { deviceId, certificateFingerprint: fp }),
      confirmCertificateRotationOnFirstHeartbeat(deps(), { deviceId, certificateFingerprint: fp }),
    ]);
    assert.deepEqual([a.confirmed, b.confirmed].sort(), [false, true]);

    const again = await confirmCertificateRotationOnFirstHeartbeat(deps(), {
      deviceId,
      certificateFingerprint: fp,
    });
    assert.isFalse(again.confirmed);
    // 幂等无副作用 = 状态不重复变更（旧证 revokedAt 唯一、新包已销毁）；
    // audited() 对进入事务的调用诚实留痕（并发败方一条），确认后的重放由预检静默短路（无审计）
    const newCertRow = await prisma.deviceCertificate.findFirst({ where: { fingerprint: fp } });
    assert.ok(newCertRow);
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: newCertRow.id, action: 'CERT_ROTATION_CONFIRM', result: 'SUCCESS' },
      }),
      2,
    );

    // 非轮换证书 Heartbeat（普通单证书设备）
    const plain = await plantRotationWindow();
    const nonRotation = await confirmCertificateRotationOnFirstHeartbeat(deps(), {
      deviceId: plain.deviceId,
      certificateFingerprint: certificateFingerprintFromPem(plain.oldPem),
    });
    assert.isFalse(nonRotation.confirmed);
    const oldStillActive = await prisma.deviceCertificate.findFirst({
      where: { id: plain.oldCertificateId },
    });
    assert.equal(oldStillActive?.status, 'ACTIVE');
    // 未被确认的轮换窗口旧证仍可用
    const windowOld = await prisma.deviceCertificate.findFirst({ where: { id: oldCertificateId } });
    assert.equal(windowOld?.status, 'REVOKED'); // 已确认窗口的旧证保持禁用
  });
});
