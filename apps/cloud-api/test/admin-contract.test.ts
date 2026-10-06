/**
 * BE-CON-01 Contract CRUD 与状态 API 验收（PGlite 真实 PostgreSQL）。
 *
 * 验收基准覆盖：
 * - 列表/详情/新建/编辑/续约/终止路径均有接口；
 * - 重复编号 409、非法日期（startAt≥endAt）400、越权 403/401、并发修改（If-Match 漂移）409；
 * - 到期边界可注入时间复验（evaluate at 注入：EFFECTIVE→EXPIRING_SOON→EXPIRED）；
 * - 所有写操作 If-Match + 强制原因 + 审计；contact 最小权限（Auditor 遮蔽）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { ADMIN_CONTRACT_ERROR_HTTP_STATUS, createAdminContractHandlers } from '../src/index.js';
import type { AdminHttpRequest } from '../src/index.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-08-29T12:00:00Z');
const now = () => NOW;
const DAY_MS = 86_400_000;
const START = new Date('2026-01-01T00:00:00Z');
const END = new Date('2027-01-01T00:00:00Z');

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
const customerAdmin: ActorContext = {
  ...superAdmin,
  actorId: 'ca-1',
  actorType: 'customer',
  roles: ['CustomerAdmin'],
  customerId: 'cust-x',
};

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

function handlers() {
  return createAdminContractHandlers({ client: prisma, now });
}

function req(actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return {
    actor,
    headers: {},
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    ...options,
  };
}

/** 带 If-Match 的写请求。 */
function writeReq(actor: ActorContext, version: number, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest {
  return req(actor, { ...options, headers: { 'If-Match': String(version) } });
}

type DataBody = { data: Record<string, unknown>; meta: Record<string, unknown> };
type ErrorBody = { error: { code: string; message: string; requestId: string } };

let seq = 0;
async function plantCustomer() {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `Customer CON ${seq}` } });
  return customer.id;
}

