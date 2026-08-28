/**
 * BE-CUS-02 Site 管理 API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - CRUD：创建（201+审计+默认值）/详情（含设备数量）/更新（If-Match）/停用（强制原因）/软删除（记录保留）；
 * - 错误 Customer（不存在/已删除）创建 → 404；非法 IANA 时区 → 400；同 Customer 重名 → 409；
 * - 有关联设备删除 → 409 CONFLICT 明确错误；设备数量统计正确；
 * - Customer 角色：列表强制所属 Customer scope（指定他人 customerId → 403）、详情跨 Customer 403；
 * - 契约一致性：错误码对齐 CT-05 目录，DTO 字段对齐 OpenAPI，模块无 AWS 依赖。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { ADMIN_SITE_ERROR_HTTP_STATUS, createAdminSiteHandlers, toSiteDto } from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import type { SiteRecord } from '../src/admin/site/repository.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-28T13:00:00Z');

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
  return createAdminSiteHandlers({ client: prisma, now: () => NOW });
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
  return prisma.customer.create({ data: { name: `Customer SITE ${seq}` } });
}

async function plantDevice(customerId: string, siteId: string) {
  seq += 1;
  return prisma.device.create({
    data: {
      id: `dev-site-${seq}`,
      serialNumber: `SN-SITE-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId,
      siteId,
    },
  });
}

type DataBody = { data: Record<string, unknown>; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

describe('POST /admin/sites（创建）', () => {
  test('创建成功：201 + 默认值（ACTIVE/version=1/timezone=UTC）+ 审计 + deviceCount=0', async () => {
    const customer = await plantCustomer();
    const res = await handlers().create(
      req(operator, {
        body: {
          customerId: customer.id,
          name: '  上海总部  ',
          region: '华东',
          subregion: '上海',
          address: 'XX 路 1 号',
          timezone: 'Asia/Shanghai',
          contactName: '张三',
          contactPhone: '13800000000',
          contactEmail: 'ops@example.com',
        },
      }),
    );
    assert.equal(res.status, 201);
    const { data } = res.body as DataBody;
    assert.equal(data.name, '上海总部', '名称去首尾空白');
    assert.equal(data.status, 'ACTIVE');
    assert.equal(data.version, 1);
    assert.equal(data.timezone, 'Asia/Shanghai');
    assert.equal(data.deviceCount, 0);
    assert.equal(data.customerId, customer.id);

    const audits = await prisma.auditLog.findMany({
      where: { objectId: data.id as string, action: 'site.create' },
    });
    assert.equal(audits.length, 1, '每次创建写一条审计');
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.actorId, 'op-1');
    assert.equal(audits[0]?.customerId, customer.id);
  });

  test('错误 Customer（不存在/已软删除）→ 404；缺 customerId/name → 400', async () => {
    const h = handlers();
    const missing = await h.create(req(operator, { body: { customerId: 'cust-missing', name: 'S1' } }));
    assert.equal(missing.status, 404, 'Customer 不存在');
    assert.equal((missing.body as ErrorBody).error.code, 'NOT_FOUND');

    const deleted = await plantCustomer();
    await prisma.customer.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
    const softDeleted = await h.create(req(operator, { body: { customerId: deleted.id, name: 'S2' } }));
    assert.equal(softDeleted.status, 404, '已删除 Customer 视为错误 Customer');

    for (const body of [{ name: 'S' }, { customerId: deleted.id }, { customerId: '', name: 'S' }]) {
      const res = await h.create(req(operator, { body }));
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 必须 400`);
    }
  });

  test('非法 IANA 时区 → 400；合法时区通过；缺省时区默认 UTC', async () => {
    const customer = await plantCustomer();
    const h = handlers();
    for (const tz of ['Mars/Olympus', 'UTC+8', 'GMT+08:00', '北京']) {
      const res = await h.create(req(operator, { body: { customerId: customer.id, name: `TZ ${tz}`, timezone: tz } }));
      assert.equal(res.status, 400, `timezone=${tz} 必须 400`);
      assert.equal((res.body as ErrorBody).error.code, 'VALIDATION_FAILED');
    }
    const ok = await h.create(
      req(operator, { body: { customerId: customer.id, name: 'TZ ok', timezone: 'America/New_York' } }),
    );
    assert.equal(ok.status, 201);
    const defaulted = await h.create(req(operator, { body: { customerId: customer.id, name: 'TZ default' } }));
    assert.equal((defaulted.body as DataBody).data.timezone, 'UTC');
  });

  test('同 Customer 重名 → 409；不同 Customer 可重名；Auditor/Customer 角色/未认证 → 403/401', async () => {
    const a = await plantCustomer();
    const b = await plantCustomer();
    const h = handlers();
    const first = await h.create(req(operator, { body: { customerId: a.id, name: 'Dup' } }));
    assert.equal(first.status, 201);
    const dup = await h.create(req(operator, { body: { customerId: a.id, name: 'Dup' } }));
    assert.equal(dup.status, 409);
    assert.equal((dup.body as ErrorBody).error.code, 'CONFLICT');
    const otherCustomer = await h.create(req(operator, { body: { customerId: b.id, name: 'Dup' } }));
    assert.equal(otherCustomer.status, 201, '名称唯一性限定在 Customer 内');

    assert.equal((await h.create(req(auditor, { body: { customerId: a.id, name: 'X' } }))).status, 403);
    assert.equal((await h.create(req(customerActor(a.id), { body: { customerId: a.id, name: 'X' } }))).status, 403);
    assert.equal((await h.create(req(undefined, { body: { customerId: a.id, name: 'X' } }))).status, 401);
  });
});

describe('GET /admin/sites（列表：筛选 + 游标分页 + 设备数量）', () => {
  test('customerId/region/subregion/status 筛选；分页不重不漏；deviceCount 统计正确', async () => {
    const a = await plantCustomer();
    const b = await plantCustomer();
    const h = handlers();
    const mk = async (customerId: string, name: string, region: string, subregion: string) => {
      const res = await h.create(req(operator, { body: { customerId, name, region, subregion } }));
      return (res.body as DataBody).data.id as string;
    };
    const a1 = await mk(a.id, 'A1 华东上海', '华东', '上海');
    const a2 = await mk(a.id, 'A2 华东杭州', '华东', '杭州');
    const a3 = await mk(a.id, 'A3 华南深圳', '华南', '深圳');
    await mk(b.id, 'B1 华东上海', '华东', '上海');

    // deviceCount：a1 挂 2 台设备
    await plantDevice(a.id, a1);
    await plantDevice(a.id, a1);
    const detail = await h.detail(req(operator, { params: { siteId: a1 } }));
    assert.equal((detail.body as DataBody).data.deviceCount, 2, '设备数量统计正确');
    const inList = await h.list(req(operator, { query: { customerId: a.id, region: '华东' } }));
    const row = (inList.body as { data: Array<{ id: string; deviceCount: number }> }).data.find((s) => s.id === a1);
    assert.equal(row?.deviceCount, 2, '列表同样返回设备数量（无 N+1 语义差异）');

    // 筛选组合
    const byCustomer = await h.list(req(operator, { query: { customerId: a.id, limit: '100' } }));
    const aIds = (byCustomer.body as { data: Array<{ id: string }> }).data.map((s) => s.id);
    assert.deepEqual([...aIds].sort(), [a1, a2, a3].sort());
    const byRegion = await h.list(req(operator, { query: { customerId: a.id, region: '华南' } }));
    assert.deepEqual(
      (byRegion.body as { data: Array<{ id: string }> }).data.map((s) => s.id),
      [a3],
    );
    const bySub = await h.list(req(operator, { query: { region: '华东', subregion: '上海', limit: '100' } }));
    const subIds = (bySub.body as { data: Array<{ id: string }> }).data.map((s) => s.id);
    assert.ok(subIds.includes(a1) && !subIds.includes(a2), 'subregion 精确筛选');

    // status 筛选 + 分页（a3 停用后）
    await prisma.site.update({ where: { id: a3 }, data: { status: 'SUSPENDED' } });
    const suspended = await h.list(req(operator, { query: { customerId: a.id, status: 'SUSPENDED' } }));
    assert.deepEqual(
      (suspended.body as { data: Array<{ id: string }> }).data.map((s) => s.id),
      [a3],
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await h.list(
        req(operator, { query: { customerId: a.id, limit: '2', ...(cursor ? { cursor } : {}) } }),
      );
      const body = page.body as { data: Array<{ id: string }>; meta: { nextCursor: string | null } };
      seen.push(...body.data.map((s) => s.id));
      cursor = body.meta.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual([...seen].sort(), [a1, a2, a3].sort(), '分页覆盖全部且不重复');
  });

  test('Customer 角色：列表强制所属 Customer；指定他人 customerId → 403', async () => {
    const a = await plantCustomer();
    const b = await plantCustomer();
    const h = handlers();
    await h.create(req(operator, { body: { customerId: a.id, name: 'SiteA' } }));
    await h.create(req(operator, { body: { customerId: b.id, name: 'SiteB' } }));

    const ownList = await h.list(req(customerActor(a.id), { query: { limit: '100' } }));
    const names = (ownList.body as { data: Array<{ name: string }> }).data.map((s) => s.name);
    assert.ok(names.includes('SiteA') && !names.includes('SiteB'), 'Customer 角色仅见本 Customer 站点');

    const cross = await h.list(req(customerActor(a.id), { query: { customerId: b.id } }));
    assert.equal(cross.status, 403, '指定他人 customerId 拒绝');
    assert.equal((cross.body as ErrorBody).error.code, 'FORBIDDEN');
  });

  test('详情：Customer 角色读本 Customer 站点 200、跨 Customer 403；不存在 404', async () => {
    const a = await plantCustomer();
    const b = await plantCustomer();
    const h = handlers();
    const siteA = (await h.create(req(operator, { body: { customerId: a.id, name: 'S-A' } }))).body as DataBody;
    const siteB = (await h.create(req(operator, { body: { customerId: b.id, name: 'S-B' } }))).body as DataBody;

    const self = await h.detail(req(customerActor(a.id), { params: { siteId: siteA.data.id as string } }));
    assert.equal(self.status, 200);
    const cross = await h.detail(req(customerActor(a.id), { params: { siteId: siteB.data.id as string } }));
    assert.equal(cross.status, 403);
    const byAuditor = await h.detail(req(auditor, { params: { siteId: siteB.data.id as string } }));
    assert.equal(byAuditor.status, 200, 'Auditor 平台只读任意 Site');
    const missing = await h.detail(req(operator, { params: { siteId: 'site-missing' } }));
    assert.equal(missing.status, 404);
  });
});

describe('PATCH /admin/sites/{siteId}（更新）', () => {
  test('字段更新 + version 自增 + 审计；customerId 不可变/空体/非法时区 → 400；版本冲突 409', async () => {
    const customer = await plantCustomer();
    const h = handlers();
    const created = (await h.create(req(operator, { body: { customerId: customer.id, name: 'Up' } }))).body as DataBody;
    const siteId = created.data.id as string;

    const noIfMatch = await h.update(req(operator, { params: { siteId }, body: { name: 'N1' } }));
    assert.equal(noIfMatch.status, 400);
    const immutable = await h.update(
      req(operator, { params: { siteId }, headers: { 'If-Match': '1' }, body: { customerId: 'other', name: 'N1' } }),
    );
    assert.equal(immutable.status, 400, 'customerId 不可变');
    const empty = await h.update(req(operator, { params: { siteId }, headers: { 'If-Match': '1' }, body: {} }));
    assert.equal(empty.status, 400, '至少一个可更新字段');
    const badTz = await h.update(
      req(operator, { params: { siteId }, headers: { 'If-Match': '1' }, body: { timezone: 'UTC+8' } }),
    );
    assert.equal(badTz.status, 400, '非法时区');

    const ok = await h.update(
      req(operator, {
        params: { siteId },
        headers: { 'If-Match': '1' },
        body: { name: 'N1', region: '华北', contactEmail: 'site@example.com', address: null },
      }),
    );
    assert.equal(ok.status, 200);
    assert.equal((ok.body as DataBody).data.version, 2);
    assert.equal((ok.body as DataBody).data.region, '华北');
    assert.equal((ok.body as DataBody).data.address, null, 'null 清除可空字段');

    const stale = await h.update(
      req(operator, { params: { siteId }, headers: { 'If-Match': '1' }, body: { name: 'N2' } }),
    );
    assert.equal(stale.status, 409);
    assert.equal((stale.body as ErrorBody).error.code, 'VERSION_CONFLICT');

    const audits = await prisma.auditLog.findMany({ where: { objectId: siteId, action: 'site.update' } });
    assert.equal(audits.filter((x) => x.result === 'SUCCESS').length, 1);
  });
});

describe('POST /admin/sites/{siteId}/deactivate（停用）', () => {
  test('ACTIVE→SUSPENDED + 原因入审计；缺原因 400；重复停用 409', async () => {
    const customer = await plantCustomer();
    const h = handlers();
    const created = (await h.create(req(operator, { body: { customerId: customer.id, name: 'Deact' } })))
      .body as DataBody;
    const siteId = created.data.id as string;

    const noReason = await h.deactivate(req(operator, { params: { siteId }, headers: { 'If-Match': '1' }, body: {} }));
    assert.equal(noReason.status, 400);

    const ok = await h.deactivate(
      req(operator, { params: { siteId }, headers: { 'If-Match': '1' }, body: { reason: 'site closed' } }),
    );
    assert.equal(ok.status, 200);
    assert.equal((ok.body as DataBody).data.status, 'SUSPENDED');
    const audits = await prisma.auditLog.findMany({ where: { objectId: siteId, action: 'site.deactivate' } });
    assert.equal(audits[0]?.reason, 'site closed');

    const again = await h.deactivate(
      req(operator, { params: { siteId }, headers: { 'If-Match': '2' }, body: { reason: 'again' } }),
    );
    assert.equal(again.status, 409);
    assert.equal((again.body as ErrorBody).error.code, 'CONFLICT');
  });
});

describe('DELETE /admin/sites/{siteId}（受约束软删除）', () => {
  test('有关联设备 → 409 明确错误且不删除；无设备 → 软删除（行保留）+ 审计 + 后续 404/不可见', async () => {
    const customer = await plantCustomer();
    const h = handlers();
    const withDevice = (await h.create(req(operator, { body: { customerId: customer.id, name: 'HasDev' } })))
      .body as DataBody;
    const blockedId = withDevice.data.id as string;
    await plantDevice(customer.id, blockedId);

    const blocked = await h.remove(req(operator, { params: { siteId: blockedId }, headers: { 'If-Match': '1' } }));
    assert.equal(blocked.status, 409, '有关联设备删除失败');
    const err = (blocked.body as ErrorBody).error;
    assert.equal(err.code, 'CONFLICT');
    assert.match(err.message, /device/, '错误信息须明确指出设备约束');
    assert.ok(await prisma.site.findFirst({ where: { id: blockedId, deletedAt: null } }), '拒绝后未删除');

    const clean = (await h.create(req(operator, { body: { customerId: customer.id, name: 'Clean' } })))
      .body as DataBody;
    const cleanId = clean.data.id as string;
    const noIfMatch = await h.remove(req(operator, { params: { siteId: cleanId } }));
    assert.equal(noIfMatch.status, 400);
    const ok = await h.remove(req(operator, { params: { siteId: cleanId }, headers: { 'If-Match': '1' } }));
    assert.equal(ok.status, 200);

    const physical = await prisma.site.findFirst({ where: { id: cleanId } });
    assert.ok(physical && physical.deletedAt !== null, 'V1 不做物理删除：行保留 + deletedAt 标记');
    const audits = await prisma.auditLog.findMany({ where: { objectId: cleanId, action: 'site.delete' } });
    assert.equal(audits.filter((x) => x.result === 'SUCCESS').length, 1);

    assert.equal((await h.detail(req(operator, { params: { siteId: cleanId } }))).status, 404);
    const listed = await h.list(req(operator, { query: { customerId: customer.id, limit: '100' } }));
    assert.ok(!(listed.body as { data: Array<{ id: string }> }).data.some((s) => s.id === cleanId), '列表不可见');
    const again = await h.remove(req(operator, { params: { siteId: cleanId }, headers: { 'If-Match': '2' } }));
    assert.equal(again.status, 404, '重复删除 404');
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('AdminSiteError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_SITE_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('DTO 字段与 OpenAPI Site 契约一致且不含 deletedAt', () => {
    const api = loadJson('admin-site-api.json');
    const schema = api.components.schemas.Site;
    const record: SiteRecord = {
      id: 'site-1',
      customerId: 'cust-1',
      name: 'S',
      status: 'ACTIVE',
      region: null,
      subregion: null,
      address: null,
      timezone: 'UTC',
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      _count: { devices: 3 },
    };
    const dto = toSiteDto(record);
    assert.deepEqual(Object.keys(dto).sort(), [...schema.required].sort());
    assert.equal(dto.deviceCount, 3);
    assert.ok(!('deletedAt' in dto), '软删除标记不对外暴露');
  });

  test('admin/site 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/site/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});
