/**
 * DB-02 集成测试：事务、Customer scope Repository、乐观锁、游标分页、软删除、审计上下文。
 * 运行真实 PostgreSQL（PGlite）+ 实际 migration.sql + 生成的 Prisma Client。
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { readFileSync } from 'node:fs';
import { PrismaClient, type Prisma } from '../src/generated/client.js';
import {
  CursorInvalidError,
  RecordNotFoundError,
  ScopeRequiredError,
  SoftDeleteNotSupportedError,
  VersionConflictError,
  getRequestContext,
  mapDbErrorToHttp,
  platformRepository,
  runWithContext,
  scopedRepository,
  withTransaction,
} from '../src/index.js';

const MIGRATION_SQL = readFileSync(
  new URL('../prisma/migrations/20260826120000_init/migration.sql', import.meta.url),
  'utf8',
);

let pg: PGlite;
let prisma: PrismaClient;

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist } });
  await pg.exec(MIGRATION_SQL);
  await pg.exec(readFileSync(new URL('../prisma/seed.sql', import.meta.url), 'utf8'));
  prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
  await prisma.customer.create({ data: { id: 'cust-a', name: '客户A' } });
  await prisma.customer.create({ data: { id: 'cust-b', name: '客户B' } });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

async function insertDevice(id: string, serialNumber: string, customerId: string | null) {
  await prisma.device.create({
    data: {
      id,
      serialNumber,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01'),
      lifecycleStatus: 'Onboarded',
      customerId,
    },
  });
}

describe('Customer scope 强制', () => {
  test('缺少 scope 的查询/写入被拒绝（ScopeRequiredError → 403）', async () => {
    const repo = scopedRepository(prisma, 'device');
    await expect(repo.list(undefined as unknown as { customerId: string })).rejects.toBeInstanceOf(ScopeRequiredError);
    await expect(repo.list({ customerId: '' })).rejects.toBeInstanceOf(ScopeRequiredError);
    await expect(repo.findById('x', {} as { customerId: string })).rejects.toBeInstanceOf(ScopeRequiredError);
    await expect(repo.create({}, {} as { customerId: string })).rejects.toBeInstanceOf(ScopeRequiredError);
    expect(mapDbErrorToHttp(new ScopeRequiredError('device'))).toEqual({ status: 403, code: 'FORBIDDEN' });
  });

  test('scoped 查询只返回本 Customer 数据；平台接口显式跨 Customer', async () => {
    await insertDevice('dev-a1', 'SN-A1', 'cust-a');
    await insertDevice('dev-b1', 'SN-B1', 'cust-b');

    const repoA = scopedRepository(prisma, 'device');
    const pageA = await repoA.list({ customerId: 'cust-a' });
    expect(pageA.items.map((d) => d.id)).toEqual(['dev-a1']);

    // 越权：以 cust-a 的 scope 读 cust-b 的设备 → 不可见
    expect(await repoA.findById('dev-b1', { customerId: 'cust-a' })).toBeNull();

    const platform = platformRepository(prisma, 'device');
    expect((await platform.list()).items.length).toBeGreaterThanOrEqual(2);
    expect(await platform.findById('dev-b1')).not.toBeNull();
  });

  test('scoped create 自动注入 customerId', async () => {
    const repo = scopedRepository(prisma, 'device');
    const created = await repo.create(
      {
        id: 'dev-a2',
        serialNumber: 'SN-A2',
        model: 'BNX-100',
        hardwareVersion: 'HW1.0',
        manufacturer: 'Hiddenjoy',
        manufactureDate: new Date('2026-01-01'),
      },
      { customerId: 'cust-a' },
    );
    expect(created.customerId).toBe('cust-a');
  });
});

describe('乐观锁并发版本', () => {
  test('版本匹配更新成功并自增；版本冲突抛 VersionConflictError（→ 409）', async () => {
    const repo = scopedRepository(prisma, 'contract');
    const c = await prisma.contract.create({
      data: {
        contractNumber: 'C-LOCK-1',
        name: '合约',
        customerId: 'cust-a',
        startAt: new Date('2026-01-01'),
        endAt: new Date('2027-01-01'),
        createdBy: 'admin-1',
      },
    });
    expect(c.version).toBe(1);

    const updated = await repo.updateWithVersion(c.id, 1, { name: '合约V2' }, { customerId: 'cust-a' });
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('合约V2');

    try {
      await repo.updateWithVersion(c.id, 1, { name: '旧版本写入' }, { customerId: 'cust-a' });
      expect.unreachable('应抛 VersionConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(VersionConflictError);
      expect(mapDbErrorToHttp(err)).toEqual({ status: 409, code: 'VERSION_CONFLICT' });
    }
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })).name).toBe('合约V2');
  });

  test('scope 内不存在 → RecordNotFound（→ 404）；其他 Customer 的记录不可被更新', async () => {
    const repo = scopedRepository(prisma, 'contract');
    await expect(repo.updateWithVersion('ghost', 1, {}, { customerId: 'cust-a' })).rejects.toBeInstanceOf(
      RecordNotFoundError,
    );
    const c = await prisma.contract.findFirstOrThrow({ where: { contractNumber: 'C-LOCK-1' } });
    await expect(repo.updateWithVersion(c.id, 2, {}, { customerId: 'cust-b' })).rejects.toBeInstanceOf(
      RecordNotFoundError,
    );
    expect(mapDbErrorToHttp(new RecordNotFoundError('contract', 'x'))).toEqual({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('事务原子性', () => {
  test('事务内异常回滚全部写入，不产生部分数据', async () => {
    const before = await prisma.device.count();
    await expect(
      withTransaction(prisma, async (tx) => {
        await tx.device.create({
          data: {
            id: 'dev-tx-1',
            serialNumber: 'SN-TX-1',
            model: 'M',
            hardwareVersion: 'H',
            manufacturer: 'M',
            manufactureDate: new Date('2026-01-01'),
          },
        });
        throw new Error('模拟失败');
      }),
    ).rejects.toThrow('模拟失败');
    expect(await prisma.device.count()).toBe(before);
    expect(await prisma.device.findUnique({ where: { id: 'dev-tx-1' } })).toBeNull();
  });

  test('嵌套 withTransaction 复用外层事务，一并回滚', async () => {
    await expect(
      withTransaction(prisma, async (tx) => {
        await insertDeviceIn(tx, 'dev-tx-2', 'SN-TX-2');
        await withTransaction(tx, async (nested) => {
          await insertDeviceIn(nested, 'dev-tx-3', 'SN-TX-3');
          throw new Error('内层失败');
        });
      }),
    ).rejects.toThrow('内层失败');
    expect(await prisma.device.findUnique({ where: { id: 'dev-tx-2' } })).toBeNull();
    expect(await prisma.device.findUnique({ where: { id: 'dev-tx-3' } })).toBeNull();
  });

  async function insertDeviceIn(tx: Prisma.TransactionClient, id: string, serialNumber: string) {
    await tx.device.create({
      data: {
        id,
        serialNumber,
        model: 'M',
        hardwareVersion: 'H',
        manufacturer: 'M',
        manufactureDate: new Date('2026-01-01'),
      },
    });
  }
});

describe('游标分页', () => {
  test('键集游标遍历全部页且不重复不遗漏', async () => {
    const repo = scopedRepository(prisma, 'device');
    const seen: string[] = [];
    let cursor: string | null | undefined = null;
    do {
      const page: Awaited<ReturnType<typeof repo.list>> = await repo.list(
        { customerId: 'cust-a' },
        { cursor, limit: 1 },
      );
      seen.push(...page.items.map((d) => String(d.id)));
      cursor = page.nextCursor;
    } while (cursor);
    const all = (await repo.list({ customerId: 'cust-a' })).items.map((d) => String(d.id));
    expect(seen.sort()).toEqual(all.sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('非法游标抛 CursorInvalidError（→ 400 CURSOR_INVALID）；limit 超界被拒绝', async () => {
    const repo = scopedRepository(prisma, 'device');
    await expect(repo.list({ customerId: 'cust-a' }, { cursor: '!!!bad' })).rejects.toBeInstanceOf(CursorInvalidError);
    expect(mapDbErrorToHttp(new CursorInvalidError())).toEqual({ status: 400, code: 'CURSOR_INVALID' });
    await expect(repo.list({ customerId: 'cust-a' }, { limit: 0 })).rejects.toThrow(/limit/);
    await expect(repo.list({ customerId: 'cust-a' }, { limit: 101 })).rejects.toThrow(/limit/);
  });
});

describe('软删除策略', () => {
  test('sites 软删除后默认查询排除、可恢复；审计类表不支持软删除', async () => {
    const siteRepo = scopedRepository(prisma, 'site', { softDelete: true });
    const scope = { customerId: 'cust-a' };
    const site = await prisma.site.create({ data: { id: 'site-soft', customerId: 'cust-a', name: '软删除站点' } });

    await siteRepo.softDelete(site.id, scope);
    expect((await siteRepo.list(scope)).items.some((s) => s.id === site.id)).toBe(false);
    expect((await siteRepo.list(scope, {}, { includeDeleted: true })).items.some((s) => s.id === site.id)).toBe(true);

    await siteRepo.restore(site.id, scope);
    expect((await siteRepo.list(scope)).items.some((s) => s.id === site.id)).toBe(true);

    // 其他 Customer 不可软删除本站点
    await expect(siteRepo.softDelete(site.id, { customerId: 'cust-b' })).rejects.toBeInstanceOf(RecordNotFoundError);

    // 审计与历史表（无 deletedAt）不支持软删除
    await expect(scopedRepository(prisma, 'auditLog').softDelete('x', { customerId: 'cust-a' })).rejects.toBeInstanceOf(
      SoftDeleteNotSupportedError,
    );
  });
});

describe('审计上下文传递', () => {
  test('AsyncLocalStorage 上下文在事务与 Repository 调用链内可见', async () => {
    const ctx = { requestId: 'req-1', actorId: 'admin-1', actorRole: 'PlatformSuperAdmin' };
    const observed = await runWithContext(ctx, () =>
      withTransaction(prisma, async (tx) => {
        await tx.device.count();
        await Promise.resolve();
        return getRequestContext();
      }),
    );
    expect(observed).toEqual(ctx);
  });

  test('无上下文时返回空对象而非抛错', () => {
    expect(getRequestContext()).toEqual({});
  });
});
