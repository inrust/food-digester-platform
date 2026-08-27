/**
 * BE-ONB-02 管理员 Onboarding 审批验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 待审批列表/详情；Rejected 原因可查询；
 * - 仅 PlatformSuperAdmin 可审批（其余角色 403，未认证 401）；
 * - If-Match 防重复审批：缺 Header 400、版本不符 409 VERSION_CONFLICT、已审批 409 CONFLICT、
 *   并发审批只有一个成功；
 * - 业务审计含前后状态且不含 Token（DOM-03，append-only）；
 * - approve 触发证书发放服务端口（不返回私钥）；reject 强制原因。
 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { createAdminOnboardingHandlers } from '../src/index.js';
import type { AdminHttpRequest, AdminOnboardingHandlers, ProvisioningTrigger } from '../src/index.js';
import { createTestDb } from './helpers.js';

const NOW = new Date('2026-08-27T08:00:00Z');
const now = () => NOW;

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;
let handlers: AdminOnboardingHandlers;

const superAdmin: ActorContext = {
  actorId: 'admin-1',
  username: 'admin',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
  customerId: null,
  tokenUse: 'access',
};
const operator: ActorContext = { ...superAdmin, actorId: 'op-1', roles: ['PlatformOperator'] };
const auditor: ActorContext = { ...superAdmin, actorId: 'audit-1', roles: ['Auditor'] };
const customerAdmin: ActorContext = {
  actorId: 'ca-1',
  username: 'ca',
  actorType: 'customer',
  roles: ['CustomerAdmin'],
  customerId: 'cust-1',
  tokenUse: 'access',
};

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
  handlers = createAdminOnboardingHandlers({ client: prisma, now });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

let seq = 0;
interface Planted {
  requestId: string;
  deviceId: string;
  serialNumber: string;
}

/** 落库一台库存设备 + 一条申请（含 FK 需要的 Token 行）；每台设备序列号唯一。 */
async function plantRequest(overrides: { status?: string; requestModel?: string } = {}): Promise<Planted> {
  seq += 1;
  const serialNumber = `SN-ADM-${seq}`;
  const deviceId = `dev-adm-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'PendingOnboarding',
    },
  });
  const token = await prisma.onboardingToken.create({
    data: {
      tokenHash: `hash-${NOW.getTime()}-${seq}`,
      serialNumber,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    },
  });
  const request = await prisma.onboardingRequest.create({
    data: {
      tokenId: token.id,
      serialNumber,
      model: overrides.requestModel ?? 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      ...(overrides.status ? { status: overrides.status } : {}),
    },
  });
  return { requestId: request.id, deviceId, serialNumber };
}

function req(
  actor: ActorContext | undefined,
  init: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: unknown;
  },
  requestId = 'req-admin',
): AdminHttpRequest {
  return {
    ...(actor ? { actor } : {}),
    headers: init.headers ?? {},
    params: init.params ?? {},
    query: init.query ?? {},
    body: init.body,
    requestId,
  };
}

interface ErrorPayload {
  error: { code: string; message: string; requestId: string };
}
interface DetailPayload {
  data: Record<string, unknown> & { requestId: string; status: string; version: number };
  meta: { requestId: string; timestamp: string };
}
interface ListPayload {
  data: { requestId: string; status: string; rejectReason: string | null }[];
  meta: { requestId: string; timestamp: string; nextCursor: string | null };
}

describe('GET /admin/onboarding/requests（列表）', () => {
  test('默认仅返回 PENDING；status=REJECTED 可查拒绝原因；游标分页', async () => {
    const p1 = await plantRequest();
    const p2 = await plantRequest();
    const rejected = await plantRequest({ status: 'REJECTED' });
    await prisma.onboardingRequest.updateMany({
      where: { id: rejected.requestId },
      data: { status: 'REJECTED', rejectReason: '资料不全', reviewedBy: 'admin-0', reviewedAt: NOW },
    });

    const page1 = await handlers.list(req(superAdmin, { query: { limit: '1' } }));
    assert.equal(page1.status, 200);
    const body1 = page1.body as ListPayload;
    assert.equal(body1.data.length, 1);
    assert.ok(body1.meta.nextCursor);
    assert.ok(body1.data.every((r) => r.status === 'PENDING'));
    const page2 = await handlers.list(req(superAdmin, { query: { limit: '1', cursor: body1.meta.nextCursor! } }));
    const ids = [...body1.data, ...(page2.body as ListPayload).data].map((r) => r.requestId);
    assert.ok(ids.includes(p1.requestId) && ids.includes(p2.requestId));

    const rejectedList = await handlers.list(req(superAdmin, { query: { status: 'REJECTED' } }));
    const rows = (rejectedList.body as ListPayload).data;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.rejectReason, '资料不全');
  });

  test('PlatformOperator/Auditor 可读列表与详情（onboarding:read）', async () => {
    const planted = await plantRequest();
    assert.equal((await handlers.list(req(operator, {}))).status, 200);
    assert.equal((await handlers.list(req(auditor, {}))).status, 200);
    assert.equal((await handlers.detail(req(auditor, { params: { requestId: planted.requestId } }))).status, 200);
  });
});

describe('GET /admin/onboarding/requests/:requestId（详情）', () => {
  test('返回 DTO 含 version/rejectReason，不含 tokenId；未知 id → 404', async () => {
    const planted = await plantRequest();
    const res = await handlers.detail(req(superAdmin, { params: { requestId: planted.requestId } }));
    assert.equal(res.status, 200);
    const body = res.body as DetailPayload;
    assert.equal(body.data.requestId, planted.requestId);
    assert.equal(body.data.version, 1);
    assert.equal(body.data.status, 'PENDING');
    assert.ok(!('tokenId' in body.data), '响应不得包含 tokenId');

    const missing = await handlers.detail(req(superAdmin, { params: { requestId: 'req-missing' } }));
    assert.equal(missing.status, 404);
    assert.equal((missing.body as ErrorPayload).error.code, 'NOT_FOUND');
  });
});

describe('POST approve / reject', () => {
  test('approve 正向：APPROVED + 设备 OnboardingApproved + 状态历史 + 触发证书发放端口', async () => {
    const planted = await plantRequest();
    const triggered: string[] = [];
    const provisioningTrigger: ProvisioningTrigger = {
      triggerApproved: (r) => {
        triggered.push(r.id);
        return Promise.resolve();
      },
    };
    const withTrigger = createAdminOnboardingHandlers({ client: prisma, now, provisioningTrigger });

    const res = await withTrigger.approve(
      req(superAdmin, { params: { requestId: planted.requestId }, headers: { 'If-Match': '1' } }),
    );
    assert.equal(res.status, 200);
    const body = res.body as DetailPayload;
    assert.equal(body.data.status, 'APPROVED');
    assert.equal(body.data.version, 2);
    assert.equal(body.data.reviewedBy, 'admin-1');
    assert.deepEqual(triggered, [planted.requestId]);
    // 响应不含任何私钥/密钥材料字段
    assert.ok(!/privateKey|certificatePem/i.test(JSON.stringify(res.body)));

    const device = await prisma.device.findFirst({ where: { id: planted.deviceId } });
    assert.equal(device?.lifecycleStatus, 'OnboardingApproved');
    const history = await prisma.deviceStateHistory.findMany({
      where: { deviceId: planted.deviceId, toStatus: 'OnboardingApproved' },
    });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.actorType, 'ADMIN');
  });

  test('reject 强制原因：缺 reason → 400；携带 reason → REJECTED 且原因可查询', async () => {
    const planted = await plantRequest();
    const noReason = await handlers.reject(
      req(superAdmin, { params: { requestId: planted.requestId }, headers: { 'If-Match': '1' } }),
    );
    assert.equal(noReason.status, 400);
    assert.equal((noReason.body as ErrorPayload).error.code, 'VALIDATION_FAILED');

    const res = await handlers.reject(
      req(superAdmin, {
        params: { requestId: planted.requestId },
        headers: { 'If-Match': '1' },
        body: { reason: '  序列号与实物不符  ' },
      }),
    );
    assert.equal(res.status, 200);
    const body = res.body as DetailPayload;
    assert.equal(body.data.status, 'REJECTED');
    assert.equal(body.data.rejectReason, '序列号与实物不符');

    const detail = await handlers.detail(req(superAdmin, { params: { requestId: planted.requestId } }));
    assert.equal((detail.body as DetailPayload).data.rejectReason, '序列号与实物不符');
    const device = await prisma.device.findFirst({ where: { id: planted.deviceId } });
    assert.equal(device?.lifecycleStatus, 'Rejected');
  });

  test('非授权角色 403；未认证 401', async () => {
    const planted = await plantRequest();
    for (const actor of [operator, auditor, customerAdmin]) {
      const res = await handlers.approve(
        req(actor, { params: { requestId: planted.requestId }, headers: { 'If-Match': '1' } }),
      );
      assert.equal(res.status, 403, actor.actorId);
      assert.equal((res.body as ErrorPayload).error.code, 'FORBIDDEN');
    }
    const unauthenticated = await handlers.approve(
      req(undefined, { params: { requestId: planted.requestId }, headers: { 'If-Match': '1' } }),
    );
    assert.equal(unauthenticated.status, 401);
    assert.equal((unauthenticated.body as ErrorPayload).error.code, 'UNAUTHENTICATED');
  });

  test('If-Match：缺失/非法 → 400；版本不符 → 409 VERSION_CONFLICT', async () => {
    const planted = await plantRequest();
    const missing = await handlers.approve(req(superAdmin, { params: { requestId: planted.requestId } }));
    assert.equal(missing.status, 400);
    assert.equal((missing.body as ErrorPayload).error.code, 'VALIDATION_FAILED');

    const stale = await handlers.approve(
      req(superAdmin, { params: { requestId: planted.requestId }, headers: { 'If-Match': '5' } }),
    );
    assert.equal(stale.status, 409);
    assert.equal((stale.body as ErrorPayload).error.code, 'VERSION_CONFLICT');
  });

  test('重复审批 → 409 CONFLICT；并发审批只有一个成功', async () => {
    const planted = await plantRequest();
    const first = await handlers.approve(
      req(superAdmin, { params: { requestId: planted.requestId }, headers: { 'If-Match': '1' } }),
    );
    assert.equal(first.status, 200);
    const again = await handlers.approve(
      req(superAdmin, { params: { requestId: planted.requestId }, headers: { 'If-Match': '1' } }),
    );
    assert.equal(again.status, 409);
    assert.equal((again.body as ErrorPayload).error.code, 'CONFLICT');

    // 并发：两个审批同时携带相同版本，只有一个成功
    const race = await plantRequest();
    const [a, b] = await Promise.all([
      handlers.approve(
        req(superAdmin, { params: { requestId: race.requestId }, headers: { 'If-Match': '1' } }, 'req-race-a'),
      ),
      handlers.reject(
        req(
          superAdmin,
          { params: { requestId: race.requestId }, headers: { 'If-Match': '1' }, body: { reason: '并发拒绝' } },
          'req-race-b',
        ),
      ),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const record = await prisma.onboardingRequest.findFirst({ where: { id: race.requestId } });
    assert.equal(record?.version, 2);
    const successAudits = await prisma.auditLog.findMany({
      where: { objectId: race.requestId, result: 'SUCCESS' },
    });
    assert.equal(successAudits.length, 1);
  });

  test('审批校验设备资料：申请与库存不一致 → 409 CONFLICT，申请保持 PENDING', async () => {
    const planted = await plantRequest({ requestModel: 'WRONG-MODEL' });
    const res = await handlers.approve(
      req(superAdmin, { params: { requestId: planted.requestId }, headers: { 'If-Match': '1' } }),
    );
    assert.equal(res.status, 409);
    assert.equal((res.body as ErrorPayload).error.code, 'CONFLICT');
    const record = await prisma.onboardingRequest.findFirst({ where: { id: planted.requestId } });
    assert.equal(record?.status, 'PENDING');
  });

  test('审计：含前后状态、rejectReason、actorRole，且不含 Token（tokenId/tokenHash 不出现）', async () => {
    const planted = await plantRequest();
    await handlers.reject(
      req(
        superAdmin,
        { params: { requestId: planted.requestId }, headers: { 'If-Match': '1' }, body: { reason: '审计验证' } },
        'req-audit',
      ),
    );
    const audits = await prisma.auditLog.findMany({
      where: { objectId: planted.requestId, action: 'onboarding.request.reject' },
    });
    assert.equal(audits.length, 1);
    const audit = audits[0]!;
    assert.equal(audit.result, 'SUCCESS');
    assert.equal(audit.actorId, 'admin-1');
    assert.equal(audit.actorRole, 'PlatformSuperAdmin');
    assert.deepEqual(audit.beforeValue, { status: 'PENDING', version: 1 });
    const after = audit.afterValue as { status: string; version: number; rejectReason: string };
    assert.equal(after.status, 'REJECTED');
    assert.equal(after.version, 2);
    assert.equal(after.rejectReason, '审计验证');
    // 不含 Token：审计全文不出现 tokenId/tokenHash 值，字段名命中 token 应被 DOM-03 脱敏
    const token = await prisma.onboardingToken.findFirst({ where: { serialNumber: planted.serialNumber } });
    const serialized = JSON.stringify(audit);
    assert.ok(token);
    assert.ok(!serialized.includes(token.id) && !serialized.includes(token.tokenHash));
    assert.ok(!/"token/i.test(serialized), '审计字段名命中 token 应被 DOM-03 脱敏');
  });

  test('审批失败记 FAILURE 审计且不伪造成功（设备资料不符场景）', async () => {
    const planted = await plantRequest({ requestModel: 'WRONG-MODEL' });
    await handlers.approve(req(superAdmin, { params: { requestId: planted.requestId }, headers: { 'If-Match': '1' } }));
    const audits = await prisma.auditLog.findMany({
      where: { objectId: planted.requestId, action: 'onboarding.request.approve' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'FAILURE');
  });
});
