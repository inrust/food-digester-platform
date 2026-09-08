/**
 * BE-DEV-03 Device Suspend/Reactivate API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 非法状态转换失败（非 Active 挂起 / 非 Suspended 恢复 → 409 DEVICE_STATE_NOT_ALLOWED）；
 * - 原因和审批写审计（suspend reason；reactivate reason + issueResolved + approvedBy）；
 * - 重复请求不重复通知（幂等重放 replayed=true，Outbox/状态历史/审计数量不变）；
 * - 通知类型正确（挂起 DEVICE_SUSPENDED、恢复 STATUS_CHANGED，Outbox 下行 SYNC）；
 * - 不执行设备端模式切换（仅 notification 事件，无 cmd 下发）；
 * - 角色边界（device:write 持有者 SuperAdmin/Operator；Auditor/Customer 403）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { ADMIN_DEVICE_STATUS_ERROR_HTTP_STATUS, createAdminDeviceStatusHandlers } from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-28T16:00:00Z');

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
const customerAdmin: ActorContext = {
  ...superAdmin,
  actorId: 'ca-1',
  actorType: 'customer',
  roles: ['CustomerAdmin'],
  customerId: 'cust-x',
};

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function handlers() {
  return createAdminDeviceStatusHandlers({ client: prisma, now: () => NOW });
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
async function plantDevice(lifecycleStatus = 'Active', operationalStatus?: string) {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `Customer DS ${seq}` } });
  const id = `dev-ds-${seq}`;
  const device = await prisma.device.create({
    data: {
      id,
      serialNumber: `SN-DS-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus,
      customerId: customer.id,
    },
  });
  if (operationalStatus !== undefined) {
    await prisma.deviceLatestState.create({
      data: { deviceId: id, customerId: customer.id, operationalStatus },
    });
  }
  return device;
}

type DataBody = { data: Record<string, unknown>; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

function outboxOf(deviceId: string, eventType: string) {
  return prisma.outboxEvent.findMany({ where: { aggregateId: deviceId, eventType } });
}

describe('POST /admin/devices/{deviceId}/suspend（挂起）', () => {
  test('Active→Suspended：状态历史（含 operational 镜像）+ DEVICE_SUSPENDED 通知 + 原因入审计', async () => {
    const device = await plantDevice('Active', 'Active');
    const res = await handlers().suspend(
      req(operator, { params: { deviceId: device.id }, body: { reason: '欠费停机' } }),
    );
    assert.equal(res.status, 200);
    assertOpenApiResponse('suspendDevice', res.status, res.body);
    const data = (res.body as DataBody).data;
    assert.equal(data.lifecycleStatus, 'Suspended');
    assert.equal(data.operationalStatus, 'Suspended', 'operational 镜像');
    assert.equal(data.notification, 'DEVICE_SUSPENDED');
    assert.equal(data.replayed, false);

    const row = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    assert.equal(row.lifecycleStatus, 'Suspended');

    const history = await prisma.deviceStateHistory.findMany({
      where: { deviceId: device.id },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(history.length, 2, 'lifecycle + operational 镜像两条状态历史');
    assert.deepEqual(
      history.map((entry) => entry.axis),
      ['lifecycle', 'operational'],
      '双轴必须持久化，不能再依赖同名状态推断',
    );
    assert.equal(history[0]?.toStatus, 'Suspended');
    assert.equal(history[0]?.reason, '欠费停机');
    assert.equal(history[1]?.toStatus, 'Suspended');

    const events = await outboxOf(device.id, 'DEVICE_SUSPENDED');
    assert.equal(events.length, 1, '恰好一次 DEVICE_SUSPENDED');
    const payload = events[0]?.payload as { topic: string; data: { type: string; action: string } };
    assert.equal(payload.topic, `bnx/device/${device.id}/notification`);
    assert.deepEqual(payload.data, { type: 'DEVICE_SUSPENDED', action: 'SYNC' });

    const audits = await prisma.auditLog.findMany({
      where: { objectId: device.id, action: 'device.suspend' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.reason, '欠费停机');
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.actorId, 'op-1');

    // 不执行设备端模式切换：不产生任何 cmd 下发
    const cmds = await prisma.outboxEvent.count({
      where: { aggregateId: device.id, eventType: { not: 'DEVICE_SUSPENDED' } },
    });
    assert.equal(cmds, 0, '仅通知事件，无命令/模式切换');
  });

  test('重复挂起幂等：replayed=true，不重复通知/历史/审计', async () => {
    const device = await plantDevice('Active');
    const h = handlers();
    await h.suspend(req(operator, { params: { deviceId: device.id }, body: { reason: 'r1' } }));
    const historyBefore = await prisma.deviceStateHistory.count({ where: { deviceId: device.id } });

    const replay = await h.suspend(req(operator, { params: { deviceId: device.id }, body: { reason: 'r1' } }));
    assert.equal(replay.status, 200);
    const data = (replay.body as DataBody).data;
    assert.equal(data.replayed, true);
    assert.equal(data.notification, null);
    assert.equal((await outboxOf(device.id, 'DEVICE_SUSPENDED')).length, 1, '不重复通知');
    assert.equal(
      await prisma.deviceStateHistory.count({ where: { deviceId: device.id } }),
      historyBefore,
      '不重复历史',
    );
    assert.equal(
      await prisma.auditLog.count({ where: { objectId: device.id, action: 'device.suspend' } }),
      1,
      '不重复审计',
    );
  });

  test('非法状态转换失败；缺原因 400；不存在 404；越权 403/401', async () => {
    const h = handlers();
    for (const lifecycle of ['PendingOnboarding', 'Onboarded', 'Assigned', 'Licensed', 'Retired']) {
      const d = await plantDevice(lifecycle);
      const res = await h.suspend(req(operator, { params: { deviceId: d.id }, body: { reason: 'r' } }));
      assert.equal(res.status, 409, `lifecycle=${lifecycle} 挂起必须失败`);
      assert.equal((res.body as ErrorBody).error.code, 'DEVICE_STATE_NOT_ALLOWED');
    }

    const active = await plantDevice('Active');
    assert.equal((await h.suspend(req(operator, { params: { deviceId: active.id }, body: {} }))).status, 400);
    assert.equal(
      (await h.suspend(req(operator, { params: { deviceId: active.id }, body: { reason: '  ' } }))).status,
      400,
    );
    assert.equal(
      (await h.suspend(req(operator, { params: { deviceId: 'dev-x' }, body: { reason: 'r' } }))).status,
      404,
    );
    assert.equal(
      (await h.suspend(req(auditor, { params: { deviceId: active.id }, body: { reason: 'r' } }))).status,
      403,
    );
    assert.equal(
      (await h.suspend(req(customerAdmin, { params: { deviceId: active.id }, body: { reason: 'r' } }))).status,
      403,
      'Customer 角色无 device:write',
    );
    assert.equal(
      (await h.suspend(req(undefined, { params: { deviceId: active.id }, body: { reason: 'r' } }))).status,
      401,
    );
  });
});

describe('POST /admin/devices/{deviceId}/reactivate（恢复）', () => {
  test('Suspended→Active：STATUS_CHANGED 通知 + 原因/审批（issueResolved + approvedBy）写审计', async () => {
    const device = await plantDevice('Suspended', 'Suspended');
    const res = await handlers().reactivate(
      req(superAdmin, { params: { deviceId: device.id }, body: { reason: '欠费已补缴', issueResolved: true } }),
    );
    assert.equal(res.status, 200);
    assertOpenApiResponse('reactivateDevice', res.status, res.body);
    const data = (res.body as DataBody).data;
    assert.equal(data.lifecycleStatus, 'Active');
    assert.equal(data.notification, 'STATUS_CHANGED');
    assert.equal(data.replayed, false);

    const events = await outboxOf(device.id, 'STATUS_CHANGED');
    assert.equal(events.length, 1, '恰好一次 STATUS_CHANGED');

    const audits = await prisma.auditLog.findMany({
      where: { objectId: device.id, action: 'device.reactivate' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.reason, '欠费已补缴');
    const after = audits[0]?.afterValue as Record<string, unknown>;
    assert.equal(after.issueResolved, true, '问题已解决标志入审计');
    assert.equal(after.approvedBy, 'admin-1', '管理员批准（批准人）入审计');
  });

  test('issueResolved 缺失/false → 400；非 Suspended → 409；重复恢复幂等不重复通知', async () => {
    const h = handlers();
    const suspended = await plantDevice('Suspended');
    for (const body of [{ reason: 'r' }, { reason: 'r', issueResolved: false }, { issueResolved: true }]) {
      const res = await h.reactivate(req(operator, { params: { deviceId: suspended.id }, body }));
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 必须 400`);
    }
    const active = await plantDevice('Active');
    const wrongState = await h.reactivate(
      req(operator, { params: { deviceId: active.id }, body: { reason: 'r', issueResolved: true } }),
    );
    assert.equal(wrongState.status, 200, '已在 Active 的恢复请求为幂等重放');
    assert.equal((wrongState.body as DataBody).data.replayed, true);
    assert.equal((wrongState.body as DataBody).data.notification, null);

    const onboarded = await plantDevice('Onboarded');
    const illegal = await h.reactivate(
      req(operator, { params: { deviceId: onboarded.id }, body: { reason: 'r', issueResolved: true } }),
    );
    assert.equal(illegal.status, 409);
    assert.equal((illegal.body as ErrorBody).error.code, 'DEVICE_STATE_NOT_ALLOWED');

    // 完整往返后再恢复一次（真实变更），随后重复请求幂等
    const roundTrip = await plantDevice('Active');
    await h.suspend(req(operator, { params: { deviceId: roundTrip.id }, body: { reason: 's' } }));
    await h.reactivate(
      req(operator, { params: { deviceId: roundTrip.id }, body: { reason: 'r', issueResolved: true } }),
    );
    const replay = await h.reactivate(
      req(operator, { params: { deviceId: roundTrip.id }, body: { reason: 'r', issueResolved: true } }),
    );
    assert.equal((replay.body as DataBody).data.replayed, true);
    assert.equal((await outboxOf(roundTrip.id, 'STATUS_CHANGED')).length, 1, '重复请求不重复通知');
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('AdminDeviceStatusError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_DEVICE_STATUS_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('响应字段与 OpenAPI DeviceStatus 契约一致', async () => {
    const api = loadJson('admin-device-status-api.json');
    const required = [...api.components.schemas.DeviceStatus.required].sort();
    const device = await plantDevice('Active');
    const res = await handlers().suspend(req(operator, { params: { deviceId: device.id }, body: { reason: 'r' } }));
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys((res.body as DataBody).data).sort(), required);
  });

  test('admin/device-status 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/device-status/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
