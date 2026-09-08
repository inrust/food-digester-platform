/**
 * BE-DEV-04 Device Retirement 工作流验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 顺序正确：retire 不撤销证书（设备可确认），设备 deactivate（BE-SYNC-02）后才断证；
 * - 仅 Active/Suspended→Retired（其余 409）；Retired 永久不可恢复（DOM-01 无出边）；
 * - 操作强制原因和确认（缺 reason/confirm → 400）；DOM-01 仅 SuperAdmin（Operator 403）；
 * - 撤销 Assignment/License/Entitlement + 待确认记录 + DEVICE_RETIRED 恰好一次；
 * - force-complete 领域接口（离线不等待确认）+ 审计；重复请求幂等；
 * - 退役后业务命令全部拒绝（suspend/assign 409、设备端 AUTH-03 403）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { certificateFingerprintFromPem, verifyDeviceCertificate } from '@fdp/auth';
import {
  ADMIN_RETIREMENT_ERROR_HTTP_STATUS,
  createAdminDeviceAssignmentHandlers,
  createAdminDeviceRetirementHandlers,
  createAdminDeviceStatusHandlers,
  createDeviceDeactivateHandler,
} from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-28T18:00:00Z');
const now = () => NOW;
const DAY_MS = 86_400_000;

const superAdmin: ActorContext = {
  actorId: 'admin-1',
  username: 'admin',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};
const operator: ActorContext = { ...superAdmin, actorId: 'op-1', roles: ['PlatformOperator'] };
const auditor: ActorContext = { ...superAdmin, actorId: 'au-1', roles: ['Auditor'] };

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function handlers() {
  return createAdminDeviceRetirementHandlers({ client: prisma, now, iot: { deactivateCertificate: async () => {} } });
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

function fixturePem(seed: string): string {
  const body = Buffer.from(`retire-cert-${seed}`, 'utf8').toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

let seq = 0;
/** 落库设备（含 customer/site/assignment ACTIVE/License Active+Entitlement/ACTIVE 证书/latestState）。 */
async function plantFullDevice(lifecycleStatus = 'Active') {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `Customer RET ${seq}` } });
  const site = await prisma.site.create({ data: { customerId: customer.id, name: `Site RET ${seq}` } });
  const deviceId = `dev-ret-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-RET-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus,
      customerId: customer.id,
      siteId: site.id,
    },
  });
  await prisma.deviceAssignment.create({
    data: { deviceId, customerId: customer.id, siteId: site.id, status: 'ACTIVE', assignedBy: 'admin-0' },
  });
  const license = await prisma.license.create({
    data: {
      deviceId,
      customerId: customer.id,
      status: 'Active',
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validTo: new Date('2027-01-01T00:00:00Z'),
      createdBy: 'test',
      entitlements: { create: [{ code: 'REMOTE_CONTROL', enabled: true }] },
    },
  });
  const pem = fixturePem(`${seq}`);
  const certificateId = `cert-ret-${seq}`;
  await prisma.deviceCertificate.create({
    data: {
      id: certificateId,
      deviceId,
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      notBefore: new Date(NOW.getTime() - 30 * DAY_MS),
      notAfter: new Date(NOW.getTime() + 200 * DAY_MS),
    },
  });
  await prisma.deviceLatestState.create({
    data: { deviceId, customerId: customer.id, operationalStatus: 'Active' },
  });
  return { deviceId, customerId: customer.id, siteId: site.id, licenseId: license.id, pem, certificateId };
}

async function plantBareDevice(lifecycleStatus: string) {
  seq += 1;
  const deviceId = `dev-ret-bare-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-RET-B${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus,
    },
  });
  return deviceId;
}

