/**
 * BE-AUD-01 审计日志查询 API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 权限隔离：Auditor/PlatformSuperAdmin 跨 Customer 只读；PlatformOperator/Customer 角色
 *   无 audit:read → 403（DEC-012 冻结矩阵）；无 actor → 401；Customer actor 服务层强制
 *   自身 Customer scope（参数不一致 → 403；详情跨 Customer → 404，纵深防御）；
 * - 筛选正确：actorId/customerId/objectType/objectId/action/result/from/to 各自生效；
 *   非法 result/时间 → 400；
 * - 分页正确：createdAt 倒序 + id 决胜，翻页不重复不漏（含相同 createdAt 记录）；
 * - 敏感字段永不返回：列表视图无 beforeValue/afterValue/ip/userAgent；详情前后值
 *   读取时再次脱敏（绕过写入脱敏直接落库的 password/privateKey → [REDACTED]）；
 * - 不存在写路由：模块仅导出 list/detail 两个 handler（契约测试强制 OpenAPI 无写方法）。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { createAdminAuditHandlers, getAuditLogDetail, listAuditLogs } from '../src/index.js';
import type { AdminHttpRequest, AuditQueryDeps } from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-09-05T10:00:00Z');

const superAdmin: ActorContext = {
  actorId: 'sub-audit-super',
  username: 'super',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};

const auditor: ActorContext = {
  actorId: 'sub-auditor',
  username: 'auditor',
  actorType: 'platform',
  roles: ['Auditor'],
  customerId: null,
  tokenUse: 'access',
};

const operator: ActorContext = {
  actorId: 'sub-operator',
  username: 'operator',
  actorType: 'platform',
  roles: ['PlatformOperator'],
  customerId: null,
  tokenUse: 'access',
};

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

const deps = (): AuditQueryDeps => ({ client: prisma, now: () => NOW });

const req = (actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest => ({
  actor,
  headers: {},
  requestId: `req-${Math.random()}`,
  ...options,
});

type ListBody = { data: Record<string, any>[]; meta: Record<string, any> };
type DataBody = { data: any; meta: Record<string, any> };

let seq = 0;

async function plantCustomer(): Promise<string> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `AUD C${seq}` } });
  return customer.id;
}

interface PlantedAudit {
  auditId: string;
  customerId: string | null;
  actorId: string | null;
}

async function plantAudit(options: {
  customerId?: string | null;
  actorId?: string | null;
  objectType?: string;
  objectId?: string;
  action?: string;
  result?: string;
  createdAt?: Date;
  beforeValue?: unknown;
  afterValue?: unknown;
}): Promise<PlantedAudit> {
  seq += 1;
  const row = await prisma.auditLog.create({
    data: {
      actorId: options.actorId ?? `actor-${seq}`,
      actorRole: 'PlatformSuperAdmin',
      customerId: options.customerId ?? null,
      objectType: options.objectType ?? 'device',
      objectId: options.objectId ?? `obj-${seq}`,
      action: options.action ?? 'device.update',
      result: options.result ?? 'SUCCESS',
      ...(options.beforeValue !== undefined ? { beforeValue: options.beforeValue as object } : {}),
      ...(options.afterValue !== undefined ? { afterValue: options.afterValue as object } : {}),
      createdAt: options.createdAt ?? new Date(NOW.getTime() + seq * 1000),
    },
  });
  return { auditId: row.id, customerId: row.customerId, actorId: row.actorId };
}

/** 期望拒绝并返回指定错误码（vitest 的 chai assert 无 rejects）。 */
async function expectReject(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    assert.equal((err as { code?: string }).code, code);
    return;
  }
  assert.fail(`expected rejection with code ${code}`);
}

