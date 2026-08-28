/**
 * BE-CUS-01 Customer 管理 API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - CRUD：创建(201+审计)/详情/更新(If-Match)/停用(强制原因)/软删除（记录保留）；
 * - 键集游标分页不重不漏 + status 筛选；
 * - 并发冲突：If-Match 缺失 400、版本不符 409 VERSION_CONFLICT；
 * - 跨 Customer 隔离：Customer 角色仅可读自身详情（跨 Customer 403），写操作 403；
 * - 受约束删除：关联有效设备/有效 License → 409 CONFLICT 明确错误；Retired 设备/Expired License 不阻塞；
 * - 契约一致性：错误码对齐 CT-05 目录，DTO 字段对齐 OpenAPI，模块无 AWS 依赖。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { ADMIN_CUSTOMER_ERROR_HTTP_STATUS, createAdminCustomerHandlers, toCustomerDto } from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import type { CustomerRecord } from '../src/admin/customer/repository.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-28T12:00:00Z');

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
  return createAdminCustomerHandlers({ client: prisma, now: () => NOW });
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
async function plantCustomer(status?: 'ACTIVE' | 'SUSPENDED') {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `Customer CUS ${seq}` } });
  if (status === 'SUSPENDED') {
    return prisma.customer.update({ where: { id: customer.id }, data: { status: 'SUSPENDED' } });
  }
  return customer;
}

async function plantDevice(customerId: string, lifecycleStatus: string) {
  seq += 1;
  return prisma.device.create({
    data: {
      id: `dev-cus-${seq}`,
      serialNumber: `SN-CUS-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus,
      customerId,
    },
  });
}

async function plantLicense(customerId: string, deviceId: string, status: string) {
  return prisma.license.create({
    data: {
      deviceId,
      customerId,
      status,
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validTo: new Date('2027-01-01T00:00:00Z'),
      createdBy: 'test',
    },
  });
}

type DataBody = { data: Record<string, unknown>; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

describe('POST /admin/customers（创建）', () => {
  test('PlatformOperator 创建成功：201 + ACTIVE/version=1 + 创建审计', async () => {
    const res = await handlers().create(req(operator, { body: { name: '  Acme Corp  ' } }));
    assert.equal(res.status, 201);
    const { data, meta } = res.body as DataBody;
    assert.equal(data.name, 'Acme Corp', '名称去首尾空白');
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.version, 1);
    assert.equal(meta.requestId !== undefined && meta.timestamp === NOW.toISOString(), true);

    const audits = await prisma.auditLog.findMany({
      where: { objectId: data.id as string, action: 'customer.create' },
    });
    assert.equal(audits.length, 1, '每次创建写一条审计');
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.actorId, 'op-1');
    assert.equal(audits[0]?.actorRole, 'PlatformOperator');
    assert.equal(audits[0]?.customerId, data.id);
  });

  test('name 缺失/空白/超长 → 400；Auditor/Customer 角色/未认证 → 403/401', async () => {
    const h = handlers();
    for (const body of [{}, { name: '   ' }, { name: 'x'.repeat(201) }, { name: 123 }]) {
      const res = await h.create(req(operator, { body }));
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 必须 400`);
      assert.equal((res.body as ErrorBody).error.code, 'VALIDATION_FAILED');
    }
    const byAuditor = await h.create(req(auditor, { body: { name: 'X' } }));
    assert.equal(byAuditor.status, 403, 'Auditor 只读');
    const byCustomer = await h.create(req(customerActor('cust-1'), { body: { name: 'X' } }));
    assert.equal(byCustomer.status, 403);
    const anonymous = await h.create(req(undefined, { body: { name: 'X' } }));
    assert.equal(anonymous.status, 401);
    const bySuperAdmin = await h.create(req(superAdmin, { body: { name: 'SA Created' } }));
    assert.equal(bySuperAdmin.status, 201, 'PlatformSuperAdmin 允许');
  });
});

describe('GET /admin/customers（列表：游标分页 + 状态筛选）', () => {
  test('键集游标分页不重不漏；status 筛选生效', async () => {
    const h = handlers();
    const mine: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await h.create(req(operator, { body: { name: `Page Cust ${seq}-${i}` } }));
      mine.push((res.body as DataBody).data.id as string);
    }
    // 翻完所有页（其他用例的数据可能穿插），我的 5 条必须恰好各出现一次
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.list(req(auditor, { query: { limit: '2', ...(cursor ? { cursor } : {}) } }));
      assert.equal(page.status, 200);
      const body = page.body as { data: Array<{ id: string }>; meta: { nextCursor: string | null } };
      seen.push(...body.data.map((c) => c.id));
      cursor = body.meta.nextCursor ?? undefined;
    } while (cursor);
    const mineSeen = seen.filter((id) => mine.includes(id));
    assert.deepEqual([...mineSeen].sort(), [...mine].sort(), '分页覆盖我的全部记录且不重复');

    // status 筛选：停用其中一个后，SUSPENDED 筛出它且不含其余 ACTIVE
    const target = mine[0]!;
    await prisma.customer.update({ where: { id: target }, data: { status: 'SUSPENDED' } });
    const suspended = await h.list(req(operator, { query: { status: 'SUSPENDED', limit: '100' } }));
    const suspendedIds = (suspended.body as { data: Array<{ id: string }> }).data.map((c) => c.id);
    assert.ok(suspendedIds.includes(target));
    for (const id of mine.slice(1)) assert.ok(!suspendedIds.includes(id), 'ACTIVE 不应出现在 SUSPENDED 筛选');
  });

  test('非法 limit/status/游标 → 400；Customer 角色列表 → 403', async () => {
    const h = handlers();
    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { limit: 'abc' },
      { status: 'DELETED' },
      { cursor: '!!!' },
    ]) {
      const res = await h.list(req(operator, { query }));
      assert.equal(res.status, 400, `query=${JSON.stringify(query)} 必须 400`);
    }
    const byCustomer = await h.list(req(customerActor('cust-1'), {}));
    assert.equal(byCustomer.status, 403, 'Customer 角色无 customer:read，列表为平台视图');
  });
});

describe('GET /admin/customers/{customerId}（详情与跨 Customer 隔离）', () => {
  test('平台三角色可读任意；Customer 角色仅可读自身（跨 Customer 403）；不存在 404', async () => {
    const a = await plantCustomer();
    const b = await plantCustomer();
    const h = handlers();
    for (const actor of [superAdmin, operator, auditor]) {
      const res = await h.detail(req(actor, { params: { customerId: a.id } }));
      assert.equal(res.status, 200, `${actor.roles[0]} 可读任意 Customer`);
    }
    const self = await h.detail(req(customerActor(a.id), { params: { customerId: a.id } }));
    assert.equal(self.status, 200, 'Customer 角色读自身放行');
    assert.equal((self.body as DataBody).data.id, a.id);
    const cross = await h.detail(req(customerActor(a.id), { params: { customerId: b.id } }));
    assert.equal(cross.status, 403, 'Customer A 不可读 Customer B');
    assert.equal((cross.body as ErrorBody).error.code, 'FORBIDDEN');
    const missing = await h.detail(req(operator, { params: { customerId: 'cust-missing' } }));
    assert.equal(missing.status, 404);
  });
});

describe('PATCH /admin/customers/{customerId}（更新：If-Match 乐观锁）', () => {
  test('更新成功 version 自增 + 审计；If-Match 缺失 400；版本不符 409', async () => {
    const c = await plantCustomer();
    const h = handlers();

    const noIfMatch = await h.update(req(operator, { params: { customerId: c.id }, body: { name: 'N1' } }));
    assert.equal(noIfMatch.status, 400);
    assert.equal((noIfMatch.body as ErrorBody).error.code, 'VALIDATION_FAILED');

    const ok = await h.update(
      req(operator, { params: { customerId: c.id }, headers: { 'If-Match': '1' }, body: { name: 'N1' } }),
    );
    assert.equal(ok.status, 200);
    assert.equal((ok.body as DataBody).data.name, 'N1');
    assert.equal((ok.body as DataBody).data.version, 2, '版本自增');

    const stale = await h.update(
      req(operator, { params: { customerId: c.id }, headers: { 'If-Match': '1' }, body: { name: 'N2' } }),
    );
    assert.equal(stale.status, 409, '并发冲突：旧版本必须 409');
    assert.equal((stale.body as ErrorBody).error.code, 'VERSION_CONFLICT');

    const audits = await prisma.auditLog.findMany({ where: { objectId: c.id, action: 'customer.update' } });
    assert.equal(audits.filter((a) => a.result === 'SUCCESS').length, 1, '成功更新写 SUCCESS 审计');
    assert.equal(audits[0]?.actorId, 'op-1');

    const byAuditor = await h.update(
      req(auditor, { params: { customerId: c.id }, headers: { 'If-Match': '2' }, body: { name: 'N3' } }),
    );
    assert.equal(byAuditor.status, 403, 'Auditor 只读');
    const missing = await h.update(
      req(operator, { params: { customerId: 'cust-missing' }, headers: { 'If-Match': '1' }, body: { name: 'N' } }),
    );
    assert.equal(missing.status, 404);
  });
});

describe('POST /admin/customers/{customerId}/deactivate（停用）', () => {
  test('ACTIVE→SUSPENDED + 原因入审计；缺原因 400；重复停用 409', async () => {
    const c = await plantCustomer();
    const h = handlers();

    const noReason = await h.deactivate(
      req(operator, { params: { customerId: c.id }, headers: { 'If-Match': '1' }, body: {} }),
    );
    assert.equal(noReason.status, 400, '停用强制原因');

    const ok = await h.deactivate(
      req(operator, {
        params: { customerId: c.id },
        headers: { 'If-Match': '1' },
        body: { reason: 'arrears' },
      }),
    );
    assert.equal(ok.status, 200);
    assert.equal((ok.body as DataBody).data.status, 'SUSPENDED');
    assert.equal((ok.body as DataBody).data.version, 2);

    const audits = await prisma.auditLog.findMany({ where: { objectId: c.id, action: 'customer.deactivate' } });
    assert.equal(audits[0]?.reason, 'arrears', '原因写入审计');
    assert.equal(audits[0]?.result, 'SUCCESS');

    const again = await h.deactivate(
      req(operator, {
        params: { customerId: c.id },
        headers: { 'If-Match': '2' },
        body: { reason: 'again' },
      }),
    );
    assert.equal(again.status, 409, '重复停用返回明确冲突');
    assert.equal((again.body as ErrorBody).error.code, 'CONFLICT');
  });
});

describe('DELETE /admin/customers/{customerId}（受约束软删除）', () => {
  test('关联有效设备 → 409 明确错误且不删除', async () => {
    const c = await plantCustomer();
    await plantDevice(c.id, 'Active');
    const h = handlers();
    const res = await h.remove(req(operator, { params: { customerId: c.id }, headers: { 'If-Match': '1' } }));
    assert.equal(res.status, 409);
    const err = (res.body as ErrorBody).error;
    assert.equal(err.code, 'CONFLICT');
    assert.match(err.message, /active device/, '错误信息须明确指出设备约束');
    const row = await prisma.customer.findFirst({ where: { id: c.id, deletedAt: null } });
    assert.ok(row, '受约束拒绝后记录未删除');
  });

  test('关联有效 License → 409；Expired/Revoked License 与 Retired 设备不阻塞', async () => {
    const c1 = await plantCustomer();
    const d1 = await plantDevice(c1.id, 'Active');
    await plantLicense(c1.id, d1.id, 'Active');
    const blocked = await handlers().remove(
      req(operator, { params: { customerId: c1.id }, headers: { 'If-Match': '1' } }),
    );
    assert.equal(blocked.status, 409);
    assert.match((blocked.body as ErrorBody).error.message, /active device/);

    const c2 = await plantCustomer();
    const d2 = await plantDevice(c2.id, 'Retired');
    await plantLicense(c2.id, d2.id, 'Expired');
    await plantLicense(c2.id, d2.id, 'Revoked');
    const ok = await handlers().remove(req(operator, { params: { customerId: c2.id }, headers: { 'If-Match': '1' } }));
    assert.equal(ok.status, 200, 'Retired 设备 + 失效 License 不阻塞删除');
  });

  test('软删除成功：记录保留（非物理删除）+ 审计；后续详情 404、列表不可见、重复删除 404', async () => {
    const c = await plantCustomer();
    const h = handlers();
    const res = await h.remove(req(operator, { params: { customerId: c.id }, headers: { 'If-Match': '1' } }));
    assert.equal(res.status, 200);
    assert.equal((res.body as DataBody).data.version, 2);

    const physical = await prisma.customer.findFirst({ where: { id: c.id } });
    assert.ok(physical, 'V1 不做物理删除：行保留');
    assert.ok(physical.deletedAt !== null, 'deletedAt 已标记');

    const audits = await prisma.auditLog.findMany({ where: { objectId: c.id, action: 'customer.delete' } });
    assert.equal(audits.filter((a) => a.result === 'SUCCESS').length, 1);

    const detail = await h.detail(req(operator, { params: { customerId: c.id } }));
    assert.equal(detail.status, 404, '已删除 Customer 详情 404');
    const listed = await h.list(req(operator, { query: { limit: '100' } }));
    const ids = (listed.body as { data: Array<{ id: string }> }).data.map((x) => x.id);
    assert.ok(!ids.includes(c.id), '已删除 Customer 不出现在列表');
    const again = await h.remove(req(operator, { params: { customerId: c.id }, headers: { 'If-Match': '2' } }));
    assert.equal(again.status, 404, '重复删除 404');
  });

  test('删除同样强制 If-Match（缺失 400 / 版本不符 409）；Customer 角色 403', async () => {
    const c = await plantCustomer();
    const h = handlers();
    const noIfMatch = await h.remove(req(operator, { params: { customerId: c.id } }));
    assert.equal(noIfMatch.status, 400);
    const stale = await h.remove(req(operator, { params: { customerId: c.id }, headers: { 'If-Match': '99' } }));
    assert.equal(stale.status, 409);
    assert.equal((stale.body as ErrorBody).error.code, 'VERSION_CONFLICT');
    const byCustomer = await h.remove(
      req(customerActor(c.id), { params: { customerId: c.id }, headers: { 'If-Match': '1' } }),
    );
    assert.equal(byCustomer.status, 403, 'Customer 角色无写权限（即使自身）');
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('AdminCustomerError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_CUSTOMER_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('DTO 字段与 OpenAPI Customer 契约一致且不含 deletedAt', () => {
    const api = loadJson('admin-customer-api.json');
    const schema = api.components.schemas.Customer;
    const record: CustomerRecord = {
      id: 'cust-1',
      name: 'Acme',
      status: 'ACTIVE',
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    const dto = toCustomerDto(record);
    assert.deepEqual(Object.keys(dto).sort(), [...schema.required].sort());
    assert.ok(!('deletedAt' in dto), '软删除标记不对外暴露');
  });

  test('admin/customer 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/customer/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