type DataBody = { data: Record<string, unknown>; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

describe('POST /admin/devices/{deviceId}/retire（管理员退役）', () => {
  test('Active→Retired：撤销 Assignment/License/Entitlement + 待确认记录 + DEVICE_RETIRED + 审计；证书保持 ACTIVE', async () => {
    const d = await plantFullDevice('Active');
    const res = await handlers().retire(
      req(superAdmin, { params: { deviceId: d.deviceId }, body: { reason: '设备报废', confirm: true } }),
    );
    assert.equal(res.status, 200);
    const data = (res.body as DataBody).data as Record<string, any>;
    assert.equal(data.lifecycleStatus, 'Retired');
    assert.equal(data.notification, 'DEVICE_RETIRED');
    assert.equal(data.replayed, false);
    assert.equal(data.retirement.status, 'PENDING_CONFIRMATION');
    assert.equal(data.retirement.reason, '设备报废');
    assert.equal(data.retirement.initiatedBy, 'admin-1');

    const device = await prisma.device.findUniqueOrThrow({ where: { id: d.deviceId } });
    assert.equal(device.lifecycleStatus, 'Retired');
    const assignment = await prisma.deviceAssignment.findFirstOrThrow({ where: { deviceId: d.deviceId } });
    assert.equal(assignment.status, 'ENDED', 'Assignment 撤销（授权窗口闭合）');
    assert.ok(assignment.endedAt !== null);
    const license = await prisma.license.findUniqueOrThrow({
      where: { id: d.licenseId },
      include: { entitlements: true },
    });
    assert.equal(license.status, 'Revoked', 'License 撤销');
    assert.equal(license.entitlements[0]?.enabled, false, 'Entitlement 停用');

    const history = await prisma.deviceStateHistory.findMany({ where: { deviceId: d.deviceId } });
    assert.equal(history.length, 2, 'lifecycle + operational 镜像');
    assert.ok(history.every((h) => h.toStatus === 'Retired' && h.reason === '设备报废'));

    const events = await prisma.outboxEvent.findMany({
      where: { aggregateId: d.deviceId, eventType: 'DEVICE_RETIRED' },
    });
    assert.equal(events.length, 1, '恰好一次 DEVICE_RETIRED');

    const audits = await prisma.auditLog.findMany({
      where: { objectId: d.deviceId, action: 'device.retire' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.reason, '设备报废');

    // 顺序约束：证书保持 ACTIVE（设备可确认 Deactivate）
    const cert = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: d.certificateId } });
    assert.equal(cert.status, 'ACTIVE', 'retire 不撤销证书');
  });

  test('顺序正确（跨模块）：retire 后设备 deactivate 确认成功 → 断证；退役后业务命令全部拒绝', async () => {
    const d = await plantFullDevice('Active');
    await handlers().retire(
      req(superAdmin, { params: { deviceId: d.deviceId }, body: { reason: 'r', confirm: true } }),
    );

    // 设备端通用接入在 Retired 后即被拒（AUTH-03）
    let auth03: unknown = null;
    try {
      await verifyDeviceCertificate(prisma, { clientCertPem: d.pem }, { now: NOW });
    } catch (err) {
      auth03 = err;
    }
    assert.ok(auth03 && /retired/i.test((auth03 as Error).message), '退役后设备端业务接入 403');

    // 管理端业务命令全部拒绝
    const status = createAdminDeviceStatusHandlers({ client: prisma, now });
    assert.equal(
      (await status.suspend(req(operator, { params: { deviceId: d.deviceId }, body: { reason: 'x' } }))).status,
      409,
      '退役后 suspend 拒绝',
    );
    const assignment = createAdminDeviceAssignmentHandlers({ client: prisma });
    assert.equal(
      (
        await assignment.assign(
          req(superAdmin, {
            params: { deviceId: d.deviceId },
            body: { customerId: d.customerId, siteId: d.siteId },
          }),
        )
      ).status,
      409,
      '退役后 assign 拒绝',
    );

    // 设备确认退役（BE-SYNC-02）：证书仍 ACTIVE，可完成确认 → 断证
    const deactivate = createDeviceDeactivateHandler({
      client: prisma,
      now,
      iot: { deactivateCertificate: async () => {} },
    });
    const confirm = await deactivate({ identity: { clientCertPem: d.pem }, requestId: 'req-ret-confirm' });
    assert.equal(confirm.status, 200, 'retire 后设备可确认（顺序正确：未先断证）');
    const cert = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: d.certificateId } });
    assert.equal(cert.status, 'REVOKED', '确认后才断证');
    const retirement = await prisma.deviceRetirement.findUniqueOrThrow({ where: { deviceId: d.deviceId } });
    assert.equal(retirement.status, 'CONFIRMED');
    assert.equal(retirement.completionMethod, 'DEVICE_CONFIRM');

    // retire 重复请求幂等（记录已 CONFIRMED）
    const replay = await handlers().retire(
      req(superAdmin, { params: { deviceId: d.deviceId }, body: { reason: 'r', confirm: true } }),
    );
    assert.equal(replay.status, 200);
    assert.equal((replay.body as DataBody).data.replayed, true);
    assert.equal(
      await prisma.outboxEvent.count({ where: { aggregateId: d.deviceId, eventType: 'DEVICE_RETIRED' } }),
      1,
      '不重复通知',
    );
  });

  test('Suspended→Retired 允许；非法生命周期 409；缺原因/确认 400；Operator/Auditor/未认证 403/401', async () => {
    const h = handlers();
    const suspended = await plantFullDevice('Suspended');
    assert.equal(
      (
        await h.retire(
          req(superAdmin, { params: { deviceId: suspended.deviceId }, body: { reason: 'r', confirm: true } }),
        )
      ).status,
      200,
      'Suspended 可退役',
    );

    for (const lifecycle of ['PendingOnboarding', 'Onboarded', 'Assigned', 'Licensed']) {
      const id = await plantBareDevice(lifecycle);
      const res = await h.retire(req(superAdmin, { params: { deviceId: id }, body: { reason: 'r', confirm: true } }));
      assert.equal(res.status, 409, `lifecycle=${lifecycle} 退役必须失败`);
      assert.equal((res.body as ErrorBody).error.code, 'DEVICE_STATE_NOT_ALLOWED');
    }

    // Retired 但无退役记录（数据不一致）→ 409 CONFLICT
    const orphan = await plantBareDevice('Retired');
    const resOrphan = await h.retire(
      req(superAdmin, { params: { deviceId: orphan }, body: { reason: 'r', confirm: true } }),
    );
    assert.equal(resOrphan.status, 409);
    assert.equal((resOrphan.body as ErrorBody).error.code, 'CONFLICT');

    const target = await plantBareDevice('Active');
    for (const body of [{ confirm: true }, { reason: 'r' }, { reason: 'r', confirm: false }, {}]) {
      const res = await h.retire(req(superAdmin, { params: { deviceId: target }, body }));
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 必须 400`);
    }
    assert.equal(
      (await h.retire(req(operator, { params: { deviceId: target }, body: { reason: 'r', confirm: true } }))).status,
      403,
      'DOM-01：退役仅 PlatformSuperAdmin',
    );
    assert.equal(
      (await h.retire(req(auditor, { params: { deviceId: target }, body: { reason: 'r', confirm: true } }))).status,
      403,
    );
    assert.equal(
      (await h.retire(req(undefined, { params: { deviceId: target }, body: { reason: 'r', confirm: true } }))).status,
      401,
    );
    assert.equal(
      (await h.retire(req(superAdmin, { params: { deviceId: 'dev-x' }, body: { reason: 'r', confirm: true } }))).status,
      404,
    );
  });
});

describe('POST /admin/devices/{deviceId}/retire/complete（force-complete）', () => {
  test('离线设备强制完成：CONFIRMED + FORCE_COMPLETE + 证书停用 + 审计；重复幂等；非法上下文拒绝', async () => {
    const d = await plantFullDevice('Active');
    const h = handlers();

    // 未退役 → 409 DEVICE_STATE_NOT_ALLOWED
    const early = await h.forceComplete(req(operator, { params: { deviceId: d.deviceId }, body: { reason: 'x' } }));
    assert.equal(early.status, 409);
    assert.equal((early.body as ErrorBody).error.code, 'DEVICE_STATE_NOT_ALLOWED');

    await h.retire(req(superAdmin, { params: { deviceId: d.deviceId }, body: { reason: 'r', confirm: true } }));
    // 缺原因 → 400
    assert.equal((await h.forceComplete(req(operator, { params: { deviceId: d.deviceId }, body: {} }))).status, 400);

    const done = await h.forceComplete(
      req(operator, { params: { deviceId: d.deviceId }, body: { reason: '设备长期离线，强制完成' } }),
    );
    assert.equal(done.status, 200);
    const data = (done.body as DataBody).data as Record<string, any>;
    assert.equal(data.retirement.status, 'CONFIRMED');
    assert.equal(data.retirement.completionMethod, 'FORCE_COMPLETE');
    assert.equal(data.notification, null, 'force-complete 不重复通知');
    assert.equal(data.replayed, false);

    const cert = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: d.certificateId } });
    assert.equal(cert.status, 'REVOKED', 'force-complete 完成证书停用');
    const audits = await prisma.auditLog.findMany({
      where: { objectId: d.deviceId, action: 'device.retire.force_complete' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.reason, '设备长期离线，强制完成');
    assert.equal(audits[0]?.result, 'SUCCESS');

    // 重复调用幂等
    const replay = await h.forceComplete(
      req(operator, { params: { deviceId: d.deviceId }, body: { reason: '设备长期离线，强制完成' } }),
    );
    assert.equal(replay.status, 200);
    assert.equal((replay.body as DataBody).data.replayed, true);
    assert.equal(
      await prisma.auditLog.count({ where: { objectId: d.deviceId, action: 'device.retire.force_complete' } }),
      1,
      '重放不产生新审计',
    );

    // force-complete 后设备重复 deactivate → 幂等重放（证书撤销时间一致）
    const deactivate = createDeviceDeactivateHandler({
      client: prisma,
      now,
      iot: { deactivateCertificate: async () => {} },
    });
    const devReplay = await deactivate({ identity: { clientCertPem: d.pem }, requestId: 'req-ret-fc' });
    assert.equal(devReplay.status, 200);

    // Retired 无记录 → 409 CONFLICT；不存在 → 404
    const orphan = await plantBareDevice('Retired');
    const resOrphan = await h.forceComplete(req(operator, { params: { deviceId: orphan }, body: { reason: 'x' } }));
    assert.equal(resOrphan.status, 409);
    assert.equal((resOrphan.body as ErrorBody).error.code, 'CONFLICT');
    assert.equal(
      (await h.forceComplete(req(operator, { params: { deviceId: 'dev-x' }, body: { reason: 'x' } }))).status,
      404,
    );
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('AdminRetirementError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_RETIREMENT_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('响应字段与 OpenAPI RetirementResult 契约一致（含嵌套 retirement）', async () => {
    const api = loadJson('admin-device-retirement-api.json');
    const topRequired = [...api.components.schemas.RetirementResult.required].sort();
    const recordRequired = [...api.components.schemas.RetirementRecord.required].sort();
    const d = await plantFullDevice('Active');
    const res = await handlers().retire(
      req(superAdmin, { params: { deviceId: d.deviceId }, body: { reason: 'r', confirm: true } }),
    );
    assert.equal(res.status, 200);
    const data = (res.body as DataBody).data as Record<string, any>;
    assert.deepEqual(Object.keys(data).sort(), topRequired);
    assert.deepEqual(Object.keys(data.retirement).sort(), recordRequired);
  });

  test('admin/device-retirement 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/device-retirement/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