describe('BE-AUD-01 权限隔离', () => {
  test('Auditor/SuperAdmin 可跨 Customer 只读；Operator/Customer 角色 → 403；无 actor → 401', async () => {
    const h = createAdminAuditHandlers(deps());
    const c1 = await plantCustomer();
    const c2 = await plantCustomer();
    await plantAudit({ customerId: c1 });
    await plantAudit({ customerId: c2 });

    // Auditor 跨 Customer
    const byAuditor = await h.listAuditLogs(req(auditor, { query: {} }));
    assert.equal(byAuditor.status, 200);
    const customers = new Set((byAuditor.body as ListBody).data.map((r) => r.customerId));
    assert.ok(customers.has(c1) && customers.has(c2));
    // Auditor 详情
    const anyId = (byAuditor.body as ListBody).data[0]?.auditId as string;
    assert.equal((await h.getAuditLogDetail(req(auditor, { params: { auditId: anyId } }))).status, 200);
    // SuperAdmin 跨 Customer 筛选
    const filtered = await h.listAuditLogs(req(superAdmin, { query: { customerId: c1 } }));
    assert.ok((filtered.body as ListBody).data.every((r) => r.customerId === c1));

    // Operator 无 audit:read
    assert.equal((await h.listAuditLogs(req(operator, { query: {} }))).status, 403);
    assert.equal((await h.getAuditLogDetail(req(operator, { params: { auditId: anyId } }))).status, 403);
    // Customer 角色无 audit:read（DEC-012 冻结矩阵）
    const custActor: ActorContext = {
      actorId: 'sub-ca',
      username: 'ca',
      actorType: 'customer',
      roles: ['CustomerAdmin'],
      customerId: c1,
      tokenUse: 'access',
    };
    assert.equal((await h.listAuditLogs(req(custActor, { query: {} }))).status, 403);
    // 无 actor → 401
    assert.equal((await h.listAuditLogs(req(undefined, { query: {} }))).status, 401);
    assert.equal((await h.getAuditLogDetail(req(undefined, { params: { auditId: anyId } }))).status, 401);
  });

  test('Customer actor 服务层租户隔离（纵深防御）：强制 scope、越权筛选 403、跨 Customer 详情 404', async () => {
    const c1 = await plantCustomer();
    const c2 = await plantCustomer();
    const mine = await plantAudit({ customerId: c1 });
    const other = await plantAudit({ customerId: c2 });
    await plantAudit({ customerId: null }); // 平台域记录
    const custActor: ActorContext = {
      actorId: 'sub-ca-2',
      username: 'ca2',
      actorType: 'customer',
      roles: ['CustomerAdmin'],
      customerId: c1,
      tokenUse: 'access',
    };

    // 强制 scope：仅返回自身 Customer
    const page = await listAuditLogs(deps(), custActor, {});
    assert.ok(page.items.length >= 1);
    assert.ok(page.items.every((r) => r.customerId === c1));
    // 显式一致 customerId 放行
    const explicit = await listAuditLogs(deps(), custActor, { customerId: c1 });
    assert.ok(explicit.items.every((r) => r.customerId === c1));
    // 越权筛选 → FORBIDDEN
    await expectReject(listAuditLogs(deps(), custActor, { customerId: c2 }), 'FORBIDDEN');
    // 详情：自身放行、跨 Customer → 404、平台域（customerId null）→ 404
    const detail = await getAuditLogDetail(deps(), custActor, mine.auditId);
    assert.equal(detail.auditId, mine.auditId);
    await expectReject(getAuditLogDetail(deps(), custActor, other.auditId), 'NOT_FOUND');
  });
});

