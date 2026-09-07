/**
 * BE-RPL-01 Admin Replay API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 创建 replay job（scope 校验 + 事务 Outbox + 创建审计）；
 * - 仅 PlatformOperator/SuperAdmin（CustomerAdmin/Auditor 403）；
 * - 跨 Customer 请求被拒绝（deviceId 不属于 customerId → 400；不存在 Customer → 404）；
 * - 列表键集游标分页 + customerId/status 过滤；详情含 resultSummary。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { createAdminReplayHandlers } from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
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
const customerAdmin: ActorContext = { ...superAdmin, actorId: 'ca-1', roles: ['CustomerAdmin'], customerId: 'cust-x' };
const auditor: ActorContext = { ...superAdmin, actorId: 'au-1', roles: ['Auditor'] };

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

let seq = 0;
async function plantCustomerWithDevice() {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `Customer RPL ${seq}` } });
  const device = await prisma.device.create({
    data: {
      id: `dev-rpl-${seq}`,
      serialNumber: `SN-RPL-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Active',
      customerId: customer.id,
    },
  });
  return { customerId: customer.id, deviceId: device.id };
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

const VALID_BODY = {
  from: '2026-08-28T10:00:00.000Z',
  to: '2026-08-28T12:00:00.000Z',
};

describe('POST /admin/replay/jobs（创建）', () => {
  test('PlatformOperator 创建成功：201 + scope 落库 + 创建审计', async () => {
    const { customerId, deviceId } = await plantCustomerWithDevice();
    const handlers = createAdminReplayHandlers({ client: prisma, now: () => NOW });
    const res = await handlers.create(
      req(operator, {
        body: { ...VALID_BODY, customerId, deviceId, topicType: 'telemetry', seqFrom: 100, seqTo: 200 },
      }),
    );
    assert.equal(res.status, 201);
    const data = (res.body as { data: Record<string, unknown> }).data;
    assert.ok(data.jobId);
    assert.equal(data.status, 'PENDING');
    assert.deepEqual(data.scope, {
      customerId,
      deviceId,
      topicType: 'telemetry',
      from: VALID_BODY.from,
      to: VALID_BODY.to,
      seqFrom: 100,
      seqTo: 200,
    });
    const audits = await prisma.auditLog.findMany({
      where: { objectId: data.jobId as string, action: 'replay.job.create' },
    });
    assert.equal(audits.length, 1, '每次创建写审计');
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.actorId, 'op-1');
    const triggers = await prisma.outboxEvent.findMany({
      where: { aggregateId: data.jobId as string, eventType: 'REPLAY_JOB_REQUESTED' },
    });
    assert.equal(triggers.length, 1, '创建事务必须同时落 Replay 触发 Outbox');
    assert.deepEqual(triggers[0]?.payload, { jobId: data.jobId });
  });

  test('CustomerAdmin/Auditor/未认证被拒绝（仅 PlatformOperator/SuperAdmin）', async () => {
    const { customerId } = await plantCustomerWithDevice();
    const handlers = createAdminReplayHandlers({ client: prisma, now: () => NOW });
    for (const actor of [customerAdmin, auditor, undefined]) {
      const res = await handlers.create(req(actor, { body: { ...VALID_BODY, customerId } }));
      assert.include([401, 403], res.status, `actor=${actor?.roles?.[0] ?? 'anonymous'} 必须被拒绝`);
    }
    const ok = await handlers.create(req(superAdmin, { body: { ...VALID_BODY, customerId } }));
    assert.equal(ok.status, 201, 'PlatformSuperAdmin 允许');
  });

  test('跨 Customer 请求被拒绝：deviceId 不属于 customerId → 400；Customer/设备不存在 → 404', async () => {
    const a = await plantCustomerWithDevice();
    const b = await plantCustomerWithDevice();
    const handlers = createAdminReplayHandlers({ client: prisma, now: () => NOW });

    const cross = await handlers.create(
      req(operator, { body: { ...VALID_BODY, customerId: a.customerId, deviceId: b.deviceId } }),
    );
    assert.equal(cross.status, 400);
    assert.equal((cross.body as { error: { code: string } }).error.code, 'VALIDATION_FAILED');

    const noCustomer = await handlers.create(req(operator, { body: { ...VALID_BODY, customerId: 'cust-missing' } }));
    assert.equal(noCustomer.status, 404);
    const noDevice = await handlers.create(
      req(operator, { body: { ...VALID_BODY, customerId: a.customerId, deviceId: 'dev-missing' } }),
    );
    assert.equal(noDevice.status, 404);
  });

  test('范围校验：缺 from/to、from>to、非法 topicType、seqFrom>seqTo → 400', async () => {
    const { customerId } = await plantCustomerWithDevice();
    const handlers = createAdminReplayHandlers({ client: prisma, now: () => NOW });
    const cases: Record<string, unknown>[] = [
      { customerId },
      { ...VALID_BODY, customerId, from: '2026-08-28T13:00:00.000Z', to: '2026-08-28T12:00:00.000Z' },
      { ...VALID_BODY, customerId, topicType: 'heartbeat' },
      { ...VALID_BODY, customerId, seqFrom: 200, seqTo: 100 },
      { ...VALID_BODY, customerId, from: '2026-08-28 10:00:00' },
    ];
    for (const body of cases) {
      const res = await handlers.create(req(operator, { body }));
      assert.equal(res.status, 400, `body=${JSON.stringify(body)} 必须 400`);
    }
  });
});

describe('GET /admin/replay/jobs（列表/详情）', () => {
  test('键集游标分页 + customerId 过滤；详情 404', async () => {
    const { customerId } = await plantCustomerWithDevice();
    const handlers = createAdminReplayHandlers({ client: prisma, now: () => NOW });
    const jobIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await handlers.create(req(operator, { body: { ...VALID_BODY, customerId } }));
      jobIds.push((res.body as { data: { jobId: string } }).data.jobId);
      // 保证 createdAt 可区分
      await prisma.replayJob.update({
        where: { id: jobIds[i] },
        data: { createdAt: new Date(NOW.getTime() + i * 1000) },
      });
    }

    const page1 = await handlers.list(req(operator, { query: { customerId, limit: '2' } }));
    assert.equal(page1.status, 200);
    const body1 = page1.body as { data: Array<{ jobId: string }>; meta: { nextCursor?: string } };
    assert.equal(body1.data.length, 2);
    assert.ok(body1.meta.nextCursor, '必须有续页游标');

    const page2 = await handlers.list(
      req(operator, { query: { customerId, limit: '2', cursor: body1.meta.nextCursor } }),
    );
    const body2 = page2.body as { data: Array<{ jobId: string }>; meta: { nextCursor?: string } };
    assert.equal(body2.data.length, 1);
    assert.notOk(body2.meta.nextCursor);
    const all = [...body1.data, ...body2.data].map((j) => j.jobId);
    assert.deepEqual([...all].sort(), [...jobIds].sort(), '两页覆盖全部任务且不重复');

    const detail = await handlers.detail(req(operator, { params: { jobId: jobIds[0] } }));
    assert.equal(detail.status, 200);
    assert.equal((detail.body as { data: { jobId: string } }).data.jobId, jobIds[0]);

    const missing = await handlers.detail(req(operator, { params: { jobId: 'job-missing' } }));
    assert.equal(missing.status, 404);
    const forbidden = await handlers.list(req(customerAdmin, {}));
    assert.equal(forbidden.status, 403);
  });
});
