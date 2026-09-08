/**
 * BE-CNS-02 耗材更换申请工作流 API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - “未处理→正在处理→完成处理”完整链路可复验（PENDING→PROCESSING→COMPLETED）；
 * - 跳级、重复处理（409）、跨 Customer（404 租户隔离）和未授权角色（403）失败；
 * - 同设备同耗材开放申请重复创建幂等返回现有记录；
 * - 状态迁移 If-Match；完成后保留完整历史（申请时间/来源/处理人/备注/完成时间 + 审计）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { ADMIN_CONSUMABLE_ERROR_HTTP_STATUS, createAdminConsumableRequestHandlers } from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-29T12:00:00Z');
const now = () => NOW;

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
  return createAdminConsumableRequestHandlers({ client: prisma, now });
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

function writeReq(actor: ActorContext, version: number, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return req(actor, { ...options, headers: { 'If-Match': String(version) } });
}

type DataBody = { data: Record<string, unknown>; meta: Record<string, unknown> };
type ListBody = { data: Record<string, unknown>[]; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

let seq = 0;
async function plantDevice(options: { withCustomer?: boolean; lifecycle?: string } = {}) {
  seq += 1;
  let customerId: string | undefined;
  if (options.withCustomer !== false) {
    const customer = await prisma.customer.create({ data: { name: `Customer REQ ${seq}` } });
    customerId = customer.id;
  }
  const deviceId = `dev-req-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-REQ-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: options.lifecycle ?? 'Active',
      ...(customerId ? { customerId } : {}),
    },
  });
  return { deviceId, customerId };
}

async function createReq(h: ReturnType<typeof handlers>, deviceId: string, consumableType = 'CARBON_FILTER') {
  const res = await h.create(req(superAdmin, { body: { deviceId, consumableType, note: '余量不足' } }));
  return res;
}

async function auditCount(requestId: string, action: string) {
  return prisma.auditLog.count({ where: { objectId: requestId, action, result: 'SUCCESS' } });
}

describe('完整链路：未处理→正在处理→完成处理', () => {
  test('创建→处理→完成；每步状态/处理人/备注/完成时间/审计', async () => {
    const h = handlers();
    const { deviceId, customerId } = await plantDevice();

    // 创建（PENDING，source=ADMIN，requestedBy/requestedAt）
    const created = await createReq(h, deviceId);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assertOpenApiResponse('createConsumableRequest', 201, created.body);
    const c = (created.body as DataBody).data;
    assert.equal(c.status, 'PENDING');
    assert.equal(c.source, 'ADMIN');
    assert.equal(c.requestedBy, 'admin-1');
    assert.equal(c.customerId, customerId);
    assert.equal(c.replayed, false);
    assert.equal(c.version, 1);
    const requestId = c.requestId as string;

    // 列表/详情可见
    const detail = await h.detail(req(auditor, { params: { requestId } }));
    assert.equal(detail.status, 200);
    assert.equal((detail.body as DataBody).data.status, 'PENDING');

    // 处理 PENDING→PROCESSING（processedBy 记录）
    const processing = await h.process(writeReq(operator, 1, { params: { requestId }, body: { note: '已派单' } }));
    assert.equal(processing.status, 200, JSON.stringify(processing.body));
    assert.equal((processing.body as DataBody).data.status, 'PROCESSING');
    assert.equal((processing.body as DataBody).data.processedBy, 'op-1');
    assert.equal((processing.body as DataBody).data.version, 2);

    // 完成 PROCESSING→COMPLETED（completedAt + processNote）
    const completed = await h.complete(
      writeReq(superAdmin, 2, { params: { requestId }, body: { note: '已更换碳滤网' } }),
    );
    assert.equal(completed.status, 200);
    const done = (completed.body as DataBody).data;
    assert.equal(done.status, 'COMPLETED');
    assert.equal(done.processNote, '已更换碳滤网');
    assert.equal(done.completedAt, NOW.toISOString());
    assert.equal(done.version, 3);

    // 审计：create/process/complete 各恰好一次（完成后保留完整历史）
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: deviceId, action: 'consumable.request.create', result: 'SUCCESS' },
      }),
      1,
    );
    assert.equal(await auditCount(requestId, 'consumable.request.process'), 1);
    assert.equal(await auditCount(requestId, 'consumable.request.complete'), 1);
    // 终态行保留（可再查询）
    const kept = await h.detail(req(auditor, { params: { requestId } }));
    assert.equal((kept.body as DataBody).data.status, 'COMPLETED');
  });

  test('跳级/重复处理/终态迁移 409；缺 If-Match 400；If-Match 漂移 409 VERSION_CONFLICT；缺强制备注 400', async () => {
    const h = handlers();
    const { deviceId } = await plantDevice();
    const created = await createReq(h, deviceId);
    const requestId = (created.body as DataBody).data.requestId as string;

    // 跳级 PENDING→COMPLETED → 409
    const skip = await h.complete(writeReq(superAdmin, 1, { params: { requestId }, body: { note: '跳级' } }));
    assert.equal(skip.status, 409);
    assert.equal((skip.body as ErrorBody).error.code, 'CONFLICT');
    // 缺 If-Match → 400
    assert.equal((await h.process(req(operator, { params: { requestId }, body: {} }))).status, 400);
    // 完成缺备注 → 400
    assert.equal((await h.complete(writeReq(superAdmin, 1, { params: { requestId }, body: {} }))).status, 400);
    // 正常推进到 PROCESSING
    await h.process(writeReq(operator, 1, { params: { requestId }, body: {} }));
    // If-Match 漂移（version 1 已消费）→ 409 VERSION_CONFLICT（状态校验合法但版本漂移）
    const stale = await h.cancel(writeReq(superAdmin, 1, { params: { requestId }, body: { note: 'x' } }));
    assert.equal(stale.status, 409);
    assert.equal((stale.body as ErrorBody).error.code, 'VERSION_CONFLICT');
    // 完成
    await h.complete(writeReq(operator, 2, { params: { requestId }, body: { note: 'done' } }));
    // 重复处理（COMPLETED→PROCESSING）→ 409
    assert.equal((await h.process(writeReq(operator, 3, { params: { requestId }, body: {} }))).status, 409);
    // 重复完成 → 409
    assert.equal((await h.complete(writeReq(operator, 3, { params: { requestId }, body: { note: 'x' } }))).status, 409);
    // 写被拒后无审计污染
    assert.equal(await auditCount(requestId, 'consumable.request.process'), 1);
  });

  test('取消路径：PENDING→CANCELLED 强制原因；CANCELLED 终态不可再迁移', async () => {
    const h = handlers();
    const { deviceId } = await plantDevice();
    const created = await createReq(h, deviceId);
    const requestId = (created.body as DataBody).data.requestId as string;
    // 取消缺原因 → 400
    assert.equal((await h.cancel(writeReq(superAdmin, 1, { params: { requestId }, body: {} }))).status, 400);
    const cancelled = await h.cancel(writeReq(superAdmin, 1, { params: { requestId }, body: { note: '误报' } }));
    assert.equal(cancelled.status, 200);
    assert.equal((cancelled.body as DataBody).data.status, 'CANCELLED');
    assert.equal(
      (await h.process(writeReq(superAdmin, 2, { params: { requestId }, body: {} }))).status,
      409,
      '终态不可迁移',
    );
    assert.equal(await auditCount(requestId, 'consumable.request.cancel'), 1);
  });
});

describe('幂等与冲突', () => {
  test('同设备同耗材开放申请重复创建幂等返回现有记录；终态后可再申请；不同耗材互不影响', async () => {
    const h = handlers();
    const { deviceId } = await plantDevice();
    const first = await createReq(h, deviceId, 'CARBON_FILTER');
    const firstId = (first.body as DataBody).data.requestId as string;

    // 重复申请 → 200 replayed=true 返回现有记录，无新行/审计
    const dup = await createReq(h, deviceId, 'CARBON_FILTER');
    assert.equal(dup.status, 200);
    const d = (dup.body as DataBody).data;
    assert.equal(d.requestId, firstId);
    assert.equal(d.replayed, true);
    assert.equal(await prisma.consumableRequest.count({ where: { deviceId, consumableType: 'CARBON_FILTER' } }), 1);
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: deviceId, action: 'consumable.request.create', result: 'SUCCESS' },
      }),
      1,
    );

    // PROCESSING 仍属开放状态 → 幂等
    await h.process(writeReq(operator, 1, { params: { requestId: firstId }, body: {} }));
    const dup2 = await createReq(h, deviceId, 'CARBON_FILTER');
    assert.equal((dup2.body as DataBody).data.replayed, true);

    // 不同耗材互不影响
    const other = await createReq(h, deviceId, 'BIO_ADDITIVE');
    assert.equal(other.status, 201);
    assert.equal((other.body as DataBody).data.replayed, false);

    // 完成后可再申请（开放索引释放）
    await h.complete(writeReq(superAdmin, 2, { params: { requestId: firstId }, body: { note: 'done' } }));
    const again = await createReq(h, deviceId, 'CARBON_FILTER');
    assert.equal(again.status, 201);
    assert.equal((again.body as DataBody).data.replayed, false);
    assert.notEqual((again.body as DataBody).data.requestId, firstId);
  });

  test('非法类型 400；设备不存在 404；未分配 Customer/Retired 409', async () => {
    const h = handlers();
    const { deviceId } = await plantDevice();
    assert.equal((await h.create(req(superAdmin, { body: { deviceId, consumableType: 'CATALYST' } }))).status, 400);
    assert.equal(
      (await h.create(req(superAdmin, { body: { deviceId: 'dev-missing', consumableType: 'CARBON_FILTER' } }))).status,
      404,
    );
    const unassigned = await plantDevice({ withCustomer: false });
    assert.equal(
      (await h.create(req(superAdmin, { body: { deviceId: unassigned.deviceId, consumableType: 'CARBON_FILTER' } })))
        .status,
      409,
    );
    const retired = await plantDevice({ lifecycle: 'Retired' });
    assert.equal(
      (await h.create(req(superAdmin, { body: { deviceId: retired.deviceId, consumableType: 'CARBON_FILTER' } })))
        .status,
      409,
    );
  });
});

describe('权限与租户隔离', () => {
  test('未授权角色创建/处理 403；跨 Customer 详情 404；Customer 列表租户隔离；未认证 401', async () => {
    const h = handlers();
    const { deviceId, customerId } = await plantDevice();
    const created = await createReq(h, deviceId);
    const requestId = (created.body as DataBody).data.requestId as string;
    const customerAdmin: ActorContext = {
      ...superAdmin,
      actorId: 'ca-1',
      actorType: 'customer',
      roles: ['CustomerAdmin'],
      customerId: customerId as string,
    };
    const otherCustomerAdmin: ActorContext = { ...customerAdmin, actorId: 'ca-2', customerId: 'cust-other' };

    // CustomerAdmin 无 device:write → 创建/处理 403
    assert.equal(
      (await h.create(req(customerAdmin, { body: { deviceId, consumableType: 'BIO_ADDITIVE' } }))).status,
      403,
    );
    assert.equal((await h.process(writeReq(customerAdmin, 1, { params: { requestId }, body: {} }))).status, 403);
    assert.equal((await h.complete(writeReq(auditor, 1, { params: { requestId }, body: { note: 'x' } }))).status, 403);
    // CustomerAdmin 读本 Customer 放行；跨 Customer 详情 404
    assert.equal((await h.detail(req(customerAdmin, { params: { requestId } }))).status, 200);
    assert.equal((await h.detail(req(otherCustomerAdmin, { params: { requestId } }))).status, 404);
    const list = await h.list(req(otherCustomerAdmin, {}));
    assert.equal((list.body as ListBody).data.length, 0, '租户隔离：他 Customer 不可见');
    // Auditor 跨 Customer 只读
    assert.equal((await h.detail(req(auditor, { params: { requestId } }))).status, 200);
    // 未认证 401；不存在 404
    assert.equal((await h.list(req(undefined, {}))).status, 401);
    assert.equal((await h.detail(req(auditor, { params: { requestId: 'req-missing' } }))).status, 404);
    // 非法状态筛选 400
    assert.equal((await h.list(req(auditor, { query: { status: 'BOGUS' } }))).status, 400);
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
    const api = loadJson('admin-consumable-request-api.json');
    const { deviceId } = await plantDevice();
    const created = await createReq(handlers(), deviceId);
    const data = (created.body as DataBody).data;
    assert.deepEqual(
      Object.keys(data).sort(),
      [...api.components.schemas.ConsumableRequest.required, 'replayed'].sort(),
    );
  });

  test('consumable 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/consumable/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
