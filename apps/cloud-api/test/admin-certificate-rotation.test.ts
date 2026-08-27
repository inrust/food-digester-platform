/**
 * BE-CERT-03 管理员证书轮换发起 API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 合法请求生成一次通知（Outbox 事件恰好一条，类型/Topic 符合 CT-03/CT-04）；
 * - 重复点击不创建多个有效请求（幂等重放 200；并发发起仅一条 PENDING）；
 * - Retired/撤销证书设备路径按规则拒绝（409）；非授权角色 403 / 未认证 401；
 * - 任何管理端响应和审计均无 privateKey/PEM。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { createAdminCertificateRotationHandler } from '../src/index.js';
import { createTestDb } from './helpers.js';

const NOW = new Date('2026-08-27T08:00:00Z');
const now = () => NOW;
const DAY_MS = 86_400_000;

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
const operator: ActorContext = { ...superAdmin, roles: ['PlatformOperator'] };

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

let seq = 0;
async function plantDevice(options: { lifecycleStatus?: string; certStatus?: string | null } = {}) {
  seq += 1;
  const deviceId = `dev-admrot-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-ADMROT-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycleStatus ?? 'Active',
    },
  });
  let certificateId: string | null = null;
  if (options.certStatus !== null) {
    certificateId = `cert-admrot-${seq}`;
    await prisma.deviceCertificate.create({
      data: {
        id: certificateId,
        deviceId,
        fingerprint: `fp-admrot-${seq}`,
        status: options.certStatus ?? 'ACTIVE',
        ...(options.certStatus === 'REVOKED' ? { revokedAt: NOW } : {}),
        notBefore: new Date(NOW.getTime() - 30 * DAY_MS),
        notAfter: new Date(NOW.getTime() + 200 * DAY_MS),
      },
    });
  }
  return { deviceId, certificateId };
}

function handler() {
  return createAdminCertificateRotationHandler({ client: prisma, now });
}

interface RotationView {
  requestId: string;
  deviceId: string;
  certificateId: string;
  certificateStatus: string;
  expiryDate: string;
  requestStatus: string;
  requestedAt: string;
}

describe('POST /api/v1/admin/devices/{deviceId}/certificate-rotation-requests', () => {
  test('正向：201 创建 + 恰好一条 Outbox 通知（CERTIFICATE_ROTATION_REQUIRED）+ 审计 + 无密钥材料', async () => {
    const { deviceId, certificateId } = await plantDevice();
    const res = await handler()({
      actor: superAdmin,
      headers: {},
      params: { deviceId },
      requestId: 'req-rot-1',
    });
    assert.equal(res.status, 201);
    const view = (res.body as { data: RotationView }).data;
    assert.equal(view.deviceId, deviceId);
    assert.equal(view.certificateId, certificateId);
    assert.equal(view.certificateStatus, 'ACTIVE');
    assert.equal(view.requestStatus, 'PENDING');
    assert.match(view.expiryDate, /^\d{4}-\d{2}-\d{2}$/);

    // 恰好一条通知，类型与 Topic 符合契约
    const events = await prisma.outboxEvent.findMany({ where: { aggregateId: deviceId } });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, 'CERTIFICATE_ROTATION_REQUIRED');
    assert.equal((events[0]?.payload as { topic: string }).topic, `bnx/device/${deviceId}/notification`);

    const audits = await prisma.auditLog.findMany({ where: { objectId: view.requestId } });
    assert.ok(audits.some((a) => a.action === 'CERT_ROTATION_REQUEST' && a.result === 'SUCCESS'));

    // 响应与审计均无 PEM/私钥
    const serialized = JSON.stringify(res.body) + JSON.stringify(audits);
    assert.ok(!/privateKey|certificatePem|BEGIN CERTIFICATE|PRIVATE KEY/i.test(serialized));
  });

  test('重复点击幂等：200 重放原请求，不重复建请求/通知；并发发起仅一条 PENDING', async () => {
    const { deviceId } = await plantDevice();
    const first = await handler()({ actor: superAdmin, headers: {}, params: { deviceId }, requestId: 'r1' });
    assert.equal(first.status, 201);
    const firstId = (first.body as { data: RotationView }).data.requestId;

    const second = await handler()({ actor: superAdmin, headers: {}, params: { deviceId }, requestId: 'r2' });
    assert.equal(second.status, 200);
    assert.equal((second.body as { data: RotationView }).data.requestId, firstId);
    assert.equal(await prisma.certificateRotationRequest.count({ where: { deviceId } }), 1);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: deviceId } }), 1);

    // 并发重复点击：部分唯一索引兜底，恰一个新建
    const race = await plantDevice();
    const [a, b] = await Promise.all([
      handler()({ actor: superAdmin, headers: {}, params: { deviceId: race.deviceId }, requestId: 'r3' }),
      handler()({ actor: superAdmin, headers: {}, params: { deviceId: race.deviceId }, requestId: 'r4' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(await prisma.certificateRotationRequest.count({ where: { deviceId: race.deviceId } }), 1);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: race.deviceId } }), 1);
  });

  test('非授权角色 403；未认证 401', async () => {
    const { deviceId } = await plantDevice();
    const forbidden = await handler()({ actor: operator, headers: {}, params: { deviceId }, requestId: 'r5' });
    assert.equal(forbidden.status, 403);
    const unauthenticated = await handler()({ headers: {}, params: { deviceId }, requestId: 'r6' });
    assert.equal(unauthenticated.status, 401);
  });

  test('Retired/Onboarding 中/仅撤销证书/无证书设备均按规则拒绝；未知设备 404', async () => {
    const retired = await plantDevice({ lifecycleStatus: 'Retired' });
    const res1 = await handler()({
      actor: superAdmin,
      headers: {},
      params: { deviceId: retired.deviceId },
      requestId: 'r7',
    });
    assert.equal(res1.status, 409);
    assert.equal((res1.body as { error: { code: string } }).error.code, 'DEVICE_STATE_NOT_ALLOWED');

    const onboarding = await plantDevice({ lifecycleStatus: 'OnboardingApproved' });
    assert.equal(
      (await handler()({ actor: superAdmin, headers: {}, params: { deviceId: onboarding.deviceId }, requestId: 'r8' }))
        .status,
      409,
    );

    const revokedOnly = await plantDevice({ certStatus: 'REVOKED' });
    const res3 = await handler()({
      actor: superAdmin,
      headers: {},
      params: { deviceId: revokedOnly.deviceId },
      requestId: 'r9',
    });
    assert.equal(res3.status, 409);
    assert.equal((res3.body as { error: { code: string } }).error.code, 'CONFLICT');

    const noCert = await plantDevice({ certStatus: null });
    assert.equal(
      (await handler()({ actor: superAdmin, headers: {}, params: { deviceId: noCert.deviceId }, requestId: 'r10' }))
        .status,
      409,
    );

    assert.equal(
      (await handler()({ actor: superAdmin, headers: {}, params: { deviceId: 'dev-unknown' }, requestId: 'r11' }))
        .status,
      404,
    );
  });
});
