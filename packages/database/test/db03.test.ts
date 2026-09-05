/**
 * DOM-03 审计写入库集成测试。
 * 验收基准：审计记录不能通过业务 Repository 更新/删除；敏感字段 0 泄露；
 * 业务事务失败记录失败结果但不伪造成功状态。
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '../src/generated/client.js';
import { readAllMigrationSql } from './helpers.js';
import {
  AppendOnlyViolationError,
  DbError,
  REDACTED,
  audited,
  mapDbErrorToHttp,
  recordAudit,
  runWithContext,
  sanitizeAuditPayload,
  scopedRepository,
  withTransaction,
} from '../src/index.js';

let pg: PGlite;
let prisma: PrismaClient;

beforeAll(async () => {
  pg = new PGlite({ extensions: { btree_gist } });
  await pg.exec(readAllMigrationSql());
  prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

describe('脱敏器', () => {
  test('私钥、Token、passwordHash、verifier 等字段被遮蔽（含嵌套与数组）', () => {
    const privateKeyBlock = ['-----BEGIN ', 'PRIVATE KEY-----\nsecret\n-----END ', 'PRIVATE KEY-----'].join('');
    const rsaPrivateKeyBlock = ['-----BEGIN RSA ', 'PRIVATE KEY-----\nsecret\n-----END RSA ', 'PRIVATE KEY-----'].join(
      '',
    );
    const dirty = {
      name: '正常字段',
      privateKey: '-----BEGIN PRIVATE',
      onboarding: { tokenHash: 'hash-value', token: 'plain-token' },
      users: [{ passwordHash: 'x'.repeat(60), username: 'op1' }],
      verifierValue: 'device-local-verifier',
      bundle: { apiKey: 'k', pem: 'public-cert-ok' },
      transport: { pem: privateKeyBlock },
      material: rsaPrivateKeyBlock,
    };
    const clean = sanitizeAuditPayload(dirty) as Record<string, any>;
    expect(clean.name).toBe('正常字段');
    expect(clean.privateKey).toBe(REDACTED);
    expect(clean.onboarding).toEqual({ tokenHash: REDACTED, token: REDACTED });
    expect(clean.users[0]).toEqual({ passwordHash: REDACTED, username: 'op1' });
    expect(clean.verifierValue).toBe(REDACTED);
    expect(clean.bundle.apiKey).toBe(REDACTED);
    expect(clean.bundle.pem).toBe('public-cert-ok');
    expect(clean.transport.pem).toBe(REDACTED);
    expect(clean.material).toBe(REDACTED);

    // 0 泄露：序列化后不含任何敏感值
    const serialized = JSON.stringify(clean);
    for (const sensitive of [
      '-----BEGIN PRIVATE',
      'hash-value',
      'plain-token',
      'x'.repeat(60),
      'device-local-verifier',
      privateKeyBlock,
      rsaPrivateKeyBlock,
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  test('标量与 null 原样返回', () => {
    expect(sanitizeAuditPayload(null)).toBeNull();
    expect(sanitizeAuditPayload('文本')).toBe('文本');
    expect(sanitizeAuditPayload(42)).toBe(42);
  });
});

describe('recordAudit 与上下文', () => {
  test('actor/requestId 默认取 AsyncLocalStorage 上下文，显式传参优先', async () => {
    await runWithContext({ requestId: 'req-ctx', actorId: 'admin-ctx', actorRole: 'PlatformSuperAdmin' }, async () => {
      await recordAudit(prisma, {
        objectType: 'device',
        objectId: 'dev-1',
        action: 'device.lifecycle.Active_to_Suspended',
        result: 'SUCCESS',
        reason: '安全调查',
        afterValue: { status: 'Suspended', privateKey: 'must-be-redacted' },
      });
    });
    const row = await prisma.auditLog.findFirstOrThrow({ where: { requestId: 'req-ctx' } });
    expect(row.actorId).toBe('admin-ctx');
    expect(row.actorRole).toBe('PlatformSuperAdmin');
    expect(row.result).toBe('SUCCESS');
    expect(JSON.stringify(row.afterValue)).not.toContain('must-be-redacted');
    expect((row.afterValue as any).privateKey).toBe(REDACTED);
  });

  test('IP/User-Agent 默认取可信请求上下文，显式参数仍可覆盖', async () => {
    await runWithContext(
      {
        requestId: 'req-transport',
        actorId: 'admin-transport',
        ip: '203.0.113.10',
        userAgent: 'FDP-Admin/1.0',
      },
      async () => {
        await recordAudit(prisma, {
          objectType: 'device',
          objectId: 'dev-transport',
          action: 'device.update',
          result: 'SUCCESS',
        });
      },
    );
    const row = await prisma.auditLog.findFirstOrThrow({ where: { requestId: 'req-transport' } });
    expect(row.ip).toBe('203.0.113.10');
    expect(row.userAgent).toBe('FDP-Admin/1.0');
  });
});

describe('append-only：审计/历史表不可经业务 Repository 更新删除', () => {
  test('auditLog 的 updateWithVersion / softDelete 被拒绝', async () => {
    const repo = scopedRepository(prisma, 'auditLog');
    await expect(repo.updateWithVersion('x', 1, {}, { customerId: 'cust-a' })).rejects.toBeInstanceOf(
      AppendOnlyViolationError,
    );
    await expect(repo.softDelete('x', { customerId: 'cust-a' })).rejects.toBeInstanceOf(AppendOnlyViolationError);
    expect(mapDbErrorToHttp(new AppendOnlyViolationError('auditLog', 'update'))).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  test('deviceStateHistory / licenseHistory / otaStatusHistory 同样拦截', async () => {
    for (const model of ['deviceStateHistory', 'licenseHistory', 'otaStatusHistory', 'ingestionReceipt']) {
      const repo = scopedRepository(prisma, model);
      await expect(repo.updateWithVersion('x', 1, {}, { customerId: 'cust-a' })).rejects.toBeInstanceOf(
        AppendOnlyViolationError,
      );
    }
  });
});

describe('audited 拦截器', () => {
  test('成功路径：业务写入与 SUCCESS 审计同事务提交', async () => {
    await runWithContext({ requestId: 'req-ok', actorId: 'admin-1' }, async () => {
      await audited(prisma, { objectType: 'customer', objectId: 'cust-new', action: 'customer.create' }, async (tx) => {
        await tx.customer.create({ data: { id: 'cust-new', name: '新客户' } });
      });
    });
    expect(await prisma.customer.findUnique({ where: { id: 'cust-new' } })).not.toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { requestId: 'req-ok' } });
    expect(audit.result).toBe('SUCCESS');
    expect(audit.action).toBe('customer.create');
  });

  test('失败路径：业务回滚 + FAILURE 审计留存，不伪造成功；原错误抛出', async () => {
    const before = await prisma.customer.count();
    await expect(
      runWithContext({ requestId: 'req-fail', actorId: 'admin-1' }, async () => {
        await audited(
          prisma,
          { objectType: 'customer', objectId: 'cust-bad', action: 'customer.create' },
          async (tx) => {
            await tx.customer.create({ data: { id: 'cust-bad', name: '将回滚' } });
            throw new Error('业务约束失败');
          },
        );
      }),
    ).rejects.toThrow('业务约束失败');

    expect(await prisma.customer.count()).toBe(before);
    expect(await prisma.customer.findUnique({ where: { id: 'cust-bad' } })).toBeNull();

    const audits = await prisma.auditLog.findMany({ where: { requestId: 'req-fail' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.result).toBe('FAILURE');
    // 不存在伪造的 SUCCESS
    expect(audits.some((a) => a.result === 'SUCCESS')).toBe(false);
  });

  test('audited 成功与失败路径均继承 IP/User-Agent', async () => {
    const ctx = {
      actorId: 'admin-network',
      ip: '2001:db8::10',
      userAgent: 'Audit-Agent/2.0',
    };
    await runWithContext({ ...ctx, requestId: 'req-network-ok' }, () =>
      audited(prisma, { objectType: 'device', objectId: 'ok', action: 'device.test' }, async () => undefined),
    );
    await expect(
      runWithContext({ ...ctx, requestId: 'req-network-fail' }, () =>
        audited(prisma, { objectType: 'device', objectId: 'fail', action: 'device.test' }, async () => {
          throw new Error('expected failure');
        }),
      ),
    ).rejects.toThrow('expected failure');
    const rows = await prisma.auditLog.findMany({
      where: { requestId: { in: ['req-network-ok', 'req-network-fail'] } },
      orderBy: { requestId: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.ip === '2001:db8::10' && row.userAgent === 'Audit-Agent/2.0')).toBe(true);
  });

  test('audited 禁止在事务内嵌套调用', async () => {
    await expect(
      withTransaction(prisma, async (tx) => {
        await audited(tx, { objectType: 'x', objectId: 'y', action: 'z' }, async () => 1);
      }),
    ).rejects.toBeInstanceOf(DbError);
  });
});