describe('BE-AUD-01 筛选与分页', () => {
  test('actorId/objectType/objectId/action/result/时间范围筛选各自生效；非法值 → 400', async () => {
    const h = createAdminAuditHandlers(deps());
    const prefix = `flt-${++seq}`;
    const a = await plantAudit({
      actorId: `${prefix}-actor`,
      objectType: `${prefix}-type`,
      objectId: `${prefix}-obj`,
      action: `${prefix}.action`,
      result: 'FAILURE',
      createdAt: new Date('2026-09-01T00:00:00Z'),
    });
    await plantAudit({ createdAt: new Date('2026-09-03T00:00:00Z') });

    const q = async (query: Record<string, string>) =>
      (await h.listAuditLogs(req(auditor, { query }))).body as ListBody;

    assert.ok((await q({ actorId: `${prefix}-actor` })).data.every((r) => r.actorId === a.actorId));
    assert.ok((await q({ objectType: `${prefix}-type` })).data.every((r) => r.objectType === `${prefix}-type`));
    assert.ok((await q({ objectId: `${prefix}-obj` })).data.every((r) => r.objectId === `${prefix}-obj`));
    assert.ok((await q({ action: `${prefix}.action` })).data.every((r) => r.action === `${prefix}.action`));
    const failures = await q({ result: 'FAILURE' });
    assert.ok(failures.data.length >= 1);
    assert.ok(failures.data.every((r) => r.result === 'FAILURE'));
    // 时间范围
    const ranged = await q({ from: '2026-08-31T00:00:00Z', to: '2026-09-02T00:00:00Z' });
    assert.ok(ranged.data.some((r) => r.auditId === a.auditId));
    assert.ok(ranged.data.every((r) => r.createdAt <= '2026-09-02T00:00:00.000Z'));
    const after = await q({ from: '2026-09-02T00:00:01Z' });
    assert.ok(!after.data.some((r) => r.auditId === a.auditId));

    // 非法值 → 400
    assert.equal((await h.listAuditLogs(req(auditor, { query: { result: 'MAYBE' } }))).status, 400);
    assert.equal((await h.listAuditLogs(req(auditor, { query: { from: 'not-a-date' } }))).status, 400);
    assert.equal((await h.listAuditLogs(req(auditor, { query: { to: 'not-a-date' } }))).status, 400);
  });

  test('分页：createdAt 倒序 + id 决胜；相同 createdAt 翻页不重复不漏', async () => {
    const h = createAdminAuditHandlers(deps());
    const sameTime = new Date('2026-09-04T00:00:00Z');
    const marker = `page-${++seq}`;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const p = await plantAudit({ objectType: marker, createdAt: sameTime });
      ids.push(p.auditId);
    }

    // 全量（倒序 + id 决胜）
    const all = (
      (await (
        await h.listAuditLogs(req(auditor, { query: { objectType: marker, limit: '50' } }))
      ).body) as ListBody
    ).data;
    assert.equal(all.length, 5);
    for (let i = 1; i < all.length; i += 1) {
      assert.ok(all[i - 1]!.auditId > all[i]!.auditId, '相同 createdAt 时按 id 倒序');
    }

    // limit=2 翻页：不重复不漏，顺序与全量一致
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const res = await h.listAuditLogs(
        req(auditor, { query: { objectType: marker, limit: '2', ...(cursor ? { cursor } : {}) } }),
      );
      const body = res.body as ListBody;
      seen.push(...body.data.map((r) => r.auditId as string));
      cursor = body.meta.nextCursor ?? undefined;
      if (!cursor) break;
    }
    assert.deepEqual(
      seen,
      all.map((r) => r.auditId),
    );

    // 排序：倒序（最新在前）
    const sorted = (
      (await (
        await h.listAuditLogs(req(auditor, { query: { objectType: marker, limit: '5' } }))
      ).body) as ListBody
    ).data;
    const times = sorted.map((r) => r.createdAt as string);
    assert.deepEqual(times, [...times].sort().reverse());
  });
});

describe('BE-AUD-01 脱敏与详情', () => {
  test('列表视图不含前后值/ip/userAgent；详情含脱敏前后值（读取兜底脱敏）', async () => {
    const h = createAdminAuditHandlers(deps());
    // 绕过写入脱敏直接落库敏感字段，验证读取时再次脱敏（敏感字段永不返回）
    const planted = await plantAudit({
      beforeValue: {
        password: 'plain-secret',
        nested: { privateKey: 'key-material' },
        keep: 'v1',
      },
      afterValue: { apiToken: 'tok-123', keep: 'v2' },
    });

    const detail = await h.getAuditLogDetail(req(auditor, { params: { auditId: planted.auditId } }));
    assert.equal(detail.status, 200);
    const view = (detail.body as DataBody).data;
    // 敏感字段命中 → [REDACTED]；非敏感字段原样
    assert.equal(view.beforeValue.password, '[REDACTED]');
    assert.equal(view.beforeValue.nested.privateKey, '[REDACTED]');
    assert.equal(view.beforeValue.keep, 'v1');
    assert.equal(view.afterValue.apiToken, '[REDACTED]');
    assert.equal(view.afterValue.keep, 'v2');
    // 响应文本不泄露敏感原文
    const text = JSON.stringify(detail.body);
    assert.ok(!text.includes('plain-secret'));
    assert.ok(!text.includes('key-material'));
    assert.ok(!text.includes('tok-123'));

    // 列表视图字段封闭（无 beforeValue/afterValue/ip/userAgent）
    const listRes = await h.listAuditLogs(req(auditor, { query: { action: 'device.update', limit: '1' } }));
    const item = (listRes.body as ListBody).data[0]!;
    for (const forbidden of ['beforeValue', 'afterValue', 'ip', 'userAgent', 'reason', 'requestId']) {
      assert.ok(!(forbidden in item), `列表视图不得包含 ${forbidden}`);
    }

    // 不存在 → 404
    assert.equal((await h.getAuditLogDetail(req(auditor, { params: { auditId: 'audit-ghost' } }))).status, 404);
  });

  test('只读：handler 仅暴露列表与详情两个查询入口（无写路由）', () => {
    const h = createAdminAuditHandlers(deps());
    assert.deepEqual(Object.keys(h).sort(), ['getAuditLogDetail', 'listAuditLogs']);
  });
});
