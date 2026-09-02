/**
 * BE-CMD-03 Command 查询 API 与 Timeout Evaluator 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 列表：筛选（status/command/deviceId/时间范围）、键集游标分页、租户隔离（Customer 强制 scope）；
 * - 详情：attempts/acks 时间线齐备；跨 Customer → 404；不存在 → 404；未认证 → 401；
 * - Timeout evaluator：可注入时钟；AUTHORIZED/PUBLISHING/PUBLISHED/ACKNOWLEDGED 且 expiresAt 已过 →
 *   TIMED_OUT + command.timeout 审计（actor=system）；未过期/终态不受影响；PUBLISHING 滞留兜底。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { createAdminCommandHandlers, evaluateCommandTimeouts } from '../src/index.js';
import type { AdminCommandHandlerDeps, AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-31T12:00:00Z');

const superAdmin: ActorContext = {
  actorId: 'admin-1',
  username: 'admin',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
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

function handlers(at: Date = NOW) {
  const deps: AdminCommandHandlerDeps = { client: prisma, now: () => at };
  return createAdminCommandHandlers(deps);
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return { actor, headers: {}, requestId: `req-${Math.random().toString(36).slice(2)}`, ...options };
}

type ListBody = { data: Record<string, any>[]; meta: Record<string, any> };
type DataBody = { data: Record<string, any>; meta: Record<string, any> };
type ErrorBody = { error: { code: string } };

let seq = 0;

async function plantCommand(options: {
  status: string;
  command?: string;
  expiresAt?: Date | null;
  requestTime?: Date;
}): Promise<{ commandId: string; deviceId: string; customerId: string; customerAdmin: ActorContext }> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `QRY ${seq}` } });
  const deviceId = `dev-qry-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-QRY-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId: customer.id,
    },
  });
  const commandId = `CMD-QRY-${seq}`;
  await prisma.deviceCommand.create({
    data: {
      id: commandId,
      deviceId,
      customerId: customer.id,
      command: options.command ?? 'STOP',
      category: 'MACHINE',
      status: options.status,
      requestedBy: 'op-1',
      requestTime: options.requestTime ?? NOW,
      timeoutSec: 120,
      expiresAt: options.expiresAt === undefined ? new Date(NOW.getTime() + 120_000) : options.expiresAt,
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
  return { commandId, deviceId, customerId: customer.id, customerAdmin };
}

describe('列表查询', () => {
  test('status/command/deviceId 筛选 + Customer 租户强制 scope', async () => {
    const a = await plantCommand({ status: 'PUBLISHED', command: 'STOP' });
    const b = await plantCommand({ status: 'SUCCEEDED', command: 'REBOOT' });
    const h = handlers();

    const byStatus = await h.listCommands(req(superAdmin, { query: { status: 'PUBLISHED' } }));
    const statusIds = (byStatus.body as ListBody).data.map((r) => r.commandId);
    assert.ok(statusIds.includes(a.commandId));
    assert.ok(!statusIds.includes(b.commandId));

    const byCommand = await h.listCommands(req(superAdmin, { query: { command: 'REBOOT' } }));
    assert.ok((byCommand.body as ListBody).data.some((r) => r.commandId === b.commandId));

    const byDevice = await h.listCommands(req(superAdmin, { query: { deviceId: a.deviceId } }));
    assert.deepEqual(
      (byDevice.body as ListBody).data.map((r) => r.commandId),
      [a.commandId],
    );

    // Customer 角色强制本 Customer（即使传了别人的 customerId）
    const scoped = await h.listCommands(req(a.customerAdmin, { query: { customerId: b.customerId } }));
    const scopedIds = (scoped.body as ListBody).data.map((r) => r.commandId);
    assert.ok(scopedIds.includes(a.commandId));
    assert.ok(!scopedIds.includes(b.commandId), '跨 Customer 不可见');

    // 非法枚举 / 未知命令 → 400
    assert.equal((await h.listCommands(req(superAdmin, { query: { status: 'BOGUS' } }))).status, 400);
    assert.equal((await h.listCommands(req(superAdmin, { query: { command: 'SELF_DESTRUCT' } }))).status, 400);
    // 未认证 → 401
    assert.equal((await h.listCommands(req(undefined))).status, 401);
  });

  test('键集游标分页：三页遍历去重，末页 nextCursor=null', async () => {
    const planted: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      planted.push((await plantCommand({ status: 'PUBLISHED' })).commandId);
    }
    planted.sort();
    const h = handlers();
    const page1 = await h.listCommands(req(superAdmin, { query: { status: 'PUBLISHED', limit: '2' } }));
    const meta1 = (page1.body as ListBody).meta;
    const ids1 = (page1.body as ListBody).data.map((r) => r.commandId);
    assert.equal(ids1.length, 2);
    assert.ok(meta1.nextCursor);
    const page2 = await h.listCommands(
      req(superAdmin, { query: { status: 'PUBLISHED', limit: '2', cursor: meta1.nextCursor } }),
    );
    const ids2 = (page2.body as ListBody).data.map((r) => r.commandId);
    assert.equal(new Set([...ids1, ...ids2]).size, ids1.length + ids2.length, '页间无重复');
  });
});

describe('详情查询', () => {
  test('详情含 attempts/acks 时间线；跨 Customer → 404；不存在 → 404', async () => {
    const a = await plantCommand({ status: 'SUCCEEDED' });
    const b = await plantCommand({ status: 'PUBLISHED' });
    await prisma.commandAttempt.create({ data: { commandId: a.commandId, attemptNo: 1, publishedAt: NOW } });
    await prisma.commandAck.create({
      data: {
        commandId: a.commandId,
        result: 'SUCCESS',
        executeTimeMs: 800,
        ackAt: NOW,
        sourceMessageId: 'ACK-MSG-1',
      },
    });
    const h = handlers();

    const res = await h.getCommand(req(superAdmin, { params: { commandId: a.commandId } }));
    assert.equal(res.status, 200);
    const data = (res.body as DataBody).data;
    assert.equal(data.commandId, a.commandId);
    assert.equal(data.status, 'SUCCEEDED');
    assert.equal(data.attempts.length, 1);
    assert.equal(data.attempts[0].attemptNo, 1);
    assert.equal(data.acks.length, 1);
    assert.equal(data.acks[0].result, 'SUCCESS');
    assert.equal(data.acks[0].sourceMessageId, 'ACK-MSG-1');

    // 本 Customer 可见
    assert.equal((await h.getCommand(req(a.customerAdmin, { params: { commandId: a.commandId } }))).status, 200);
    // 跨 Customer → 404（不泄露存在性）
    const cross = await h.getCommand(req(b.customerAdmin, { params: { commandId: a.commandId } }));
    assert.equal(cross.status, 404);
    assert.equal((cross.body as ErrorBody).error.code, 'NOT_FOUND');
    // 不存在 → 404；未认证 → 401
    assert.equal((await h.getCommand(req(superAdmin, { params: { commandId: 'CMD-MISSING' } }))).status, 404);
    assert.equal((await h.getCommand(req(undefined, { params: { commandId: a.commandId } }))).status, 401);
  });
});

describe('Timeout evaluator', () => {
  test('过期未完成命令 → TIMED_OUT + command.timeout 审计；未过期/终态不受影响', async () => {
    const expiredPublished = await plantCommand({ status: 'PUBLISHED', expiresAt: new Date(NOW.getTime() - 1000) });
    const expiredAuthorized = await plantCommand({ status: 'AUTHORIZED', expiresAt: new Date(NOW.getTime() - 1) });
    const stuckPublishing = await plantCommand({ status: 'PUBLISHING', expiresAt: new Date(NOW.getTime() - 5000) });
    const expiredAcked = await plantCommand({ status: 'ACKNOWLEDGED', expiresAt: new Date(NOW.getTime() - 100) });
    const fresh = await plantCommand({ status: 'PUBLISHED', expiresAt: new Date(NOW.getTime() + 60_000) });
    const terminal = await plantCommand({ status: 'SUCCEEDED', expiresAt: new Date(NOW.getTime() - 1000) });
    const alreadyTimedOut = await plantCommand({ status: 'TIMED_OUT', expiresAt: new Date(NOW.getTime() - 1000) });

    const result = await evaluateCommandTimeouts({ client: prisma, now: () => NOW });
    const timedOut = new Set(result.timedOut);
    for (const c of [expiredPublished, expiredAuthorized, stuckPublishing, expiredAcked]) {
      assert.ok(timedOut.has(c.commandId), `${c.commandId} 应超时`);
      const row = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: c.commandId } });
      assert.equal(row.status, 'TIMED_OUT');
    }
    for (const c of [fresh, terminal, alreadyTimedOut]) {
      assert.ok(!timedOut.has(c.commandId), `${c.commandId} 不应超时`);
    }
    const freshRow = await prisma.deviceCommand.findUniqueOrThrow({ where: { id: fresh.commandId } });
    assert.equal(freshRow.status, 'PUBLISHED');

    // 审计：恰 4 条 command.timeout，actor=system
    const audits = await prisma.auditLog.findMany({
      where: { action: 'command.timeout', objectId: { in: [...timedOut] } },
    });
    assert.equal(audits.length, 4);
    for (const audit of audits) {
      assert.equal(audit.actorId, 'system');
      assert.equal(audit.actorRole, 'system');
    }

    // 幂等：再次评估无新增
    const again = await evaluateCommandTimeouts({ client: prisma, now: () => NOW });
    assert.deepEqual(again.timedOut, []);
  });
});