async function createContract(
  h: ReturnType<typeof handlers>,
  customerId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await h.create(
    req(superAdmin, {
      body: {
        contractNumber: `CT-CON-${seq}-${Math.random().toString(36).slice(2, 8)}`,
        name: '服务合同',
        customerId,
        contact: 'ops@example.com / +86-138',
        startAt: START.toISOString(),
        endAt: END.toISOString(),
        reason: '录入',
        ...overrides,
      },
    }),
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assertOpenApiResponse('createContract', 201, res.body);
  return (res.body as DataBody).data;
}

async function auditCount(contractId: string, action: string) {
  return prisma.auditLog.count({ where: { objectId: contractId, action, result: 'SUCCESS' } });
}

describe('CRUD 与状态全路径', () => {
  test('创建→详情→编辑→激活→续约→终止；每步审计一次、version 递增', async () => {
    const h = handlers();
    const customerId = await plantCustomer();
    const c = await createContract(h, customerId);
    const contractId = c.contractId as string;
    assert.equal(c.status, 'DRAFT');
    assert.equal(c.derivedStatus, 'DRAFT');
    assert.equal(c.version, 1);
    assert.equal(c.contact, 'ops@example.com / +86-138', 'SuperAdmin 可见 contact');

    // 编辑 name/contact（DRAFT 下也可改窗口）
    const updated = await h.update(
      writeReq(superAdmin, 1, {
        params: { contractId },
        body: {
          name: '服务合同 V2',
          contact: null,
          endAt: new Date(END.getTime() + 30 * DAY_MS).toISOString(),
          reason: '更正',
        },
      }),
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal((updated.body as DataBody).data.version, 2);
    assert.equal((updated.body as DataBody).data.contact, null);
    assert.equal((updated.body as DataBody).data.name, '服务合同 V2');

    // 激活 DRAFT→EFFECTIVE
    const activated = await h.activate(
      writeReq(superAdmin, 2, { params: { contractId }, body: { reason: '签署完成' } }),
    );
    assert.equal(activated.status, 200);
    assert.equal((activated.body as DataBody).data.status, 'EFFECTIVE');
    assert.equal((activated.body as DataBody).data.version, 3);

    // 续约：延长 endAt
    const renewed = await h.renew(
      writeReq(superAdmin, 3, {
        params: { contractId },
        body: { newEndAt: new Date(END.getTime() + 400 * DAY_MS).toISOString(), reason: '续约一年' },
      }),
    );
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.equal((renewed.body as DataBody).data.version, 4);
    assert.equal((renewed.body as DataBody).data.status, 'EFFECTIVE');

    // 终止
    const terminated = await h.terminate(
      writeReq(superAdmin, 4, { params: { contractId }, body: { reason: '客户违约' } }),
    );
    assert.equal(terminated.status, 200);
    assert.equal((terminated.body as DataBody).data.status, 'TERMINATED');

    // 每步审计恰好一次
    for (const action of ['contract.update', 'contract.activate', 'contract.renew', 'contract.terminate']) {
      assert.equal(await auditCount(contractId, action), 1, `${action} 审计恰好一次`);
    }
    // create 审计（objectId=contractNumber）
    assert.equal(
      await prisma.auditLog.count({ where: { objectId: c.contractNumber as string, action: 'contract.create' } }),
      1,
    );
  });

  test('重复编号 409；非法日期 400；Customer 不存在 404；非法状态迁移 409', async () => {
    const h = handlers();
    const customerId = await plantCustomer();
    const c = await createContract(h, customerId);
    const contractId = c.contractId as string;

    // 重复编号 → 409 CONFLICT
    const dup = await h.create(
      req(superAdmin, {
        body: {
          contractNumber: c.contractNumber,
          name: '重复',
          customerId,
          startAt: START.toISOString(),
          endAt: END.toISOString(),
        },
      }),
    );
    assert.equal(dup.status, 409);
    assert.equal((dup.body as ErrorBody).error.code, 'CONFLICT');

    // 非法日期：startAt ≥ endAt → 400
    for (const [startAt, endAt] of [
      [END.toISOString(), END.toISOString()],
      [END.toISOString(), START.toISOString()],
      ['not-a-date', END.toISOString()],
    ]) {
      const res = await h.create(
        req(superAdmin, { body: { contractNumber: `CT-X-${Math.random()}`, name: 'x', customerId, startAt, endAt } }),
      );
      assert.equal(res.status, 400, `startAt=${startAt} 必须 400`);
    }
    // Customer 不存在 → 404
    assert.equal(
      (
        await h.create(
          req(superAdmin, {
            body: {
              contractNumber: 'CT-NOPE',
              name: 'x',
              customerId: 'cust-missing',
              startAt: START.toISOString(),
              endAt: END.toISOString(),
            },
          }),
        )
      ).status,
      404,
    );

    // 非法迁移：非 DRAFT 激活 → 409；DRAFT 续约 → 409；TERMINATED 后任何写 → 409
    assert.equal(
      (await h.activate(writeReq(superAdmin, 1, { params: { contractId }, body: { reason: 'x' } }))).status,
      200,
    );
    assert.equal(
      (await h.activate(writeReq(superAdmin, 2, { params: { contractId }, body: { reason: 'x' } }))).status,
      409,
    );
    const draftContract = await createContract(h, customerId);
    assert.equal(
      (
        await h.renew(
          writeReq(superAdmin, 1, {
            params: { contractId: draftContract.contractId as string },
            body: { newEndAt: new Date(END.getTime() + DAY_MS).toISOString(), reason: 'x' },
          }),
        )
      ).status,
      409,
      'DRAFT 不可续约',
    );
    // 续约不更晚 → 400
    assert.equal(
      (
        await h.renew(
          writeReq(superAdmin, 2, { params: { contractId }, body: { newEndAt: END.toISOString(), reason: 'x' } }),
        )
      ).status,
      400,
    );
    // 终止后编辑/续约/终止 → 409
    await h.terminate(writeReq(superAdmin, 2, { params: { contractId }, body: { reason: '结束' } }));
    assert.equal(
      (await h.update(writeReq(superAdmin, 3, { params: { contractId }, body: { name: 'x', reason: 'x' } }))).status,
      409,
    );
    assert.equal(
      (await h.terminate(writeReq(superAdmin, 3, { params: { contractId }, body: { reason: 'x' } }))).status,
      409,
    );
  });
});

describe('并发与写操作约束', () => {
  test('If-Match 缺失 400 / 漂移 409 VERSION_CONFLICT；缺原因 400', async () => {
    const h = handlers();
    const customerId = await plantCustomer();
    const c = await createContract(h, customerId);
    const contractId = c.contractId as string;

    // 缺 If-Match → 400
    assert.equal(
      (await h.update(req(superAdmin, { params: { contractId }, body: { name: 'x', reason: 'x' } }))).status,
      400,
    );
    // If-Match 漂移（version 1 已消费）→ 409 VERSION_CONFLICT
    assert.equal(
      (await h.update(writeReq(superAdmin, 1, { params: { contractId }, body: { name: 'A', reason: 'x' } }))).status,
      200,
    );
    const stale = await h.update(writeReq(superAdmin, 1, { params: { contractId }, body: { name: 'B', reason: 'x' } }));
    assert.equal(stale.status, 409);
    assert.equal((stale.body as ErrorBody).error.code, 'VERSION_CONFLICT');
    // 缺原因 → 400
    assert.equal((await h.terminate(writeReq(superAdmin, 2, { params: { contractId }, body: {} }))).status, 400);
    assert.equal(
      (await h.update(writeReq(superAdmin, 2, { params: { contractId }, body: { name: 'x' } }))).status,
      400,
    );
    // 写被拒后无版本变化
    const detail = await h.detail(req(operator, { params: { contractId } }));
    assert.equal((detail.body as DataBody).data.version, 2);
  });
});

describe('时间派生与筛选', () => {
  test('evaluate 注入时间复验到期边界：EFFECTIVE→EXPIRING_SOON→EXPIRED；无变化无写入/审计', async () => {
    const h = handlers();
    const customerId = await plantCustomer();
    const c = await createContract(h, customerId);
    const contractId = c.contractId as string;
    await h.activate(writeReq(superAdmin, 1, { params: { contractId }, body: { reason: '生效' } }));

    // 当前时点无变化 → changed=false，无写入/审计
    const noChange = await h.evaluate(writeReq(superAdmin, 2, { params: { contractId }, body: {} }));
    assert.equal((noChange.body as DataBody).data.changed, false);
    assert.equal((noChange.body as DataBody).data.status, 'EFFECTIVE');
    assert.equal(await auditCount(contractId, 'contract.evaluate'), 0);

    // 注入窗口内时间 → EXPIRING_SOON
    const soonAt = new Date(END.getTime() - 10 * DAY_MS);
    const toSoon = await h.evaluate(
      writeReq(superAdmin, 2, { params: { contractId }, body: { at: soonAt.toISOString() } }),
    );
    assert.equal((toSoon.body as DataBody).data.changed, true);
    assert.equal((toSoon.body as DataBody).data.status, 'EXPIRING_SOON');
    assert.equal((toSoon.body as DataBody).data.version, 3);
    assert.equal(await auditCount(contractId, 'contract.evaluate'), 1);

    // 注入过期时间 → EXPIRED
    const expiredAt = new Date(END.getTime() + DAY_MS);
    const toExpired = await h.evaluate(
      writeReq(superAdmin, 3, { params: { contractId }, body: { at: expiredAt.toISOString() } }),
    );
    assert.equal((toExpired.body as DataBody).data.status, 'EXPIRED');
    assert.equal(await auditCount(contractId, 'contract.evaluate'), 2);

    // 列表按派生状态筛选（过期合同可被筛出）
    const expired = await h.list(req(auditor, { query: { status: 'EXPIRED', customerId } }));
    assert.equal(expired.status, 200);
    assert.ok((expired.body as { data: unknown[] }).data.length >= 1);
    const effective = await h.list(req(auditor, { query: { status: 'EFFECTIVE', customerId } }));
    assert.equal((effective.body as { data: unknown[] }).data.length, 0);
    // 非法状态筛选 → 400
    assert.equal((await h.list(req(auditor, { query: { status: 'BOGUS' } }))).status, 400);

    // 过期合同可续约（EXPIRED → 续约后 EFFECTIVE）
    const renewed = await h.renew(
      writeReq(superAdmin, 4, {
        params: { contractId },
        body: { newEndAt: new Date(expiredAt.getTime() + 400 * DAY_MS).toISOString(), reason: '挽回续约' },
      }),
    );
    assert.equal(renewed.status, 200);
    assert.equal((renewed.body as DataBody).data.status, 'EFFECTIVE');
  });
});

describe('权限与最小权限 contact', () => {
  test('contract:write 仅 SuperAdmin；Auditor 读放行写 403 且 contact 遮蔽；Customer 403；未认证 401', async () => {
    const h = handlers();
    const customerId = await plantCustomer();
    const c = await createContract(h, customerId);
    const contractId = c.contractId as string;

    // Operator 有 contract:read 无 contract:write（DEC-012）
    assert.equal((await h.detail(req(operator, { params: { contractId } }))).status, 200);
    assert.equal(
      (
        await h.create(
          req(operator, {
            body: {
              contractNumber: 'CT-OP',
              name: 'x',
              customerId,
              startAt: START.toISOString(),
              endAt: END.toISOString(),
            },
          }),
        )
      ).status,
      403,
    );
    assert.equal(
      (await h.update(writeReq(operator, 1, { params: { contractId }, body: { name: 'x', reason: 'x' } }))).status,
      403,
    );
    // Auditor 读放行、写 403
    assert.equal((await h.list(req(auditor, {}))).status, 200);
    assert.equal(
      (await h.terminate(writeReq(auditor, 1, { params: { contractId }, body: { reason: 'x' } }))).status,
      403,
    );
    // Customer 角色整接口 403；未认证 401
    assert.equal((await h.detail(req(customerAdmin, { params: { contractId } }))).status, 403);
    assert.equal((await h.detail(req(undefined, { params: { contractId } }))).status, 401);
    // 不存在 → 404
    assert.equal((await h.detail(req(operator, { params: { contractId: 'ct-missing' } }))).status, 404);

    // contact 最小权限：SuperAdmin/Operator 可见，Auditor 遮蔽为 null
    const suView = (await h.detail(req(superAdmin, { params: { contractId } }))).body as DataBody;
    const opView = (await h.detail(req(operator, { params: { contractId } }))).body as DataBody;
    const auView = (await h.detail(req(auditor, { params: { contractId } }))).body as DataBody;
    assert.equal(suView.data.contact, 'ops@example.com / +86-138');
    assert.equal(opView.data.contact, 'ops@example.com / +86-138');
    assert.equal(auView.data.contact, null, 'Auditor 视图 contact 遮蔽');
  });
});

describe('契约一致性', () => {
  const REST_DIR = new URL('../../../contracts/rest/', import.meta.url);
  const loadJson = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(name, REST_DIR)), 'utf8'));

  test('AdminContractError 错误码与 CT-05 错误码目录一致', () => {
    const catalog = new Map<string, number>(
      (loadJson('error-codes.json').errorCodes as { code: string; httpStatus: number }[]).map((e) => [
        e.code,
        e.httpStatus,
      ]),
    );
    for (const [code, status] of Object.entries(ADMIN_CONTRACT_ERROR_HTTP_STATUS)) {
      assert.equal(catalog.get(code), status, `${code} 与 CT-05 目录不一致`);
    }
  });

  test('Contract DTO 字段与 OpenAPI Contract 契约一致', async () => {
    const api = loadJson('admin-contract-api.json');
    const required = [...api.components.schemas.Contract.required].sort();
    const customerId = await plantCustomer();
    const c = await createContract(handlers(), customerId);
    assert.deepEqual(Object.keys(c).sort(), required);
  });

  test('admin/contract 模块无任何 AWS 依赖', () => {
    const dir = fileURLToPath(new URL('../src/admin/contract/', import.meta.url));
    for (const file of readdirSync(dir)) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      assert.ok(!/@fdp\/aws-clients|@aws-sdk|aws-sdk/.test(source), `${file} 引用了 AWS 客户端`);
    }
  });
});

