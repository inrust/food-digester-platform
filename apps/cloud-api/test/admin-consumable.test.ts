/**
 * BE-CNS-01 耗材状态投影与查询 API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 原型两种耗材列均能稳定映射（碳包/碳滤网→CARBON_FILTER；活性菌/添加剂→BIO_ADDITIVE，不混用）；
 * - 旧消息不覆盖新值（乱序防护 + replay 幂等）；未知值显示 unknown 而非 50%；
 * - 阈值和多条件筛选正确；联系人只向授权角色返回；Customer 角色租户隔离。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import {
  ADMIN_CONSUMABLE_ERROR_HTTP_STATUS,
  createAdminConsumableHandlers,
  recordConsumableReport,
} from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-29T12:00:00Z');
const now = () => NOW;
const HOUR_MS = 3_600_000;
const T1 = new Date(NOW.getTime() - 2 * HOUR_MS); // 2h 前（fresh）
const T0 = new Date(NOW.getTime() - 5 * HOUR_MS); // 5h 前（乱序旧值）

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
const viewer: ActorContext = { ...superAdmin, actorId: 'cv-1', actorType: 'customer', roles: ['CustomerViewer'] };

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

type DataBody = { data: unknown; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

/** vitest 的 assert 无 rejects；显式捕获断言错误消息。 */
async function rejectsWith(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(pattern.test((err as Error).message), `错误消息不匹配：${(err as Error).message}`);
    return;
  }
  assert.fail('应当抛出异常');
}
type StatusRow = {
  deviceId: string;
  serialNumber: string;
  alias: string | null;
  connectivity: string;
  site: { siteId: string; name: string; region: string | null; subregion: string | null } | null;
  consumables: Record<
    string,
    {
      remainingPercent: number | null;
      remainingDisplay: string;
      stale: boolean;
      observedAt: string | null;
      sourceMessageId: string | null;
    } | null
  >;
};

let seq = 0;
async function plantSite(customerId: string, options: Record<string, unknown> = {}) {
  seq += 1;
  const site = await prisma.site.create({
    data: {
      customerId,
      name: `Site CNS ${seq}`,
      region: `Region-A`,
      subregion: `Sub-1`,
      contactName: '张三',
      contactPhone: '+86-13800000000',
      contactEmail: 'ops@example.com',
      ...options,
    },
  });
  return site;
}

