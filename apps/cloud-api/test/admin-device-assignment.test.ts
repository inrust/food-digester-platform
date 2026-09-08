/**
 * BE-DEV-02 Device Assignment API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 跨 Customer Site 被拒绝（400 VALIDATION_FAILED）；Customer/Site/设备不存在 → 404；
 * - 合法分配：首次分配 Onboarded→Assigned（DOM-01 迁移 + 状态历史），更新 Assignment 历史
 *   （授权窗口闭合/开启），恰好生成一次 ASSIGNMENT_CHANGED 通知（Outbox）；
 * - 重复请求幂等（目标一致 → replayed，无新写入/通知）；
 * - 非法生命周期（PendingOnboarding/Active 等）→ 409 DEVICE_STATE_NOT_ALLOWED；
 * - 角色边界：Operator 首次分配被 DOM-01 拒绝（403），再分配允许；Auditor/Customer 角色 403。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { ADMIN_ASSIGNMENT_ERROR_HTTP_STATUS, createAdminDeviceAssignmentHandlers } from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-28T15:00:00Z');

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

function customerActor(customerId: string): ActorContext {
  return { ...superAdmin, actorId: 'ca-1', actorType: 'customer', roles: ['CustomerAdmin'], customerId };
}

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function handlers() {
  return createAdminDeviceAssignmentHandlers({ client: prisma, now: () => NOW });
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

let seq = 0;
async function plantCustomer() {
  seq += 1;
  return prisma.customer.create({ data: { name: `Customer ASG ${seq}` } });
}

async function plantSite(customerId: string) {
  seq += 1;
  return prisma.site.create({ data: { customerId, name: `Site ASG ${seq}` } });
}

async function plantDevice(lifecycleStatus = 'Onboarded', customerId?: string, siteId?: string) {
  seq += 1;
  return prisma.device.create({
    data: {
      id: `dev-asg-${seq}`,
      serialNumber: `SN-ASG-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus,
      customerId: customerId ?? null,
      siteId: siteId ?? null,
    },
  });
}

type DataBody = { data: Record<string, unknown>; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

async function assignmentOutboxCount(deviceId: string): Promise<number> {
  return prisma.outboxEvent.count({
    where: { aggregateId: deviceId, eventType: 'ASSIGNMENT_CHANGED' },
  });
}

describe('POST /admin/devices/{deviceId}/assignment（首次分配）', () => {
  test('Onboarded → Assigned：归属更新 + 状态历史 + 授权窗口 + 恰好一次通知 + 审计', async () => {
    const customer = await plantCustomer();
    const site = await plantSite(customer.id);
    const device = await plantDevice('Onboarded');

    const res = await handlers().assign(
      req(superAdmin, {
        params: { deviceId: device.id },
        body: { customerId: customer.id, siteId: site.id, reason: '首次交付' },
      }),
    );
    assert.equal(res.status, 200);
    assertOpenApiResponse('assignDevice', res.status, res.body);
    const data = (res.body as DataBody).data;
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.lifecycleStatus, 'Assigned');
    assert.equal(data.notification, 'ASSIGNMENT_CHANGED');
    assert.equal(data.replayed, false);
    assert.equal(data.assignedBy, 'admin-1');
    assert.equal(data.reason, '首次交付');

    const row = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    assert.equal(row.lifecycleStatus, 'Assigned', '首次分配迁移到 Assigned');
    assert.equal(row.customerId, customer.id);
    assert.equal(row.siteId, site.id);

    const history = await prisma.deviceStateHistory.findMany({ where: { deviceId: device.id } });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.axis, 'lifecycle');
    assert.equal(history[0]?.fromStatus, 'Onboarded');
    assert.equal(history[0]?.toStatus, 'Assigned');

    assert.equal(await assignmentOutboxCount(device.id), 1, '恰好生成一次通知');
    const event = await prisma.outboxEvent.findFirst({
      where: { aggregateId: device.id, eventType: 'ASSIGNMENT_CHANGED' },
    });
    const payload = event?.payload as { topic: string; data: { type: string; action: string } };
    assert.equal(payload.topic, `bnx/device/${device.id}/notification`);
    assert.deepEqual(payload.data, { type: 'ASSIGNMENT_CHANGED', action: 'SYNC' });

    const audits = await prisma.auditLog.findMany({
      where: { objectId: device.id, action: 'device.assignment.assign' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.customerId, customer.id);
  });

  test('重复请求幂等：同目标重放（replayed=true），无新分配行/通知/审计', async () => {
    const customer = await plantCustomer();
    const site = await plantSite(customer.id);
    const device = await plantDevice('Onboarded');
    const h = handlers();
    const body = { customerId: customer.id, siteId: site.id };

    await h.assign(req(superAdmin, { params: { deviceId: device.id }, body }));
    const before = await prisma.deviceAssignment.count({ where: { deviceId: device.id } });

    const replay = await h.assign(req(superAdmin, { params: { deviceId: device.id }, body }));
    assert.equal(replay.status, 200);
    const data = (replay.body as DataBody).data;
    assert.equal(data.replayed, true);
    assert.equal(data.notification, null, '重放不重复通知');
    assert.equal(await prisma.deviceAssignment.count({ where: { deviceId: device.id } }), before, '无新分配行');
    assert.equal(await assignmentOutboxCount(device.id), 1, '无新通知');
    assert.equal(
      await prisma.auditLog.count({ where: { objectId: device.id, action: 'device.assignment.assign' } }),
      1,
      '重放不产生新审计',
    );
  });

  test('跨 Customer Site 被拒绝（400）；Customer/Site/设备不存在 → 404；非法生命周期 → 409', async () => {
    const a = await plantCustomer();
    const b = await plantCustomer();
    const siteB = await plantSite(b.id);
    const siteA = await plantSite(a.id);
    const device = await plantDevice('Onboarded');
    const h = handlers();

    const cross = await h.assign(
      req(superAdmin, { params: { deviceId: device.id }, body: { customerId: a.id, siteId: siteB.id } }),
    );
    assert.equal(cross.status, 400, '跨 Customer Site 被拒绝');
    assert.equal((cross.body as ErrorBody).error.code, 'VALIDATION_FAILED');

    const noCustomer = await h.assign(
      req(superAdmin, { params: { deviceId: device.id }, body: { customerId: 'cust-x', siteId: siteA.id } }),
    );
    assert.equal(noCustomer.status, 404);
    const noSite = await h.assign(
      req(superAdmin, { params: { deviceId: device.id }, body: { customerId: a.id, siteId: 'site-x' } }),
    );
    assert.equal(noSite.status, 404);
    const noDevice = await h.assign(
      req(superAdmin, { params: { deviceId: 'dev-x' }, body: { customerId: a.id, siteId: siteA.id } }),
    );
    assert.equal(noDevice.status, 404);

    for (const lifecycle of ['PendingOnboarding', 'Licensed', 'Active', 'Suspended', 'Retired']) {
      const d = await plantDevice(lifecycle);
      const res = await h.assign(
        req(superAdmin, { params: { deviceId: d.id }, body: { customerId: a.id, siteId: siteA.id } }),
      );
      assert.equal(res.status, 409, `lifecycle=${lifecycle} 不允许分配`);
      assert.equal((res.body as ErrorBody).error.code, 'DEVICE_STATE_NOT_ALLOWED');
    }

    for (const body of [{ customerId: a.id }, { siteId: siteA.id }, {}]) {
      const res = await h.assign(req(superAdmin, { params: { deviceId: device.id }, body }));
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 必须 400`);
    }
  });
});

describe('POST /admin/devices/{deviceId}/assignment（调整分配与角色边界）', () => {
  test('Assigned 再分配：授权窗口闭合/开启 + 归属更新 + 恰好一次通知；历史可查', async () => {
    const a = await plantCustomer();
    const siteA1 = await plantSite(a.id);
    const siteA2 = await plantSite(a.id);
    const device = await plantDevice('Onboarded');
    const h = handlers();

    await h.assign(req(superAdmin, { params: { deviceId: device.id }, body: { customerId: a.id, siteId: siteA1.id } }));
    const adjust = await h.assign(
      req(operator, {
        params: { deviceId: device.id },
        body: { customerId: a.id, siteId: siteA2.id, reason: '调整站点' },
      }),
    );
    assert.equal(adjust.status, 200, 'Operator 可执行 Assigned 再分配（无生命周期迁移）');
    const data = (adjust.body as DataBody).data;
    assert.equal(data.lifecycleStatus, 'Assigned', '再分配不改变生命周期');
    assert.equal(data.notification, 'ASSIGNMENT_CHANGED');

    const rows = await prisma.deviceAssignment.findMany({
      where: { deviceId: device.id },
      orderBy: { assignedAt: 'asc' },
    });
    assert.equal(rows.length, 2, '两条授权窗口记录');
    assert.equal(rows[0]?.status, 'ENDED');
    assert.ok(rows[0]?.endedAt !== null, '旧窗口已闭合（endedAt）');
    assert.equal(rows[1]?.status, 'ACTIVE');
    assert.equal(rows[1]?.siteId, siteA2.id);
    assert.equal(rows[1]?.endedAt, null);
    assert.equal(await assignmentOutboxCount(device.id), 2, '每次真实变更恰好一次通知');

    const deviceRow = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    assert.equal(deviceRow.siteId, siteA2.id);
    assert.equal(deviceRow.lifecycleStatus, 'Assigned');

    // 历史接口：两条记录按 assignedAt 倒序
    const history = await h.history(req(auditor, { params: { deviceId: device.id } }));
    assert.equal(history.status, 200);
    const items = (history.body as { data: Array<{ status: string; siteId: string }> }).data;
    assert.equal(items.length, 2);
    assert.equal(items[0]?.status, 'ACTIVE');
    assert.equal(items[1]?.status, 'ENDED');
  });

  test('角色边界：Operator 首次分配被 DOM-01 拒绝（403）；Auditor/Customer 角色/未认证 403/401', async () => {
    const a = await plantCustomer();
    const siteA = await plantSite(a.id);
    const h = handlers();

    const byOperator = await plantDevice('Onboarded');
    const forbidden = await h.assign(
      req(operator, { params: { deviceId: byOperator.id }, body: { customerId: a.id, siteId: siteA.id } }),
    );
    assert.equal(forbidden.status, 403, 'DOM-01：首次分配仅 PlatformSuperAdmin');
    assert.equal((forbidden.body as ErrorBody).error.code, 'FORBIDDEN');
    const unchanged = await prisma.device.findUniqueOrThrow({ where: { id: byOperator.id } });
    assert.equal(unchanged.lifecycleStatus, 'Onboarded', '拒绝后状态未变');

    const byAuditor = await plantDevice('Onboarded');
    assert.equal(
      (
        await h.assign(
          req(auditor, { params: { deviceId: byAuditor.id }, body: { customerId: a.id, siteId: siteA.id } }),
        )
      ).status,
      403,
      'Auditor 无 device:assign',
    );
    assert.equal(
      (
        await h.assign(
          req(customerActor(a.id), {
            params: { deviceId: byAuditor.id },
            body: { customerId: a.id, siteId: siteA.id },
          }),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await h.assign(
          req(undefined, { params: { deviceId: byAuditor.id }, body: { customerId: a.id, siteId: siteA.id } }),
        )
      ).status,
      401,
    );
  });

  test('历史接口：Customer 角色仅本 Customer 设备；设备不存在 404', async () => {
    const a = await plantCustomer();
    const b = await plantCustomer();
    const siteA = await plantSite(a.id);
    const siteB = await plantSite(b.id);
    const devA = await plantDevice('Assigned', a.id, siteA.id);
    const devB = await plantDevice('Assigned', b.id, siteB.id);
    const h = handlers();

    const ownHistory = await h.history(req(customerActor(a.id), { params: { deviceId: devA.id } }));
    assert.equal(ownHistory.status, 200);
    assertOpenApiResponse('listDeviceAssignments', ownHistory.status, ownHistory.body);
    assert.equal((await h.history(req(customerActor(a.id), { params: { deviceId: devB.id } }))).status, 403);
    assert.equal((await h.history(req(operator, { params: { deviceId: 'dev-x' } }))).status, 404);
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('AdminAssignmentError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_ASSIGNMENT_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('分配响应字段与 OpenAPI DeviceAssignment 契约一致', async () => {
    const api = loadJson('admin-device-assignment-api.json');
    const required = [...api.components.schemas.DeviceAssignment.required].sort();
    const customer = await plantCustomer();
    const site = await plantSite(customer.id);
    const device = await plantDevice('Onboarded');
    const res = await handlers().assign(
      req(superAdmin, { params: { deviceId: device.id }, body: { customerId: customer.id, siteId: site.id } }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys((res.body as DataBody).data).sort(), required);
  });

  test('admin/device-assignment 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/device-assignment/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