test('PATCH trace distinguishes conditional conflict, rollback and independent failure audit without leaking payload', async () => {
  const { withDataPathTrace } = await import('@fdp/observability');
  const h = handlers(),
    customerId = await plantCustomer();
  const c = await createContract(h, customerId);
  const contractId = c.contractId as string;
  const rows: Record<string, unknown>[] = [];
  const update = (version: number, requestId: string) =>
    withDataPathTrace(
      { gatewayRequestId: requestId, lambdaRequestId: 'lambda-' + requestId, operationId: 'updateContract' },
      () =>
        h.update(
          writeReq(superAdmin, version, {
            requestId,
            params: { contractId },
            body: { name: 'private-name', contact: 'private-contact', reason: 'private-reason' },
          }),
        ),
      (r) => rows.push(r),
    );
  assert.equal((await update(1, 'winner')).status, 200);
  assert.equal((await update(1, 'loser')).status, 409);
  const winner = rows.filter((r) => r.gatewayRequestId === 'winner');
  const loser = rows.filter((r) => r.gatewayRequestId === 'loser');
  for (const phase of [
    'db-transaction-open',
    'db-transaction-callback',
    'db-transaction-finish',
    'db-transaction',
    'contract-load',
    'contract-version-update',
    'contract-readback',
    'audit-success-write',
  ])
    assert.equal(winner.filter((r) => r.phase === phase && r.outcome === 'PASS').length, 1, phase);
  assert.isTrue(
    loser.some(
      (r) => r.phase === 'contract-version-update' && r.errorCode === 'VERSION_CONFLICT' && r.outcome === 'FAIL',
    ),
  );
  assert.isTrue(loser.some((r) => r.phase === 'db-transaction-finish' && r.outcome === 'FAIL'));
  assert.isTrue(
    loser.some((r) => r.phase === 'audit-failure-write' && r.outcome === 'PASS' && r.includesConnectionWait === true),
  );
  assert.isFalse(loser.some((r) => r.phase === 'contract-readback' || r.phase === 'audit-success-write'));
  assert.equal(await auditCount(contractId, 'contract.update'), 1);
  for (const secret of ['private-name', 'private-contact', 'private-reason'])
    assert.notInclude(JSON.stringify(rows), secret);
});
