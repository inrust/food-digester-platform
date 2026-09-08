/**
 * BE-ALM-01 Alarm/Event/Tamper 查询与处理 API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 筛选（severity/status/device/site/时间范围）和游标分页正确；
 * - 确认/清除记录操作者、原因和时间（落库 + 审计）；
 * - 重复确认/重复清除幂等（replayed，无新写入/审计/领域事件）；CLEARED 终态确认 → 409；
 * - 跨 Customer 查询失败（列表租户隔离 / 详情与处理 404）；
 * - 领域通知只在状态变化时产生：CRITICAL 真实迁移恰好一个 ALARM_STATE_CHANGED Outbox 事件，
 *   非 CRITICAL 迁移与幂等重放均不产生；
 * - Event/Tamper 只读查询（含 severity/eventType 筛选与租户隔离）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { ADMIN_ALARM_ERROR_HTTP_STATUS, createAdminAlarmHandlers } from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-30T10:00:00Z');
const now = () => NOW;
const HOUR_MS = 3_600_000;

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
  return createAdminAlarmHandlers({ client: prisma, now });
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

type DataBody = { data: Record<string, any>; meta: Record<string, any> };
type ListBody = { data: Record<string, any>[]; meta: Record<string, any> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

let seq = 0;

async function plantTenant(name: string) {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `${name} ${seq}` } });
  const site = await prisma.site.create({
    data: { customerId: customer.id, name: `Site ${name} ${seq}`, region: 'CN-East', subregion: 'Shanghai' },
  });
  const deviceId = `dev-alm-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-ALM-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId: customer.id,
      siteId: site.id,
    },
  });
  const customerAdmin: ActorContext = {
    actorId: `ca-${seq}`,
    username: `ca-${seq}`,
    actorType: 'customer',
    roles: ['CustomerAdmin'],
    customerId: customer.id,
    tokenUse: 'access',
  };
  const customerViewer: ActorContext = { ...customerAdmin, actorId: `cv-${seq}`, roles: ['CustomerViewer'] };
  return { customerId: customer.id, siteId: site.id, deviceId, customerAdmin, customerViewer };
}

interface PlantAlarmOptions {
  severity?: string;
  status?: string;
  code?: string;
  detectedTime?: Date;
}

async function plantAlarm(tenant: { customerId: string; deviceId: string }, options: PlantAlarmOptions = {}) {
  seq += 1;
  const alarm = await prisma.alarm.create({
    data: {
      deviceId: tenant.deviceId,
      customerId: tenant.customerId,
      code: options.code ?? `E-${seq}`,
      category: 'HEATING',
      severity: options.severity ?? 'WARNING',
      status: options.status ?? 'ACTIVE',
      detectedTime: options.detectedTime ?? new Date(NOW.getTime() - HOUR_MS),
      component: 'heater',
      message: `alarm-${seq}`,
    },
  });
  return alarm;
}

async function outboxCount(alarmId: string) {
  return prisma.outboxEvent.count({ where: { aggregateType: 'alarm', aggregateId: alarmId } });
}

async function auditCount(alarmId: string, action: string) {
  return prisma.auditLog.count({ where: { objectId: alarmId, action, result: 'SUCCESS' } });
}

describe('Alarm 确认/清除工作流', () => {
  test('确认记录操作者/原因/时间 + 审计；重复确认幂等（无新写入/审计/领域事件）', async () => {
    const tenant = await plantTenant('ACK');
    const alarm = await plantAlarm(tenant, { severity: 'CRITICAL' });

    const res = await handlers().acknowledge(
      req(operator, { params: { alarmId: alarm.id }, body: { reason: '已派单处理' } }),
    );
    assert.equal(res.status, 200);
    assertOpenApiResponse('acknowledgeAlarm', 200, res.body);
    const data = (res.body as DataBody).data;
    assert.equal(data.status, 'ACKNOWLEDGED');
    assert.equal(data.replayed, false);
    assert.equal(data.acknowledgedBy, 'op-1');
    assert.equal(data.acknowledgeReason, '已派单处理');
    assert.equal(data.acknowledgedAt, NOW.toISOString());

    // CRITICAL 真实迁移 → 恰好一个领域事件
    assert.equal(await outboxCount(alarm.id), 1);
    const evt = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: alarm.id } });
    assert.equal(evt.eventType, 'ALARM_STATE_CHANGED');
    const payload = evt.payload as Record<string, unknown>;
    assert.equal(payload.fromStatus, 'ACTIVE');
    assert.equal(payload.toStatus, 'ACKNOWLEDGED');
    assert.equal(payload.severity, 'CRITICAL');
    assert.equal(await auditCount(alarm.id, 'alarm.acknowledge'), 1);

    // 重复确认幂等：replayed，无新审计/领域事件
    const replay = await handlers().acknowledge(
      req(operator, { params: { alarmId: alarm.id }, body: { reason: '重复点击' } }),
    );
    assert.equal(replay.status, 200);
    const replayData = (replay.body as DataBody).data;
    assert.equal(replayData.replayed, true);
    assert.equal(replayData.acknowledgeReason, '已派单处理', '重放不覆盖首次操作');
    assert.equal(await auditCount(alarm.id, 'alarm.acknowledge'), 1);
    assert.equal(await outboxCount(alarm.id), 1);
  });

  test('清除：ACTIVE/ACKNOWLEDGED→CLEARED；重复清除幂等；CLEARED 确认 → 409；缺原因 → 400', async () => {
    const tenant = await plantTenant('CLR');
    const acked = await plantAlarm(tenant, { status: 'ACKNOWLEDGED', severity: 'MAJOR' });
    const res = await handlers().clear(
      req(superAdmin, { params: { alarmId: acked.id }, body: { reason: '故障排除' } }),
    );
    assert.equal(res.status, 200);
    const data = (res.body as DataBody).data;
    assert.equal(data.status, 'CLEARED');
    assert.equal(data.clearedBy, 'admin-1');
    assert.equal(data.clearReason, '故障排除');
    assert.equal(data.clearedAt, NOW.toISOString());
    // MAJOR 迁移不产生领域事件
    assert.equal(await outboxCount(acked.id), 0);
    assert.equal(await auditCount(acked.id, 'alarm.clear'), 1);

    // 重复清除幂等
    const replay = await handlers().clear(req(superAdmin, { params: { alarmId: acked.id }, body: { reason: '重复' } }));
    assert.equal((replay.body as DataBody).data.replayed, true);
    assert.equal(await auditCount(acked.id, 'alarm.clear'), 1);

    // CLEARED 终态确认 → 409
    const ackCleared = await handlers().acknowledge(
      req(superAdmin, { params: { alarmId: acked.id }, body: { reason: 'x' } }),
    );
    assert.equal(ackCleared.status, 409);
    assert.equal((ackCleared.body as ErrorBody).error.code, 'CONFLICT');

    // 缺原因 → 400
    const active = await plantAlarm(tenant);
    const noReason = await handlers().clear(req(superAdmin, { params: { alarmId: active.id }, body: {} }));
    assert.equal(noReason.status, 400);
    assert.equal((noReason.body as ErrorBody).error.code, 'VALIDATION_FAILED');
  });

  test('权限：alarm:write 仅 SuperAdmin/Operator（CustomerAdmin/Auditor → 403）；跨 Customer → 404', async () => {
    const tenant = await plantTenant('PERM');
    const other = await plantTenant('OTHER');
    const alarm = await plantAlarm(tenant);

    const forbidden = await handlers().acknowledge(
      req(tenant.customerAdmin, { params: { alarmId: alarm.id }, body: { reason: 'x' } }),
    );
    assert.equal(forbidden.status, 403, 'CustomerAdmin 无 alarm:write');
    const forbiddenAuditor = await handlers().clear(
      req(auditor, { params: { alarmId: alarm.id }, body: { reason: 'x' } }),
    );
    assert.equal(forbiddenAuditor.status, 403, 'Auditor 无 alarm:write');

    // Customer 角色无 alarm:write：跨 Customer 处理在权限门即 403（不泄露存在性）
    const cross = await handlers().acknowledge(
      req(other.customerAdmin, { params: { alarmId: alarm.id }, body: { reason: 'x' } }),
    );
    assert.equal(cross.status, 403);
    // 跨 Customer 详情 → 404（customerViewer 有 alarm:read）
    const crossDetail = await handlers().alarmDetail(req(other.customerViewer, { params: { alarmId: alarm.id } }));
    assert.equal(crossDetail.status, 404);

    // 本 Customer 读放行
    const detail = await handlers().alarmDetail(req(tenant.customerViewer, { params: { alarmId: alarm.id } }));
    assert.equal(detail.status, 200);
  });
});

describe('筛选与游标分页', () => {
  test('severity/status/device/site/时间范围筛选正确；键集游标分页', async () => {
    const tenant = await plantTenant('FILTER');
    const otherSite = await prisma.site.create({
      data: { customerId: tenant.customerId, name: `Site FILTER-2 ${seq}` },
    });
    const otherDeviceId = `dev-alm-filter-${seq}`;
    await prisma.device.create({
      data: {
        id: otherDeviceId,
        serialNumber: `SN-ALM-FILTER-${seq}`,
        model: 'BNX-100',
        hardwareVersion: 'HW1.0',
        manufacturer: 'Hiddenjoy',
        manufactureDate: new Date('2026-01-01T00:00:00Z'),
        lifecycleStatus: 'Active',
        customerId: tenant.customerId,
        siteId: otherSite.id,
      },
    });

    const t0 = NOW.getTime();
    await plantAlarm(tenant, {
      severity: 'CRITICAL',
      status: 'ACTIVE',
      code: 'F-1',
      detectedTime: new Date(t0 - 5 * HOUR_MS),
    });
    await plantAlarm(tenant, {
      severity: 'WARNING',
      status: 'ACKNOWLEDGED',
      code: 'F-2',
      detectedTime: new Date(t0 - 3 * HOUR_MS),
    });
    await plantAlarm(
      { customerId: tenant.customerId, deviceId: otherDeviceId },
      { severity: 'WARNING', status: 'ACTIVE', code: 'F-3', detectedTime: new Date(t0 - HOUR_MS) },
    );

    const h = handlers();
    const list = async (query: Record<string, string>, actor: ActorContext = superAdmin) =>
      (await h.listAlarms(req(actor, { query: { customerId: tenant.customerId, ...query } }))).body as ListBody;

    // severity
    assert.equal((await list({ severity: 'CRITICAL' })).data.length, 1);
    // status
    const acked = await list({ status: 'ACKNOWLEDGED' });
    assert.equal(acked.data.length, 1);
    assert.equal(acked.data[0].code, 'F-2');
    // deviceId
    assert.equal((await list({ deviceId: otherDeviceId })).data.length, 1);
    // siteId（经设备归属解析）
    const siteFiltered = await list({ siteId: tenant.siteId });
    assert.equal(siteFiltered.data.length, 2);
    assert.ok(siteFiltered.data.every((a) => a.deviceId === tenant.deviceId));
    // 时间范围
    const ranged = await list({
      from: new Date(t0 - 4 * HOUR_MS).toISOString(),
      to: new Date(t0 - 2 * HOUR_MS).toISOString(),
    });
    assert.equal(ranged.data.length, 1);
    assert.equal(ranged.data[0].code, 'F-2');
    // 非法枚举 → 400
    const bad = await h.listAlarms(req(superAdmin, { query: { severity: 'FATAL' } }));
    assert.equal(bad.status, 400);

    // 游标分页：limit=1 三页取全
    const page1 = await list({ limit: '1' });
    assert.equal(page1.data.length, 1);
    assert.ok(page1.meta.nextCursor);
    const page2 = await list({ limit: '1', cursor: page1.meta.nextCursor });
    assert.equal(page2.data.length, 1);
    assert.notEqual(page2.data[0].alarmId, page1.data[0].alarmId);
    const page3 = await list({ limit: '1', cursor: page2.meta.nextCursor });
    assert.equal(page3.data.length, 1);
    assert.equal(page3.meta.nextCursor, null, '取完全部 3 行后无下一页');
    assert.deepEqual(
      new Set([page1.data[0].alarmId, page2.data[0].alarmId, page3.data[0].alarmId]).size,
      3,
      '三页游标不重复不缺行',
    );
  });

  test('Customer 角色租户隔离：仅本 Customer 告警；customerId 参数被强制覆盖', async () => {
    const tenant = await plantTenant('TENANT-A');
    const other = await plantTenant('TENANT-B');
    await plantAlarm(tenant, { code: 'A-1' });
    await plantAlarm(other, { code: 'B-1' });

    const h = handlers();
    const ownList = (await h.listAlarms(req(tenant.customerViewer, {}))).body as ListBody;
    assert.ok(ownList.data.length >= 1);
    assert.ok(
      ownList.data.every((a) => a.customerId === tenant.customerId),
      'Customer 角色仅见本 Customer',
    );

    // 显式传其他 customerId 被强制覆盖为本 Customer
    const forced = (await h.listAlarms(req(tenant.customerViewer, { query: { customerId: other.customerId } })))
      .body as ListBody;
    assert.ok(forced.data.every((a) => a.customerId === tenant.customerId));

    // 平台角色可按 customerId 筛选
    const platform = (await h.listAlarms(req(auditor, { query: { customerId: other.customerId } }))).body as ListBody;
    assert.ok(platform.data.every((a) => a.customerId === other.customerId));
    assert.ok(platform.data.some((a) => a.code === 'B-1'));
  });
});

describe('Event/Tamper 只读查询', () => {
  test('Event 列表：eventType/时间筛选 + 租户隔离', async () => {
    const tenant = await plantTenant('EVT');
    const other = await plantTenant('EVT-B');
    const t0 = NOW.getTime();
    await prisma.deviceEvent.create({
      data: {
        deviceId: tenant.deviceId,
        customerId: tenant.customerId,
        eventType: 'LOGIN',
        username: 'op-1',
        occurredAt: new Date(t0 - 2 * HOUR_MS),
      },
    });
    await prisma.deviceEvent.create({
      data: {
        deviceId: tenant.deviceId,
        customerId: tenant.customerId,
        eventType: 'DISCHARGE',
        occurredAt: new Date(t0 - 30 * 60_000),
      },
    });
    await prisma.deviceEvent.create({
      data: {
        deviceId: other.deviceId,
        customerId: other.customerId,
        eventType: 'LOGIN',
        occurredAt: new Date(t0 - HOUR_MS),
      },
    });

    const h = handlers();
    const all = (await h.listEvents(req(superAdmin, { query: { customerId: tenant.customerId } }))).body as ListBody;
    assert.equal(all.data.length, 2);

    const byType = (
      await h.listEvents(req(superAdmin, { query: { customerId: tenant.customerId, eventType: 'LOGIN' } }))
    ).body as ListBody;
    assert.equal(byType.data.length, 1);
    assert.equal(byType.data[0].username, 'op-1');

    const ranged = (
      await h.listEvents(
        req(superAdmin, {
          query: { customerId: tenant.customerId, from: new Date(t0 - HOUR_MS).toISOString() },
        }),
      )
    ).body as ListBody;
    assert.equal(ranged.data.length, 1);
    assert.equal(ranged.data[0].eventType, 'DISCHARGE');

    // 租户隔离
    const own = (await h.listEvents(req(tenant.customerViewer, {}))).body as ListBody;
    assert.ok(own.data.every((e) => e.customerId === tenant.customerId));
  });

  test('Tamper 列表：severity 筛选 + 只读（无写端点）', async () => {
    const tenant = await plantTenant('TMP');
    await prisma.tamperEvent.create({
      data: {
        deviceId: tenant.deviceId,
        customerId: tenant.customerId,
        eventType: 'COVER_OPEN',
        severity: 'CRITICAL',
        component: 'lid',
        details: { sensor: 'hall' },
        occurredAt: NOW,
      },
    });
    await prisma.tamperEvent.create({
      data: {
        deviceId: tenant.deviceId,
        customerId: tenant.customerId,
        eventType: 'VIBRATION',
        severity: 'WARNING',
        occurredAt: NOW,
      },
    });

    const h = handlers();
    const all = (await h.listTamperEvents(req(superAdmin, { query: { customerId: tenant.customerId } })))
      .body as ListBody;
    assert.equal(all.data.length, 2);

    const critical = (
      await h.listTamperEvents(req(superAdmin, { query: { customerId: tenant.customerId, severity: 'CRITICAL' } }))
    ).body as ListBody;
    assert.equal(critical.data.length, 1);
    assert.equal(critical.data[0].eventType, 'COVER_OPEN');
    assert.deepEqual(critical.data[0].details, { sensor: 'hall' });

    const bad = await h.listTamperEvents(req(superAdmin, { query: { severity: 'FATAL' } }));
    assert.equal(bad.status, 400);
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('AdminAlarmError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_ALARM_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('响应字段与 OpenAPI 契约一致（Alarm 详情 / 处理结果 / Event / Tamper）', async () => {
    const api = loadJson('admin-alarm-api.json');
    const tenant = await plantTenant('CONTRACT');
    const alarm = await plantAlarm(tenant);

    const h = handlers();
    const detail = await h.alarmDetail(req(superAdmin, { params: { alarmId: alarm.id } }));
    assert.equal(detail.status, 200);
    assert.deepEqual(
      Object.keys((detail.body as DataBody).data).sort(),
      [...api.components.schemas.Alarm.required].sort(),
    );

    const ack = await h.acknowledge(req(operator, { params: { alarmId: alarm.id }, body: { reason: '契约' } }));
    assert.deepEqual(
      Object.keys((ack.body as DataBody).data).sort(),
      [...api.components.schemas.AlarmHandleResult.required].sort(),
    );

    await prisma.deviceEvent.create({
      data: { deviceId: tenant.deviceId, customerId: tenant.customerId, eventType: 'LOGIN', occurredAt: NOW },
    });
    const events = (await h.listEvents(req(superAdmin, { query: { customerId: tenant.customerId } }))).body as ListBody;
    assert.deepEqual(Object.keys(events.data[0]).sort(), [...api.components.schemas.DeviceEvent.required].sort());

    await prisma.tamperEvent.create({
      data: {
        deviceId: tenant.deviceId,
        customerId: tenant.customerId,
        eventType: 'COVER_OPEN',
        severity: 'CRITICAL',
        occurredAt: NOW,
      },
    });
    const tampers = (await h.listTamperEvents(req(superAdmin, { query: { customerId: tenant.customerId } })))
      .body as ListBody;
    assert.deepEqual(Object.keys(tampers.data[0]).sort(), [...api.components.schemas.TamperEvent.required].sort());
  });

  test('alarm 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/alarm/', import.meta.url));
    for (const file of ['errors.ts', 'service.ts', 'handler.ts', 'index.ts']) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