async function plantDevice(
  options: { customerId?: string; siteId?: string; alias?: string; heartbeatAt?: Date | null } = {},
) {
  seq += 1;
  const deviceId = `dev-cns-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-CNS-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      ...(options.customerId ? { customerId: options.customerId } : {}),
      ...(options.siteId ? { siteId: options.siteId } : {}),
      ...(options.alias !== undefined ? { alias: options.alias } : {}),
    },
  });
  if (options.heartbeatAt !== undefined && options.heartbeatAt !== null) {
    await prisma.deviceLatestState.create({
      data: { deviceId, customerId: options.customerId ?? null, lastHeartbeatAt: options.heartbeatAt },
    });
  }
  return deviceId;
}

async function report(
  deviceId: string,
  rawName: string,
  remainingPercent: number | null,
  sourceMessageId: string,
  observedAt: Date,
) {
  return recordConsumableReport(
    { client: prisma, now },
    { deviceId, rawName, remainingPercent, sourceMessageId, observedAt },
  );
}

async function list(
  h: ReturnType<typeof createAdminConsumableHandlers>,
  actor: ActorContext,
  query: Record<string, string> = {},
) {
  const res = await h.list(req(actor, { query }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (res.body as DataBody).data as StatusRow[];
}

async function listResponse(
  h: ReturnType<typeof createAdminConsumableHandlers>,
  actor: ActorContext,
  query: Record<string, string> = {},
) {
  const res = await h.list(req(actor, { query }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as DataBody;
}

describe('投影保存与字典映射', () => {
  test('两种耗材列稳定映射；查询返回百分比/来源消息/observedAt/stale；联系人授权摘要', async () => {
    const h = createAdminConsumableHandlers({ client: prisma, now });
    const customer = await prisma.customer.create({ data: { name: 'Customer CNS 1' } });
    const site = await plantSite(customer.id);
    const deviceId = await plantDevice({ customerId: customer.id, siteId: site.id, alias: '前厅机', heartbeatAt: NOW });

    // 原型两列：碳包 → CARBON_FILTER；活性菌 → BIO_ADDITIVE
    const r1 = await report(deviceId, '碳包', 42, 'msg-carbon-1', T1);
    const r2 = await report(deviceId, '活性菌', null, 'msg-bio-1', T1); // 未上报百分比 → unknown
    assert.deepEqual({ applied: r1.applied, type: r1.consumableType }, { applied: true, type: 'CARBON_FILTER' });
    assert.deepEqual({ applied: r2.applied, type: r2.consumableType }, { applied: true, type: 'BIO_ADDITIVE' });
    // 不混用：碳滤网 → CARBON_FILTER；添加剂 → BIO_ADDITIVE
    assert.equal(
      (await report(deviceId, '碳滤网', 40, 'msg-carbon-2', new Date(T1.getTime() + 1000))).consumableType,
      'CARBON_FILTER',
    );
    assert.equal(
      (await report(deviceId, '添加剂', 80, 'msg-bio-2', new Date(T1.getTime() + 1000))).consumableType,
      'BIO_ADDITIVE',
    );

    const rows = await list(h, superAdmin);
    const row = rows.find((r) => r.deviceId === deviceId);
    assert.ok(row);
    assert.equal(row.connectivity, 'ONLINE');
    assert.equal(row.site?.region, 'Region-A');
    assert.equal(row.alias, '前厅机');
    const carbon = row.consumables.CARBON_FILTER;
    assert.ok(carbon);
    assert.equal(carbon.remainingPercent, 40, '最新上报值');
    assert.equal(carbon.remainingDisplay, '40%');
    assert.equal(carbon.stale, false);
    assert.equal(carbon.observedAt, new Date(T1.getTime() + 1000).toISOString());
    assert.equal(carbon.sourceMessageId, 'msg-carbon-2');
    const bio = row.consumables.BIO_ADDITIVE;
    assert.ok(bio);
    assert.equal(bio.remainingPercent, 80);
    assert.ok(!Object.hasOwn(row, 'contact'), '列表 DTO 不得携带联系人字段');
    assert.ok(!JSON.stringify(rows).includes('+86-13800000000'), '列表网络响应不得预载号码');
  });

  test('乱序防护：旧消息不覆盖新值；同消息同时间 replay 幂等', async () => {
    const deviceId = await plantDevice();
    assert.equal((await report(deviceId, '碳包', 30, 'msg-new', T1)).applied, true);
    // 更旧消息 → 不覆盖
    const stale = await report(deviceId, '碳包', 90, 'msg-old', T0);
    assert.deepEqual({ applied: stale.applied, replayed: stale.replayed }, { applied: false, replayed: false });
    // 同消息同时间 → replay 幂等
    const replay = await report(deviceId, '碳包', 30, 'msg-new', T1);
    assert.deepEqual({ applied: replay.applied, replayed: replay.replayed }, { applied: false, replayed: true });
    const row = await prisma.consumableProjection.findFirst({ where: { deviceId, consumableType: 'CARBON_FILTER' } });
    assert.equal(row?.remainingPercent, 30, '旧消息未覆盖新值');
    assert.equal(row?.sourceMessageId, 'msg-new');
  });

  test('未知值显示 unknown 而非 50%；未知耗材名失败关闭；百分比越界拒绝', async () => {
    const h = createAdminConsumableHandlers({ client: prisma, now });
    const deviceId = await plantDevice({ heartbeatAt: NOW });
    // 未上报 → unknown（不为 50%）
    await report(deviceId, 'BIO_ADDITIVE', null, 'msg-x', T1);
    const rows = await list(h, superAdmin, { keyword: deviceId });
    const bio = rows[0]?.consumables.BIO_ADDITIVE;
    assert.equal(bio?.remainingPercent, null);
    assert.equal(bio?.remainingDisplay, 'unknown');
    // 未上报耗材列 → null（非虚构值）
    assert.equal(rows[0]?.consumables.CARBON_FILTER, null);
    // 未知耗材名失败关闭（不落库）
    await rejectsWith(() => report(deviceId, '催化剂', 10, 'msg-bad', T1), /Unknown consumable raw name/);
    assert.equal(await prisma.consumableProjection.count({ where: { sourceMessageId: 'msg-bad' } }), 0);
    // 百分比越界/非整数 → 拒绝（DB CHECK 兜底）
    await rejectsWith(() => report(deviceId, '碳包', 101, 'msg-p1', T1), /0 and 100/);
    await rejectsWith(() => report(deviceId, '碳包', -1, 'msg-p2', T1), /0 and 100/);
    await rejectsWith(() => report(deviceId, '碳包', 50.5, 'msg-p3', T1), /0 and 100/);
    // 设备不存在 → 404 语义
    await rejectsWith(() => report('dev-missing', '碳包', 10, 'msg-p4', T1), /not found/i);
  });
});

describe('筛选与阈值', () => {
  test('筛选后的结果使用不透明游标分页，非法 cursor/limit 失败关闭', async () => {
    const h = createAdminConsumableHandlers({ client: prisma, now });
    const customer = await prisma.customer.create({ data: { name: 'Customer CNS pagination' } });
    const ids = await Promise.all([
      plantDevice({ customerId: customer.id, heartbeatAt: NOW }),
      plantDevice({ customerId: customer.id, heartbeatAt: NOW }),
      plantDevice({ customerId: customer.id, heartbeatAt: NOW }),
    ]);
    const first = await listResponse(h, operator, { customerId: customer.id, limit: '2' });
    assert.deepEqual(
      (first.data as StatusRow[]).map((row) => row.deviceId),
      ids.slice(0, 2),
    );
    assert.equal(typeof first.meta['nextCursor'], 'string');
    const second = await listResponse(h, operator, {
      customerId: customer.id,
      limit: '2',
      cursor: first.meta['nextCursor'] as string,
    });
    assert.deepEqual(
      (second.data as StatusRow[]).map((row) => row.deviceId),
      ids.slice(2),
    );
    assert.equal(second.meta['nextCursor'], null);
    assert.equal((await h.list(req(operator, { query: { cursor: 'not-a-cursor' } }))).status, 400);
    assert.equal((await h.list(req(operator, { query: { limit: '101' } }))).status, 400);
  });

  test('Region/Subregion/Site、连接状态、关键字、耗材阈值与多条件组合', async () => {
    const h = createAdminConsumableHandlers({ client: prisma, now });
    const customer = await prisma.customer.create({ data: { name: 'Customer CNS 2' } });
    const siteA = await plantSite(customer.id, { region: 'Region-X', subregion: 'Sub-X' });
    const siteB = await plantSite(customer.id, { region: 'Region-Y', subregion: 'Sub-Y' });
    const dLow = await plantDevice({ customerId: customer.id, siteId: siteA.id, alias: '低量机', heartbeatAt: NOW });
    const dHigh = await plantDevice({ customerId: customer.id, siteId: siteB.id, alias: '高量机' }); // 无心跳 OFFLINE
    await report(dLow, '碳包', 15, 'm-low', T1);
    await report(dHigh, '碳包', 90, 'm-high', T1);

    // 阈值筛选：remaining < 30
    let rows = await list(h, operator, {
      maxRemainingPercent: '30',
      consumableType: 'CARBON_FILTER',
      customerId: customer.id,
    });
    assert.deepEqual(
      rows.map((r) => r.deviceId),
      [dLow],
    );
    // Region + 阈值组合
    rows = await list(h, operator, { region: 'Region-Y', maxRemainingPercent: '95', customerId: customer.id });
    assert.deepEqual(
      rows.map((r) => r.deviceId),
      [dHigh],
    );
    // Subregion + Site
    rows = await list(h, operator, { subregion: 'Sub-X', siteId: siteA.id });
    assert.deepEqual(
      rows.map((r) => r.deviceId),
      [dLow],
    );
    // 连接状态
    rows = await list(h, operator, { connectivity: 'OFFLINE', customerId: customer.id });
    assert.ok(rows.some((r) => r.deviceId === dHigh) && !rows.some((r) => r.deviceId === dLow));
    // 关键字（别名）
    rows = await list(h, operator, { keyword: '低量机' });
    assert.deepEqual(
      rows.map((r) => r.deviceId),
      [dLow],
    );
    // 未上报耗材不参与阈值筛选（unknown ≠ 低量）
    const dUnknown = await plantDevice({ customerId: customer.id, heartbeatAt: NOW });
    await report(dUnknown, '碳包', null, 'm-unknown', T1);
    rows = await list(h, operator, { maxRemainingPercent: '30', customerId: customer.id });
    assert.ok(!rows.some((r) => r.deviceId === dUnknown), 'unknown 不参与阈值筛选');
    // 非法筛选值 → 400
    const bad = await h.list(req(operator, { query: { connectivity: 'MAYBE' } }));
    assert.equal(bad.status, 400);
    const badType = await h.list(req(operator, { query: { consumableType: 'CATALYST' } }));
    assert.equal(badType.status, 400);
  });

  test('stale 派生：observedAt 超阈值 → stale=true', async () => {
    const h = createAdminConsumableHandlers({ client: prisma, now });
    const deviceId = await plantDevice({ heartbeatAt: NOW });
    await report(deviceId, '碳包', 60, 'm-stale', new Date(NOW.getTime() - 25 * HOUR_MS));
    const rows = await list(h, superAdmin, { keyword: deviceId });
    assert.equal(rows[0]?.consumables.CARBON_FILTER?.stale, true, '超过 24h → stale');
  });
});

describe('联系人按需授权与租户隔离', () => {
  test('列表零 PII；独立端点覆盖授权、403、404 与跨 Customer', async () => {
    const h = createAdminConsumableHandlers({ client: prisma, now });
    const customer = await prisma.customer.create({ data: { name: 'Customer CNS 3' } });
    const site = await plantSite(customer.id);
    const own = await plantDevice({ customerId: customer.id, siteId: site.id, heartbeatAt: NOW });
    const otherCustomer = await prisma.customer.create({ data: { name: 'Customer CNS 4' } });
    const other = await plantDevice({ customerId: otherCustomer.id, heartbeatAt: NOW });
    const customerAdmin: ActorContext = {
      ...superAdmin,
      actorId: 'ca-1',
      actorType: 'customer',
      roles: ['CustomerAdmin'],
      customerId: customer.id,
    };
    const customerViewer: ActorContext = { ...viewer, customerId: customer.id };

    // 所有列表响应均不携联系人；Customer 角色仍只见本 Customer。
    let rows = await list(h, customerAdmin);
    assert.ok(rows.some((r) => r.deviceId === own));
    assert.ok(!rows.some((r) => r.deviceId === other), '租户隔离');
    assert.ok(!JSON.stringify(rows).includes('+86-13800000000'));
    rows = await list(h, customerViewer);
    assert.ok(!JSON.stringify(rows).includes('+86-13800000000'));
    rows = await list(h, auditor, { customerId: customer.id });
    assert.ok(!JSON.stringify(rows).includes('+86-13800000000'));
    rows = await list(h, operator, { customerId: customer.id });
    assert.ok(!JSON.stringify(rows).includes('+86-13800000000'));

    const ownContact = await h.contact(req(customerAdmin, { params: { deviceId: own } }));
    assert.equal(ownContact.status, 200);
    assert.deepEqual((ownContact.body as DataBody).data, {
      name: '张三',
      phone: '+86-13800000000',
      email: 'ops@example.com',
    });
    assert.equal((await h.contact(req(operator, { params: { deviceId: own } }))).status, 200);
    assert.equal((await h.contact(req(customerViewer, { params: { deviceId: own } }))).status, 403);
    assert.equal((await h.contact(req(auditor, { params: { deviceId: own } }))).status, 403);
    assert.equal((await h.contact(req(customerAdmin, { params: { deviceId: other } }))).status, 404);
    assert.equal((await h.contact(req(customerAdmin, { params: { deviceId: 'missing' } }))).status, 404);
    // 未认证 → 401
    const unauth = await h.contact(req(undefined, { params: { deviceId: own } }));
    assert.equal(unauth.status, 401);
    assert.equal((unauth.body as ErrorBody).error.code, 'UNAUTHENTICATED');
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('错误码与 CT-05 目录一致；DTO 与 OpenAPI 契约一致', async () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_CONSUMABLE_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
    const api = loadJson('admin-consumable-api.json');
    const h = createAdminConsumableHandlers({ client: prisma, now });
    const deviceId = await plantDevice({ heartbeatAt: NOW });
    await report(deviceId, '碳包', 55, 'm-dto', T1);
    const rows = await list(h, superAdmin, { keyword: deviceId });
    const row = rows[0];
    assert.ok(row);
    assert.deepEqual(Object.keys(row).sort(), [...api.components.schemas.ConsumableStatus.required].sort());
    const carbon = row.consumables.CARBON_FILTER;
    assert.ok(carbon);
    assert.deepEqual(Object.keys(carbon).sort(), [...api.components.schemas.ConsumableValue.required].sort());
  });

  test('consumable 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/consumable/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
