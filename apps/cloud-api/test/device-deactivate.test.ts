import { contractHandler } from '../../../contracts/testing/device-contract.js';
/**
 * BE-SYNC-02 Device Deactivate API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 合法确认完成退役（PENDING_CONFIRMATION → CONFIRMED + 撤销 ACTIVE 证书 + 审计）；
 * - Active/Suspended 直接调用被拒绝（409 DEVICE_STATE_NOT_ALLOWED）；
 * - 重复调用结果一致（确认后证书已撤销的重复请求幂等重放，无新写入/审计）；
 * - 顺序正确：确认前证书保持 ACTIVE（设备可确认），确认在先断证在后；
 * - 写审计但不泄露证书材料（仅 certificateId + fingerprint 摘要）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { certificateFingerprintFromPem, verifyDeviceCertificate } from '@fdp/auth';
import { DEACTIVATE_ERROR_HTTP_STATUS, createDeviceDeactivateHandler } from '../src/index.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';

const NOW = new Date('2026-08-28T17:00:00Z');
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

function handler() {
  return checkedCreateDeviceDeactivateHandler({ client: prisma, now, iot: { deactivateCertificate: async () => {} } });
}

function fixturePem(seed: string): string {
  const body = Buffer.from(`deactivate-cert-${seed}`, 'utf8').toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

let seq = 0;
interface Planted {
  deviceId: string;
  pem: string;
  certificateId: string;
}

/** 落库设备 + ACTIVE 证书；可选 PENDING_CONFIRMATION 退役记录（模拟 BE-DEV-04 已 retire）。 */
async function plantDevice(lifecycleStatus: string, withRetirement = false): Promise<Planted> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `Customer DEACT ${seq}` } });
  const deviceId = `dev-deact-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-DEACT-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus,
      customerId: customer.id,
    },
  });
  const pem = fixturePem(`${seq}`);
  const certificateId = `cert-deact-${seq}`;
  await prisma.deviceCertificate.create({
    data: {
      id: certificateId,
      deviceId,
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      certificatePem: pem,
      packageCiphertext: Buffer.from('deact-secret-package'),
      notBefore: new Date(NOW.getTime() - 30 * DAY_MS),
      notAfter: new Date(NOW.getTime() + 200 * DAY_MS),
    },
  });
  if (withRetirement) {
    await prisma.deviceRetirement.create({
      data: {
        deviceId,
        status: 'PENDING_CONFIRMATION',
        reason: '设备报废',
        initiatedBy: 'admin-1',
        initiatedAt: new Date(NOW.getTime() - 3600_000),
      },
    });
  }
  return { deviceId, pem, certificateId };
}

type DataBody = { data: Record<string, unknown>; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

describe('POST /api/v1/device/deactivate（合法确认完成退役）', () => {
  test('确认在先断证在后：CONFIRMED + 证书撤销 + 审计（仅摘要）+ 通用校验此前 403 而本端点可达', async () => {
    const { deviceId, pem, certificateId } = await plantDevice('Retired', true);

    // 顺序约束：确认前证书仍 ACTIVE，设备可调用本端点（通用 AUTH-03 校验对 Retired 已 403）
    let auth03Rejected: unknown = null;
    try {
      await verifyDeviceCertificate(prisma, { clientCertPem: pem }, { now: NOW });
    } catch (err) {
      auth03Rejected = err;
    }
    assert.ok(auth03Rejected, 'AUTH-03 通用校验对 Retired 拒绝（本端点专用校验例外）');
    assert.match((auth03Rejected as Error).message, /retired/i);

    const res = await handler()({ identity: { clientCertPem: pem }, requestId: 'req-d1' });
    assert.equal(res.status, 200);
    const data = (res.body as DataBody).data as Record<string, any>;
    assert.equal(data.deviceId, deviceId);
    assert.equal(data.lifecycleStatus, 'Retired');
    assert.equal(data.replayed, false);
    assert.equal(data.retirement.status, 'CONFIRMED');
    assert.equal(data.retirement.completionMethod, 'DEVICE_CONFIRM');
    assert.equal(data.retirement.reason, '设备报废');
    assert.equal(data.certificates.length, 1);
    assert.equal(data.certificates[0].certificateId, certificateId);
    assert.equal(data.certificates[0].status, 'REVOKED');
    assert.equal(data.certificates[0].revokedAt, NOW.toISOString());

    // 持久化：退役记录与证书
    const retirement = await prisma.deviceRetirement.findUniqueOrThrow({ where: { deviceId } });
    assert.equal(retirement.status, 'CONFIRMED');
    assert.equal(retirement.completionMethod, 'DEVICE_CONFIRM');
    assert.equal(retirement.certificateRevokedAt?.toISOString(), NOW.toISOString());
    const cert = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: certificateId } });
    assert.equal(cert.status, 'REVOKED');
    assert.equal(cert.revokedAt?.toISOString(), NOW.toISOString());

    // 审计：DEVICE actor + 仅摘要，不泄露证书材料
    const audits = await prisma.auditLog.findMany({
      where: { objectId: deviceId, action: 'device.deactivate.confirm' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.actorRole, 'DEVICE');
    assert.equal(audits[0]?.actorId, deviceId);
    const after = audits[0]?.afterValue as { revokedCertificates: { certificateId: string; fingerprint: string }[] };
    assert.equal(after.revokedCertificates[0]?.certificateId, certificateId);
    const rawAudit = JSON.stringify(audits);
    assert.ok(!/BEGIN CERTIFICATE|deact-secret-package/.test(rawAudit), '审计不得包含证书材料');
    const rawRes = JSON.stringify(res.body);
    assert.ok(!/BEGIN CERTIFICATE|deact-secret-package/.test(rawRes), '响应不得包含证书材料');
  });

  test('Active/Suspended 直接调用被拒绝；Retired 无退役记录 → 409 CONFLICT', async () => {
    const active = await plantDevice('Active', true);
    const resActive = await handler()({ identity: { clientCertPem: active.pem }, requestId: 'req-d2' });
    assert.equal(resActive.status, 409);
    assert.equal((resActive.body as ErrorBody).error.code, 'DEVICE_STATE_NOT_ALLOWED');

    const suspended = await plantDevice('Suspended', true);
    const resSuspended = await handler()({ identity: { clientCertPem: suspended.pem }, requestId: 'req-d3' });
    assert.equal(resSuspended.status, 409);
    assert.equal((resSuspended.body as ErrorBody).error.code, 'DEVICE_STATE_NOT_ALLOWED');

    const noRecord = await plantDevice('Retired', false);
    const resNoRecord = await handler()({ identity: { clientCertPem: noRecord.pem }, requestId: 'req-d4' });
    assert.equal(resNoRecord.status, 409);
    assert.equal((resNoRecord.body as ErrorBody).error.code, 'CONFLICT', 'Retired 但无待退役记录');

    // 拒绝路径无副作用
    const cert = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: active.certificateId } });
    assert.equal(cert.status, 'ACTIVE', '拒绝后证书不受影响');
  });

  test('重复调用结果一致：确认后（证书已撤销）重复请求幂等重放，无新写入/审计', async () => {
    const { deviceId, pem } = await plantDevice('Retired', true);
    const first = await handler()({ identity: { clientCertPem: pem }, requestId: 'req-d5' });
    assert.equal(first.status, 200);

    // 证书已撤销：通用校验 401，但本端点判定为重复确认 → 幂等重放
    const replay = await handler()({ identity: { clientCertPem: pem }, requestId: 'req-d6' });
    assert.equal(replay.status, 200, '重复确认结果一致（幂等）');
    const firstData = (first.body as DataBody).data as Record<string, any>;
    const replayData = (replay.body as DataBody).data as Record<string, any>;
    assert.equal(replayData.replayed, true);
    assert.equal(replayData.retirement.retirementId, firstData.retirement.retirementId);
    assert.equal(replayData.retirement.confirmedAt, firstData.retirement.confirmedAt);
    assert.deepEqual(replayData.certificates, firstData.certificates, '证书视图一致');

    assert.equal(
      await prisma.auditLog.count({ where: { objectId: deviceId, action: 'device.deactivate.confirm' } }),
      1,
      '重放不产生新审计',
    );
    const certs = await prisma.deviceCertificate.findMany({ where: { deviceId } });
    assert.equal(certs.filter((c) => c.status === 'REVOKED').length, 1, '无重复撤销副作用');
  });

  test('未登记/无关已撤销证书 → 401；缺失身份 → 401', async () => {
    const unknownPem = fixturePem('unknown');
    const resUnknown = await handler()({ identity: { clientCertPem: unknownPem }, requestId: 'req-d7' });
    assert.equal(resUnknown.status, 401);

    // 已撤销证书但无已完成退役（非本服务撤销）→ 401
    const revoked = await plantDevice('Active', false);
    await prisma.deviceCertificate.update({
      where: { id: revoked.certificateId },
      data: { status: 'REVOKED', revokedAt: NOW },
    });
    const resRevoked = await handler()({ identity: { clientCertPem: revoked.pem }, requestId: 'req-d8' });
    assert.equal(resRevoked.status, 401);

    const resMissing = await handler()({ requestId: 'req-d9' });
    assert.equal(resMissing.status, 401);
  });

  test.each([null, {}, { confirm: true }, 'unexpected'])('任意请求体均失败关闭为 400：%j', async (body) => {
    const { pem, certificateId } = await plantDevice('Retired', true);
    const res = await handler()({ identity: { clientCertPem: pem }, body, requestId: 'req-body-rejected' });
    assert.equal(res.status, 400);
    assert.equal((res.body as ErrorBody).error.code, 'VALIDATION_FAILED');
    assert.equal((await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: certificateId } })).status, 'ACTIVE');
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('DeviceDeactivateError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(DEACTIVATE_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('响应字段与 OpenAPI DeactivationResult 契约一致（含嵌套 retirement）', async () => {
    const { pem } = await plantDevice('Retired', true);
    const res = await handler()({ identity: { clientCertPem: pem }, requestId: 'req-d10' });
    assert.equal(res.status, 200);
    assertOpenApiResponse('confirmDeactivation', res.status, res.body);
  });

  test('deactivate 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/device/', import.meta.url));
    for (const file of ['deactivate.ts', 'deactivate-handler.ts']) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});

const checkedCreateDeviceDeactivateHandler: typeof createDeviceDeactivateHandler = (deps) =>
  contractHandler('confirmDeactivation', createDeviceDeactivateHandler(deps));
