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
import { CERTIFICATE_PACKAGE_RETENTION_SECONDS, createLocalTestKeyProvider, SecurePackageService } from '@fdp/auth';
import { DeviceStateError } from '@fdp/domain';
import { completeOnboardingOnFirstHeartbeat, evaluateOnboardingDeadlines } from '../src/index.js';
import type { OnboardingCompletionDeps, OnboardingDeadlineEvaluatorDeps } from '../src/index.js';
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
    config: { retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS, maxClaims: 1, now },
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

let seq = 0;
interface Planted {
  deviceId: string;
  serialNumber: string;
  certificateId: string;
  fingerprint: string;
}

/** 落库 OnboardingApproved 设备 + PENDING_CLAIM 证书（带真实信封密文包）。 */
async function plantApprovedDevice(
  options: { lifecycleStatus?: string; withPackage?: boolean; deadlineAt?: Date } = {},
): Promise<Planted & { requestId: string }> {
  seq += 1;
  const deviceId = `dev-hb-${seq}`;
  const serialNumber = `SN-HB-${seq}`;
  const certificateId = `cert-hb-${seq}`;
  const fingerprint = `fp-hb-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber,
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
  const token = await prisma.onboardingToken.create({
    data: {
      tokenHash: `token-hash-${deviceId}`,
      serialNumber,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    },
  });
  const request = await prisma.onboardingRequest.create({
    data: {
      tokenId: token.id,
      serialNumber,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      status: 'APPROVED',
      onboardingDeadlineAt: options.deadlineAt ?? new Date(NOW.getTime() + 86_400_000),
    },
  });
  return { deviceId, serialNumber, certificateId, fingerprint, requestId: request.id };
}

function deps(): OnboardingCompletionDeps {
  return { client: prisma, securePackage, certificateRevoker: { revokeCertificate: async () => {} }, now };
}

async function plantDeadlineCandidate(deadlineAt: Date): Promise<Planted & { requestId: string }> {
  return plantApprovedDevice({ deadlineAt });
}

describe('completeOnboardingOnFirstHeartbeat', () => {
  test('截止边界后 Heartbeat 先于 evaluator 到达：失败关闭并原子执行超时处置；并发仅处置一次', async () => {
    const deadline = new Date(NOW.getTime() - 1);
    const planted = await plantApprovedDevice({ deadlineAt: deadline });
    const revoked: string[] = [];
    const lateDeps: OnboardingCompletionDeps = {
      ...deps(),
      certificateRevoker: { revokeCertificate: async (id) => void revoked.push(id) },
    };

    const attempts = await Promise.allSettled([
      completeOnboardingOnFirstHeartbeat(lateDeps, {
        deviceId: planted.deviceId,
        certificateFingerprint: planted.fingerprint,
        occurredAt: NOW,
      }),
      completeOnboardingOnFirstHeartbeat(lateDeps, {
        deviceId: planted.deviceId,
        certificateFingerprint: planted.fingerprint,
        occurredAt: NOW,
      }),
    ]);

    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 2);
    for (const attempt of attempts) {
      assert.equal(attempt.status, 'rejected');
      if (attempt.status === 'rejected') assert.ok(attempt.reason instanceof DeviceStateError);
    }
    const request = await prisma.onboardingRequest.findUniqueOrThrow({ where: { id: planted.requestId } });
    assert.equal(request.status, 'TIMED_OUT');
    assert.equal(request.rejectReason, 'ONBOARDING_TIMEOUT');
    assert.equal(
      (await prisma.device.findUniqueOrThrow({ where: { id: planted.deviceId } })).lifecycleStatus,
      'PendingOnboarding',
    );
    const certificate = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: planted.certificateId } });
    assert.equal(certificate.status, 'REVOKED');
    assert.equal(certificate.packageCiphertext, null);
    assert.deepEqual(revoked, [planted.certificateId]);
    assert.equal(await prisma.deviceStateHistory.count({ where: { deviceId: planted.deviceId } }), 1);
  });

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
    assert.equal(history[0]?.axis, 'lifecycle');
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

describe('evaluateOnboardingDeadlines（DEC-017）', () => {
  test('截止前不处理；精确边界一次性超时并撤证、销毁包、回到 PendingOnboarding', async () => {
    const deadline = new Date(NOW.getTime() + 60_000);
    const planted = await plantDeadlineCandidate(deadline);
    const revoked: string[] = [];
    const evaluatorDeps: OnboardingDeadlineEvaluatorDeps = {
      ...deps(),
      certificateRevoker: { revokeCertificate: async (id) => void revoked.push(id) },
    };

    const before = await evaluateOnboardingDeadlines(evaluatorDeps, {
      at: new Date(deadline.getTime() - 1),
    });
    assert.deepEqual(before, { evaluated: 0, timedOut: 0, revocationRetried: 0, skipped: 0, failed: 0 });

    const atBoundary = await evaluateOnboardingDeadlines(evaluatorDeps, { at: deadline });
    assert.deepEqual(atBoundary, { evaluated: 1, timedOut: 1, revocationRetried: 0, skipped: 0, failed: 0 });
    assert.deepEqual(revoked, [planted.certificateId]);

    const request = await prisma.onboardingRequest.findUniqueOrThrow({ where: { id: planted.requestId } });
    assert.equal(request.status, 'TIMED_OUT');
    assert.equal(request.rejectReason, 'ONBOARDING_TIMEOUT');
    assert.equal(request.timedOutAt?.toISOString(), deadline.toISOString());
    assert.equal(request.revocationCompletedAt?.toISOString(), deadline.toISOString());
    assert.equal(
      (await prisma.device.findUniqueOrThrow({ where: { id: planted.deviceId } })).lifecycleStatus,
      'PendingOnboarding',
    );
    const certificate = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: planted.certificateId } });
    assert.equal(certificate.status, 'REVOKED');
    assert.equal(certificate.revokedAt?.toISOString(), deadline.toISOString());
    assert.equal(certificate.packageCiphertext, null);
    assert.equal(await prisma.deviceStateHistory.count({ where: { deviceId: planted.deviceId } }), 1);

    const replay = await evaluateOnboardingDeadlines(evaluatorDeps, { at: new Date(deadline.getTime() + 1) });
    assert.deepEqual(replay, { evaluated: 0, timedOut: 0, revocationRetried: 0, skipped: 0, failed: 0 });
    assert.equal(revoked.length, 1);

    try {
      await completeOnboardingOnFirstHeartbeat(deps(), {
        deviceId: planted.deviceId,
        certificateFingerprint: planted.fingerprint,
        occurredAt: new Date(deadline.getTime() + 1),
      });
      assert.fail('超时后的迟到 Heartbeat 应失败关闭');
    } catch (error) {
      assert.ok(error instanceof DeviceStateError);
      assert.equal(error.code, 'DEVICE_STATE_NOT_ALLOWED');
    }
  });

  test('云端撤证失败不重复本地迁移，下一轮只重试撤证', async () => {
    const planted = await plantDeadlineCandidate(NOW);
    let attempts = 0;
    const evaluatorDeps: OnboardingDeadlineEvaluatorDeps = {
      ...deps(),
      certificateRevoker: {
        revokeCertificate: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('IoT unavailable');
        },
      },
    };

    const first = await evaluateOnboardingDeadlines(evaluatorDeps, { at: NOW });
    assert.deepEqual(first, { evaluated: 1, timedOut: 1, revocationRetried: 0, skipped: 0, failed: 1 });
    const second = await evaluateOnboardingDeadlines(evaluatorDeps, { at: new Date(NOW.getTime() + 1) });
    assert.deepEqual(second, { evaluated: 1, timedOut: 0, revocationRetried: 1, skipped: 0, failed: 0 });
    assert.equal(attempts, 2);
    assert.equal(await prisma.deviceStateHistory.count({ where: { deviceId: planted.deviceId } }), 1);
    assert.equal(
      await prisma.auditLog.count({ where: { objectId: planted.requestId, action: 'onboarding.timeout' } }),
      1,
    );
  });
});
