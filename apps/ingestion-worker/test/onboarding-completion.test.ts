/**
 * BE-ONB-04 首个 Heartbeat 完成 Onboarding 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 首个合法 Heartbeat 迁移一次（OnboardingApproved → Onboarded，原子：状态历史 + 证书 ACTIVE
 *   + 证书包销毁 + 上线时间）；
 * - 其他证书（指纹不匹配）不迁移（FORBIDDEN + FAILURE 审计）；
 * - 非法状态（PendingOnboarding/Active）不迁移；
 * - 重复/并发 Heartbeat 幂等（仅一次迁移、无重复历史/审计）。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { createLocalTestKeyProvider, SecurePackageService } from '@fdp/auth';
import { DeviceStateError } from '@fdp/domain';
import { completeOnboardingOnFirstHeartbeat } from '../src/index.js';
import type { OnboardingCompletionDeps } from '../src/index.js';
import { createTestDb } from '../../cloud-api/test/helpers.js';

const NOW = new Date('2026-08-27T08:00:00Z');
const now = () => NOW;

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;
let securePackage: SecurePackageService;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
  securePackage = new SecurePackageService({
    db: prisma,
    keyProvider: createLocalTestKeyProvider('be-onb-04'),
    config: { retentionSeconds: 3600, maxClaims: 1, now },
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

let seq = 0;
interface Planted {
  deviceId: string;
  certificateId: string;
  fingerprint: string;
}

/** 落库 OnboardingApproved 设备 + PENDING_CLAIM 证书（带真实信封密文包）。 */
async function plantApprovedDevice(
  options: { lifecycleStatus?: string; withPackage?: boolean } = {},
): Promise<Planted> {
  seq += 1;
  const deviceId = `dev-hb-${seq}`;
  const certificateId = `cert-hb-${seq}`;
  const fingerprint = `fp-hb-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-HB-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycleStatus ?? 'OnboardingApproved',
    },
  });
  await prisma.deviceCertificate.create({
    data: {
      id: certificateId,
      deviceId,
      fingerprint,
      status: 'PENDING_CLAIM',
      notBefore: NOW,
      notAfter: new Date('2027-08-27T00:00:00Z'),
    },
  });
  if (options.withPackage !== false) {
    await securePackage.storePackage(
      certificateId,
      Buffer.from(JSON.stringify({ certificatePem: 'p', privateKey: 'k' })),
    );
  }
  return { deviceId, certificateId, fingerprint };
}

function deps(): OnboardingCompletionDeps {
  return { client: prisma, securePackage, now };
}

describe('completeOnboardingOnFirstHeartbeat', () => {
  test('首个合法 Heartbeat：原子迁移 Onboarded + 状态历史 + 证书 ACTIVE + 包销毁 + 上线时间 + 审计', async () => {
    const { deviceId, certificateId, fingerprint } = await plantApprovedDevice();
    const before = await prisma.deviceCertificate.findFirst({ where: { id: certificateId } });
    assert.ok(before?.packageCiphertext, '迁移前证书包应存在（销毁证明的前置）');

    const result = await completeOnboardingOnFirstHeartbeat(deps(), { deviceId, certificateFingerprint: fingerprint });
    assert.isTrue(result.transitioned);
    assert.isTrue(result.packageDestroyed);

    const device = await prisma.device.findFirst({ where: { id: deviceId } });
    assert.equal(device?.lifecycleStatus, 'Onboarded');

    const history = await prisma.deviceStateHistory.findMany({ where: { deviceId, toStatus: 'Onboarded' } });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.fromStatus, 'OnboardingApproved');
    assert.equal(history[0]?.actorType, 'SYSTEM');

    const cert = await prisma.deviceCertificate.findFirst({ where: { id: certificateId } });
    assert.equal(cert?.status, 'ACTIVE');
    assert.equal(cert?.packageCiphertext, null, '敏感包必须销毁');
    assert.equal(cert?.packageKmsKeyId, null);

    const latest = await prisma.deviceLatestState.findFirst({ where: { deviceId } });
    assert.equal(latest?.connectivity, 'ONLINE');
    assert.equal(latest?.lastHeartbeatAt?.toISOString(), NOW.toISOString());

    const audits = await prisma.auditLog.findMany({ where: { objectId: { in: [deviceId, certificateId] } } });
    const actions = audits.map((a) => `${a.action}:${a.result}`).sort();
    assert.ok(actions.includes('device.lifecycle.OnboardingApproved_to_Onboarded:SUCCESS'));
    assert.ok(actions.includes('CERT_PACKAGE_DESTROY:SUCCESS'));
  });

  test('重复 Heartbeat 幂等：不重复迁移/历史/审计；并发首个 Heartbeat 仅一个生效', async () => {
    const { deviceId, fingerprint } = await plantApprovedDevice();
    const first = await completeOnboardingOnFirstHeartbeat(deps(), { deviceId, certificateFingerprint: fingerprint });
    assert.isTrue(first.transitioned);

    const second = await completeOnboardingOnFirstHeartbeat(deps(), { deviceId, certificateFingerprint: fingerprint });
    assert.isFalse(second.transitioned);
    assert.isFalse(second.packageDestroyed);
    assert.equal(await prisma.deviceStateHistory.count({ where: { deviceId } }), 1);
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: deviceId, action: 'device.lifecycle.OnboardingApproved_to_Onboarded' },
      }),
      1,
    );

    // 并发：两个首个 Heartbeat 竞争，条件更新保证只有一个迁移
    const race = await plantApprovedDevice();
    const [a, b] = await Promise.all([
      completeOnboardingOnFirstHeartbeat(deps(), {
        deviceId: race.deviceId,
        certificateFingerprint: race.fingerprint,
      }),
      completeOnboardingOnFirstHeartbeat(deps(), {
        deviceId: race.deviceId,
        certificateFingerprint: race.fingerprint,
      }),
    ]);
    assert.deepEqual([a.transitioned, b.transitioned].sort(), [false, true]);
    assert.equal(await prisma.deviceStateHistory.count({ where: { deviceId: race.deviceId } }), 1);
  });

  test('其他证书（指纹不匹配）不迁移：FORBIDDEN + FAILURE 审计，设备状态不变', async () => {
    const { deviceId } = await plantApprovedDevice();
    try {
      await completeOnboardingOnFirstHeartbeat(deps(), { deviceId, certificateFingerprint: 'fp-other-cert' });
      assert.fail('应抛出 FORBIDDEN');
    } catch (err) {
      assert.ok(err instanceof DeviceStateError);
      assert.equal(err.code, 'FORBIDDEN');
    }
    const device = await prisma.device.findFirst({ where: { id: deviceId } });
    assert.equal(device?.lifecycleStatus, 'OnboardingApproved');
    const audits = await prisma.auditLog.findMany({
      where: { objectId: deviceId, action: 'device.lifecycle.OnboardingApproved_to_Onboarded' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'FAILURE');
  });

  test('非法状态不迁移：PendingOnboarding / Active 均 DEVICE_STATE_NOT_ALLOWED', async () => {
    for (const lifecycleStatus of ['PendingOnboarding', 'Active']) {
      const planted = await plantApprovedDevice({ lifecycleStatus });
      try {
        await completeOnboardingOnFirstHeartbeat(deps(), {
          deviceId: planted.deviceId,
          certificateFingerprint: planted.fingerprint,
        });
        assert.fail(`状态 ${lifecycleStatus} 应拒绝迁移`);
      } catch (err) {
        assert.ok(err instanceof DeviceStateError);
        assert.equal(err.code, 'DEVICE_STATE_NOT_ALLOWED');
      }
      const device = await prisma.device.findFirst({ where: { id: planted.deviceId } });
      assert.equal(device?.lifecycleStatus, lifecycleStatus);
      assert.equal(await prisma.deviceStateHistory.count({ where: { deviceId: planted.deviceId } }), 0);
    }
  });

  test('证书包已被领取（无密文）时迁移仍成功，销毁幂等 false', async () => {
    const { deviceId, certificateId, fingerprint } = await plantApprovedDevice({ withPackage: false });
    const result = await completeOnboardingOnFirstHeartbeat(deps(), { deviceId, certificateFingerprint: fingerprint });
    assert.isTrue(result.transitioned);
    assert.isFalse(result.packageDestroyed);
    const cert = await prisma.deviceCertificate.findFirst({ where: { id: certificateId } });
    assert.equal(cert?.status, 'ACTIVE');
  });
});
