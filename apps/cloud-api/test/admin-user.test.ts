/**
 * BE-RBAC-01 用户/角色/Scope 管理 API 验收（PGlite 真实 PostgreSQL + 全部 migration）。
 *
 * 验收基准覆盖：
 * - 自我提权/自我角色变更/自我停用拒绝（目标 cognitoSub === actor.actorId → 403）；
 * - 跨 Customer 授权拒绝（Customer actor → 403）；CustomerAdmin 提升平台角色拒绝；
 * - 最后一个非停用 PlatformSuperAdmin 移除角色/停用 → 409；
 * - 邀请/密码重置响应不含密码或 Hash；API 不接收永久密码（契约测试强制）；
 * - PlatformOperator 无 user:write/user:read（矩阵 → 403）；无 actor → 401；
 * - 角色集校验：混绑/未知角色/空集 → 400；平台角色带 customerId → 400；
 * - Cognito 端口调用断言（invite/groups/scope/disable/reset）及 DB 失败补偿/对账意图；
 * - 审计齐备：user.invite / user.role.assign / user.scope.change / user.disable / user.password_reset.trigger；
 * - 列表筛选（roleType/status/customerId/q）+ 键集游标分页；视图不泄露 cognitoSub。
 */
import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import { assert } from 'vitest';
import { withDataPathTrace } from '@fdp/observability';
import { createCognitoAdminPort } from '@fdp/aws-clients';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import {
  activateInvitedUserOnAuthenticatedRequest,
  assignUserRoles,
  createAdminAuditHandlers,
  createAdminUserHandlers,
  inviteUser,
  setUserScope,
} from '../src/index.js';
import type { AdminHttpRequest, CognitoAdminPort, UserAdminDeps } from '../src/index.js';
import { createTestDb } from './helpers.js';
import { assertOpenApiResponse } from './openapi-response.js';
import { generateTestKeySet, signToken, testConfig } from '../../../packages/auth/test/helpers.js';
import { createAdminLambdaRouter } from '../src/runtime/admin-lambda.js';

let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;

const NOW = new Date('2026-09-05T09:00:00Z');

const superAdmin: ActorContext = {
  actorId: 'sub-super-actor',
  username: 'super',
  actorType: 'platform',
  roles: ['PlatformSuperAdmin'],
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

let seq = 0;

// ---------- Fake Cognito 端口（记录调用；返回确定性 sub） ----------

interface CognitoCall {
  readonly method: string;
  readonly input: Record<string, unknown>;
}

function fakeCognito(): { port: CognitoAdminPort; calls: CognitoCall[] } {
  const calls: CognitoCall[] = [];
  const record = (method: string, input: Record<string, unknown>) => {
    calls.push({ method, input });
  };
  return {
    calls,
    port: {
      async inviteUser(input) {
        record('inviteUser', { ...input });
        return { cognitoSub: `cognito-sub-${++seq}` };
      },
      async setUserGroups(input) {
        record('setUserGroups', { ...input });
      },
      async setUserCustomerScope(input) {
        record('setUserCustomerScope', { ...input });
      },
      async disableUser(input) {
        record('disableUser', { ...input });
      },
      async deleteUser(input) {
        record('deleteUser', { ...input });
      },
      async enableUser(input) {
        record('enableUser', { ...input });
      },
      async triggerPasswordReset(input) {
        record('triggerPasswordReset', { ...input });
      },
    },
  };
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

function userDeps(cognito: CognitoAdminPort): UserAdminDeps {
  return { client: prisma, now: () => NOW, cognito };
}

const req = (actor: ActorContext | undefined, options: Partial<AdminHttpRequest> = {}): AdminHttpRequest => ({
  actor,
  headers: {},
  requestId: `req-${Math.random()}`,
  ...options,
});

type DataBody = { data: any; meta: Record<string, any> };
type ListBody = { data: Record<string, any>[]; meta: Record<string, any> };
type ErrBody = { error: { code: string; message: string } };

async function plantCustomer(status = 'ACTIVE'): Promise<string> {
  seq += 1;
  const customer = await prisma.customer.create({ data: { name: `RBAC C${seq}`, status } });
  return customer.id;
}

/** 直接落库一个用户（绕过邀请流程），可指定角色/Customer scope/cognitoSub/status。 */
async function plantUser(options: {
  roles: readonly string[];
  customerId?: string | undefined;
  cognitoSub?: string | undefined;
  status?: string | undefined;
}): Promise<{ userId: string; cognitoSub: string }> {
  seq += 1;
  const cognitoSub = options.cognitoSub ?? `planted-sub-${seq}`;
  const user = await prisma.user.create({
    data: {
      email: `planted-${seq}@example.com`,
      displayName: `Planted ${seq}`,
      cognitoSub,
      status: options.status ?? 'ACTIVE',
    },
  });
  for (const roleCode of options.roles) {
    await prisma.userRole.create({ data: { userId: user.id, roleCode } });
  }
  if (options.customerId) {
    await prisma.userScope.create({ data: { userId: user.id, customerId: options.customerId } });
  }
  return { userId: user.id, cognitoSub };
}

function expectNoCredentialLeak(body: unknown): void {
  const text = JSON.stringify(body).toLowerCase();
  assert.ok(!text.includes('password'), 'response must not contain password material');
  assert.ok(!text.includes('hash'), 'response must not contain hash material');
  assert.ok(!text.includes('cognitosub'), 'view must not leak cognitoSub');
}

// ---------- 首次认证状态收敛 ----------

describe('首次认证用户状态收敛', () => {
  for (const role of [
    'PlatformSuperAdmin',
    'PlatformOperator',
    'Auditor',
    'CustomerAdmin',
    'CustomerViewer',
  ] as const) {
    test.each(['id', 'access'] as const)(`${role} 停用后旧 %s Token 不再进入读写路由`, async (tokenUse) => {
      // 独立保留管理员，停用 SuperAdmin 时不触发最后管理员保护。
      await plantUser({ roles: ['PlatformSuperAdmin'] });
      const customerId = role.startsWith('Customer') ? await plantCustomer() : undefined;
      const target = await plantUser({ roles: [role], ...(customerId ? { customerId } : {}) });
      const keys = await generateTestKeySet();
      const token = await signToken(keys, {
        groups: [role],
        sub: target.cognitoSub,
        tokenUse,
        ...(customerId ? { customerId } : {}),
      });
      const read = vi.fn(async () => ({ status: 200, body: { data: [] } }));
      const write = vi.fn(async () => ({ status: 201, body: { data: {} } }));
      const resolve = vi.fn((event) => (event.httpMethod === 'POST' ? write : read));
      const handler = createAdminLambdaRouter(testConfig(keys.jwks), resolve, {
        onAuthenticated: async (actor, requestId) => {
          await activateInvitedUserOnAuthenticatedRequest({ client: prisma }, actor, requestId);
        },
      });
      const event = { headers: { authorization: `Bearer ${token}` }, requestContext: { requestId: 'req-old-token' } };
      assert.equal((await handler({ ...event, httpMethod: 'GET' })).statusCode, 200);
      assert.equal((await handler({ ...event, httpMethod: 'POST', body: '{}' })).statusCode, 201);
      const { port } = fakeCognito();
      const disabled = await createAdminUserHandlers(userDeps(port)).disableUser(
        req(superAdmin, { params: { userId: target.userId } }),
      );
      assert.equal(disabled.status, 200);
      assert.equal((await prisma.user.findUnique({ where: { id: target.userId } }))?.status, 'DISABLED');
      read.mockClear();
      write.mockClear();
      resolve.mockClear();
      const auditCount = await prisma.auditLog.count({ where: { objectId: target.userId } });
      for (const httpMethod of ['GET', 'POST']) {
        // 原 Token 原样重用，未重新签发或等到到期。
        const response = await handler({ ...event, httpMethod, ...(httpMethod === 'POST' ? { body: '{}' } : {}) });
        assert.equal(response.statusCode, 401);
        assert.deepEqual(JSON.parse(response.body).error, {
          code: 'UNAUTHENTICATED',
          message: 'Authentication is required or the credential is invalid',
          requestId: 'req-old-token',
        });
      }
      assert.equal(resolve.mock.calls.length, 0);
      assert.equal(read.mock.calls.length, 0);
      assert.equal(write.mock.calls.length, 0);
      assert.equal(await prisma.auditLog.count({ where: { objectId: target.userId } }), auditCount);
    });
  }

  test('首次查询后被停用的 INVITED 用户不能绕过状态检查，且不写激活审计', async () => {
    const target = await plantUser({ roles: ['Auditor'], status: 'INVITED' });
    const find = prisma.user.findFirst.bind(prisma.user);
    const query = vi.spyOn(prisma.user, 'findFirst').mockImplementationOnce((args) => {
      // 此服务仅 await 查询结果，不使用 Prisma 关系查询方法。
      return (async () => {
        const invited = await find(args);
        await prisma.user.update({ where: { id: target.userId }, data: { status: 'DISABLED' } });
        return invited;
      })() as ReturnType<typeof prisma.user.findFirst>;
    });
    try {
      await expectReject(
        activateInvitedUserOnAuthenticatedRequest(
          { client: prisma },
          { ...superAdmin, actorId: target.cognitoSub },
          'req-activation-race',
        ),
        'UNAUTHENTICATED',
      );
      assert.equal((await prisma.user.findUnique({ where: { id: target.userId } }))?.status, 'DISABLED');
      assert.equal(await prisma.auditLog.count({ where: { objectId: target.userId, action: 'user.activate' } }), 0);
    } finally {
      query.mockRestore();
    }
  });

  test('INVITED 用户首次通过认证后转为 ACTIVE，并只记录一次审计', async () => {
    const target = await plantUser({
      roles: ['PlatformSuperAdmin'],
      cognitoSub: 'first-login-sub',
      status: 'INVITED',
    });

    const rows: Record<string, unknown>[] = [];
    const first = await withDataPathTrace(
      {},
      () =>
        activateInvitedUserOnAuthenticatedRequest(
          { client: prisma, now: () => NOW },
          { ...superAdmin, actorId: target.cognitoSub },
          'req-first-login',
        ),
      (r) => rows.push(r),
    );
    const repeated = await activateInvitedUserOnAuthenticatedRequest(
      { client: prisma, now: () => NOW },
      { ...superAdmin, actorId: target.cognitoSub },
      'req-repeated',
    );

    assert.equal(first, true);
    assert.deepEqual(
      rows.map((r) => [r.phase, r.outcome]),
      [
        ['admin-account-query', 'PASS'],
        ['admin-account-activation', 'PASS'],
      ],
    );
    assert.equal(repeated, false);
    assert.equal((await prisma.user.findUnique({ where: { id: target.userId } }))?.status, 'ACTIVE');
    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'user', objectId: target.userId, action: 'user.activate' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.actorId, target.cognitoSub);
    assert.equal(audits[0]?.requestId, 'req-first-login');
    assert.deepEqual(audits[0]?.beforeValue, { status: 'INVITED' });
    assert.deepEqual(audits[0]?.afterValue, { status: 'ACTIVE' });
  });

  test('无对应业务用户或用户已 ACTIVE 时保持幂等且不写审计', async () => {
    const target = await plantUser({ roles: ['Auditor'], status: 'ACTIVE' });
    const before = await prisma.auditLog.count({ where: { action: 'user.activate' } });

    assert.equal(
      await activateInvitedUserOnAuthenticatedRequest(
        { client: prisma, now: () => NOW },
        { ...operator, actorId: target.cognitoSub },
        'req-active',
      ),
      false,
    );
    assert.equal(
      await activateInvitedUserOnAuthenticatedRequest(
        { client: prisma, now: () => NOW },
        { ...operator, actorId: 'missing-sub' },
        'req-missing',
      ),
      false,
    );
    assert.equal(await prisma.auditLog.count({ where: { action: 'user.activate' } }), before);
  });
});

describe('CMP-01 authenticated own account profile', () => {
  test('matches only the verified subject for all five roles and returns only the two display fields', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const customerId = await plantCustomer();
    const other = await plantUser({ roles: ['CustomerViewer'], customerId: await plantCustomer(), status: 'ACTIVE' });
    const displayName = 'Synthetic account name';
    for (const role of [
      'PlatformSuperAdmin',
      'PlatformOperator',
      'Auditor',
      'CustomerAdmin',
      'CustomerViewer',
    ] as const) {
      const isCustomer = role.startsWith('Customer');
      const user = await plantUser({ roles: [role], ...(isCustomer ? { customerId } : {}), status: 'ACTIVE' });
      await prisma.user.update({ where: { id: user.userId }, data: { displayName } });
      const actor: ActorContext = {
        ...operator,
        username: 'cognito-username-not-the-business-name',
        actorId: user.cognitoSub,
        roles: [role],
        actorType: isCustomer ? 'customer' : 'platform',
        customerId: isCustomer ? customerId : null,
      };
      const response = await h.ownProfile(
        req(actor, {
          query: { userId: other.userId, cognitoSub: other.cognitoSub, customerId: 'other-tenant' },
        }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers?.['Cache-Control'], 'private, no-store');
      assertOpenApiResponse('getOwnAccountProfile', 200, response.body);
      assert.deepEqual((response.body as DataBody).data, { userId: user.userId, displayName });
    }
    assert.deepEqual(calls, []);
  });

  test('legacy missing rows and blank names use nulls, and unauthenticated or disabled callers get 401', async () => {
    const { port } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const legacy = await h.ownProfile(req({ ...operator, actorId: 'fixture-unlinked-cmp01' }));
    assert.equal(legacy.status, 200);
    assertOpenApiResponse('getOwnAccountProfile', 200, legacy.body);
    assert.deepEqual((legacy.body as DataBody).data, { userId: null, displayName: null });

    const blank = await plantUser({ roles: ['PlatformOperator'], status: 'ACTIVE' });
    await prisma.user.update({ where: { id: blank.userId }, data: { displayName: '   ' } });
    const actor = { ...operator, actorId: blank.cognitoSub };
    const blankResponse = await h.ownProfile(req(actor));
    assert.equal(blankResponse.status, 200);
    assert.deepEqual((blankResponse.body as DataBody).data, { userId: blank.userId, displayName: null });

    await prisma.user.update({ where: { id: blank.userId }, data: { status: 'DISABLED' } });
    for (const invalidActor of [undefined, actor]) {
      const denied = await h.ownProfile(req(invalidActor));
      assert.equal(denied.status, 401);
      assertOpenApiResponse('getOwnAccountProfile', 401, denied.body);
    }
  });
});

// ---------- 邀请 ----------

describe('BE-RBAC-01 邀请用户', () => {
  test('成功：平台角色邀请 → 201 + Cognito 同步 + 角色落库 + 审计；响应不含凭证', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const res = await h.inviteUser(
      req(superAdmin, {
        body: {
          email: 'New.Admin@Example.com',
          displayName: 'New Admin',
          roles: ['PlatformOperator', 'PlatformSuperAdmin'],
        },
      }),
    );
    assert.equal(res.status, 201);
    const view = (res.body as DataBody).data;
    assert.equal(view.email, 'new.admin@example.com'); // 规范化
    assert.equal(view.status, 'INVITED');
    assert.deepEqual(view.roles, ['PlatformOperator', 'PlatformSuperAdmin']);
    assert.equal(view.customerId, null);
    expectNoCredentialLeak(res.body);

    // Cognito 同步：groups 去重、customerId null
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'inviteUser');
    assert.deepEqual(calls[0]?.input, {
      email: 'new.admin@example.com',
      groups: ['PlatformOperator', 'PlatformSuperAdmin'],
      customerId: null,
    });

    const row = await prisma.user.findUnique({ where: { id: view.userId } });
    assert.ok(row?.cognitoSub);

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'user', objectId: view.userId, action: 'user.invite' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.actorId, superAdmin.actorId);
  });

  test('R18 新邀请拒绝 Auditor，且不启动 Cognito 或审计写入', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const email = 't13-denied-auditor@example.com';
    const countIntents = () => prisma.outboxEvent.count({ where: { eventType: 'COGNITO_ADMIN_RECONCILIATION' } });
    const before = await countIntents();
    for (const roles of [['Auditor'], ['PlatformOperator', 'Auditor']]) {
      const res = await h.inviteUser(req(superAdmin, { body: { email, displayName: 'Legacy invitation', roles } }));
      assert.equal(res.status, 400);
      assertOpenApiResponse('inviteUser', res.status, res.body);
      assert.equal((res.body as ErrBody).error.code, 'VALIDATION_FAILED');
    }
    assert.deepEqual(calls, []);
    assert.isNull(await prisma.user.findUnique({ where: { email } }));
    assert.equal(await countIntents(), before);
  });

  test('成功：Customer 角色邀请 → scope 落库 + Cognito 携带 customerId', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const customerId = await plantCustomer();
    const res = await h.inviteUser(
      req(superAdmin, {
        body: { email: 'ca@example.com', displayName: 'CA', roles: ['CustomerAdmin'], customerId },
      }),
    );
    assert.equal(res.status, 201);
    const view = (res.body as DataBody).data;
    assert.equal(view.customerId, customerId);
    assert.deepEqual(calls[0]?.input, {
      email: 'ca@example.com',
      groups: ['CustomerAdmin'],
      customerId,
    });
    const scope = await prisma.userScope.findFirst({ where: { userId: view.userId } });
    assert.equal(scope?.customerId, customerId);
  });

  test('拒绝：混绑/未知/空角色、平台角色带 customerId、Customer 角色缺 customerId → 400', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const customerId = await plantCustomer();
    const cases: Record<string, unknown>[] = [
      { email: 'a@b.co', displayName: 'A', roles: ['PlatformSuperAdmin', 'CustomerViewer'], customerId },
      { email: 'a@b.co', displayName: 'A', roles: ['Root'] },
      { email: 'a@b.co', displayName: 'A', roles: [] },
      { email: 'a@b.co', displayName: 'A', roles: ['PlatformOperator'], customerId },
      { email: 'a@b.co', displayName: 'A', roles: ['CustomerViewer'] },
      { email: 'not-an-email', displayName: 'A', roles: ['Auditor'] },
      { email: 'a@b.co', displayName: '', roles: ['Auditor'] },
    ];
    for (const body of cases) {
      const res = await h.inviteUser(req(superAdmin, { body }));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((res.body as ErrBody).error.code, 'VALIDATION_FAILED');
    }
    assert.equal(calls.length, 0); // 校验失败不得触达 Cognito
  });

  test('严格请求：永久密码、未知字段与数组 body 在 Cognito/DB/审计前返回 400', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const beforeUsers = await prisma.user.count();
    const beforeAudits = await prisma.auditLog.count();
    const valid = { email: 'strict@example.com', displayName: 'Strict', roles: ['PlatformOperator'] };
    for (const body of [{ ...valid, password: 'NeverAcceptThis' }, { ...valid, requestedBy: 'spoof' }, []]) {
      const response = await h.inviteUser(req(superAdmin, { body }));
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((response.body as ErrBody).error.code, 'VALIDATION_FAILED');
    }
    assert.equal(calls.length, 0);
    assert.equal(await prisma.user.count(), beforeUsers);
    assert.equal(await prisma.auditLog.count(), beforeAudits);

    const platformTarget = await plantUser({ roles: ['Auditor'] });
    const customerId = await plantCustomer();
    const customerTarget = await plantUser({ roles: ['CustomerViewer'], customerId });
    assert.equal(
      (
        await h.assignRoles(
          req(superAdmin, {
            params: { userId: platformTarget.userId },
            body: { roles: ['PlatformOperator'], ignored: true },
          }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await h.setScope(
          req(superAdmin, {
            params: { userId: customerTarget.userId },
            body: { customerId, ignored: true },
          }),
        )
      ).status,
      400,
    );
    assert.equal(
      (await h.disableUser(req(superAdmin, { params: { userId: platformTarget.userId }, body: {} }))).status,
      400,
    );
    assert.equal(
      (await h.triggerPasswordReset(req(superAdmin, { params: { userId: platformTarget.userId }, body: {} }))).status,
      400,
    );
    assert.equal(calls.length, 0);
  });

  test('拒绝：重复 email → 409；Customer 不存在 → 404；非 ACTIVE Customer → 409', async () => {
    const { port } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const existing = await plantUser({ roles: ['Auditor'] });
    const existingEmail = (await prisma.user.findUniqueOrThrow({ where: { id: existing.userId } })).email;
    const dup = await h.inviteUser(
      req(superAdmin, {
        body: { email: existingEmail, displayName: 'Dup', roles: ['PlatformOperator'] },
      }),
    );
    assert.equal(dup.status, 409);

    const missing = await h.inviteUser(
      req(superAdmin, {
        body: { email: 'm@example.com', displayName: 'M', roles: ['CustomerAdmin'], customerId: 'cust-ghost' },
      }),
    );
    assert.equal(missing.status, 404);

    const suspendedId = await plantCustomer('SUSPENDED');
    const suspended = await h.inviteUser(
      req(superAdmin, {
        body: { email: 's@example.com', displayName: 'S', roles: ['CustomerAdmin'], customerId: suspendedId },
      }),
    );
    assert.equal(suspended.status, 409);
  });

  test('权限：PlatformOperator/CustomerAdmin 无 user:write → 403；无 actor → 401', async () => {
    const { port } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const customerId = await plantCustomer();
    const body = { email: 'p@example.com', displayName: 'P', roles: ['Auditor'] };
    assert.equal((await h.inviteUser(req(operator, { body }))).status, 403);
    const custAdmin: ActorContext = {
      actorId: 'sub-ca',
      username: 'ca',
      actorType: 'customer',
      roles: ['CustomerAdmin'],
      customerId,
      tokenUse: 'access',
    };
    assert.equal((await h.inviteUser(req(custAdmin, { body }))).status, 403);
    assert.equal((await h.inviteUser(req(undefined, { body }))).status, 401);
    // Operator 也无 user:read（列表）
    assert.equal((await h.listUsers(req(operator, { query: {} }))).status, 403);
    assert.equal((await h.listUsers(req(undefined, { query: {} }))).status, 401);
  });
});

test('R18 存量多角色签名会话可继续读取用户和审计，且无账号写权限', async () => {
  const { port, calls } = fakeCognito();
  const roles = ['Auditor', 'PlatformOperator'] as const;
  const target = await plantUser({ roles });
  const keys = await generateTestKeySet();
  const token = await signToken(keys, { sub: target.cognitoSub, groups: roles });
  const h = createAdminUserHandlers(userDeps(port));
  const audit = createAdminAuditHandlers({ client: prisma, now: () => NOW });
  const router = createAdminLambdaRouter(
    testConfig(keys.jwks),
    (event) => {
      if (event.path === '/api/v1/admin/audit-logs') return audit.listAuditLogs;
      return event.httpMethod === 'POST' ? h.inviteUser : h.listUsers;
    },
    {
      onAuthenticated: async (actor, requestId) => {
        await activateInvitedUserOnAuthenticatedRequest({ client: prisma }, actor, requestId);
      },
    },
  );
  const event = { headers: { authorization: `Bearer ${token}` }, requestContext: { requestId: 't13-old-session' } };
  const list = await router({
    ...event,
    path: '/api/v1/admin/users',
    httpMethod: 'GET',
    queryStringParameters: { roleType: 'platform', q: `planted-${seq}@` },
  });
  assert.equal(list.statusCode, 200);
  const record = (JSON.parse(list.body) as ListBody).data.find(({ userId }) => userId === target.userId);
  assert.deepEqual(record?.roles, [...roles]);
  const logs = await router({ ...event, path: '/api/v1/admin/audit-logs', httpMethod: 'GET' });
  assert.equal(logs.statusCode, 200);
  const denied = await router({
    ...event,
    path: '/api/v1/admin/users',
    httpMethod: 'POST',
    body: JSON.stringify({
      roles: ['PlatformSuperAdmin'],
      displayName: 'No elevation',
      email: 't13-ungranted@example.test',
    }),
  });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(calls, []);
});

// ---------- 角色分配 ----------

describe('BE-RBAC-01 角色分配', () => {
  test('R18 显式分配平台角色时，Cognito、DB 和审计保留已有 Auditor', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const target = await plantUser({ roles: ['Auditor'] });
    const res = await h.assignRoles(
      req(superAdmin, { params: { userId: target.userId }, body: { roles: ['PlatformOperator'] } }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual((res.body as DataBody).data.roles, ['Auditor', 'PlatformOperator']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'setUserGroups');
    assert.deepEqual(calls[0]?.input, { cognitoSub: target.cognitoSub, groups: ['Auditor', 'PlatformOperator'] });

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'user', objectId: target.userId, action: 'user.role.assign' },
    });
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0]?.beforeValue, { roles: ['Auditor'] });
    assert.deepEqual(audits[0]?.afterValue, { roles: ['Auditor', 'PlatformOperator'] });
  });

  test('R18 旧客户端可回传已有 Auditor，平台账号不会被新授予该角色', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const existing = await plantUser({ roles: ['Auditor', 'PlatformOperator'] });
    const next = await h.assignRoles(
      req(superAdmin, {
        params: { userId: existing.userId },
        body: { roles: ['Auditor'] },
      }),
    );
    assert.equal(next.status, 200);
    assert.deepEqual((next.body as DataBody).data.roles, ['Auditor']);
    assert.deepEqual(calls[0]?.input.groups, ['Auditor']);

    const target = await plantUser({ roles: ['PlatformOperator'] });
    const params = { userId: target.userId };
    for (const roles of [['Auditor'], ['PlatformSuperAdmin', 'Auditor']]) {
      const denied = await h.assignRoles(req(superAdmin, { params, body: { roles } }));
      assert.equal(denied.status, 400);
      assertOpenApiResponse('assignUserRoles', denied.status, denied.body);
      assert.equal((denied.body as ErrBody).error.code, 'VALIDATION_FAILED');
    }
    assert.lengthOf(calls, 1);
    assert.equal(await prisma.outboxEvent.count({ where: { aggregateId: target.userId } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { objectId: target.userId } }), 0);
    assert.deepEqual(
      (await prisma.userRole.findMany({ where: { userId: target.userId } })).map((r) => r.roleCode),
      ['PlatformOperator'],
    );
  });

  test('R18 角色快照在写锁前变化时拒绝旧请求并保留最新角色', async () => {
    const { port, calls } = fakeCognito();
    const target = await plantUser({ roles: ['PlatformOperator'] });
    const staleClient = prisma.$extends({
      query: {
        outboxEvent: {
          async create({ args, query }) {
            await prisma.userRole.create({ data: { userId: target.userId, roleCode: 'Auditor' } });
            return query(args);
          },
        },
      },
    });
    await expectReject(
      assignUserRoles(
        { ...userDeps(port), client: staleClient as unknown as UserAdminDeps['client'] },
        superAdmin,
        target.userId,
        { roles: ['PlatformSuperAdmin'] },
      ),
      'CONFLICT',
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(
      (await prisma.userRole.findMany({ where: { userId: target.userId }, orderBy: { roleCode: 'asc' } })).map(
        (r) => r.roleCode,
      ),
      ['Auditor', 'PlatformOperator'],
    );
    const intent = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: target.userId } });
    assert.equal(intent.status, 'PUBLISHED');
  });

  test('拒绝：自我角色变更（目标 cognitoSub === actor.actorId）→ 403', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    // actor 本人在库中的用户（同为 SuperAdmin）
    const self = await plantUser({ roles: ['PlatformSuperAdmin'], cognitoSub: superAdmin.actorId });
    await plantUser({ roles: ['PlatformSuperAdmin'] }); // 另一个 SuperAdmin，排除 last-admin 干扰
    const res = await h.assignRoles(req(superAdmin, { params: { userId: self.userId }, body: { roles: ['Auditor'] } }));
    assert.equal(res.status, 403);
    assert.equal((res.body as ErrBody).error.code, 'FORBIDDEN');
    assert.equal(calls.length, 0);
    // 角色未变化
    const roles = await prisma.userRole.findMany({ where: { userId: self.userId } });
    assert.deepEqual(
      roles.map((r) => r.roleCode),
      ['PlatformSuperAdmin'],
    );
  });

  test('拒绝：最后一个非停用 PlatformSuperAdmin 不可被移除角色 → 409', async () => {
    const { port } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    // 清场：停用既有全部 SuperAdmin（含上文用例），仅留目标
    await prisma.user.updateMany({
      where: { roles: { some: { roleCode: 'PlatformSuperAdmin' } } },
      data: { status: 'DISABLED' },
    });
    const last = await plantUser({ roles: ['PlatformSuperAdmin'] });
    const res = await h.assignRoles(
      req(superAdmin, { params: { userId: last.userId }, body: { roles: ['PlatformOperator'] } }),
    );
    assert.equal(res.status, 409);
    assert.equal((res.body as ErrBody).error.code, 'CONFLICT');
    // 新增一个可用 SuperAdmin 后可移除
    await plantUser({ roles: ['PlatformSuperAdmin'] });
    const ok = await h.assignRoles(
      req(superAdmin, { params: { userId: last.userId }, body: { roles: ['PlatformOperator'] } }),
    );
    assert.equal(ok.status, 200);
  });

  test('并发不变量：两个仅存 SuperAdmin 互相降级时只允许一个成功', async () => {
    await prisma.user.updateMany({
      where: { roles: { some: { roleCode: 'PlatformSuperAdmin' } } },
      data: { status: 'DISABLED' },
    });
    const first = await plantUser({ roles: ['PlatformSuperAdmin'], cognitoSub: `concurrent-super-a-${++seq}` });
    const second = await plantUser({ roles: ['PlatformSuperAdmin'], cognitoSub: `concurrent-super-b-${++seq}` });
    const firstActor: ActorContext = { ...superAdmin, actorId: first.cognitoSub };
    const secondActor: ActorContext = { ...superAdmin, actorId: second.cognitoSub };
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));

    const results = await Promise.all([
      h.assignRoles(req(firstActor, { params: { userId: second.userId }, body: { roles: ['PlatformOperator'] } })),
      h.assignRoles(req(secondActor, { params: { userId: first.userId }, body: { roles: ['PlatformOperator'] } })),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal(
      await prisma.user.count({
        where: { status: { not: 'DISABLED' }, roles: { some: { roleCode: 'PlatformSuperAdmin' } } },
      }),
      1,
    );
    assert.equal(calls.filter((call) => call.method === 'setUserGroups').length, 1);
  });

  test('并发不变量：停用与互相降级竞争时仍保留一个有效 SuperAdmin', async () => {
    await prisma.user.updateMany({
      where: { roles: { some: { roleCode: 'PlatformSuperAdmin' } } },
      data: { status: 'DISABLED' },
    });
    const first = await plantUser({ roles: ['PlatformSuperAdmin'], cognitoSub: `mixed-super-a-${++seq}` });
    const second = await plantUser({ roles: ['PlatformSuperAdmin'], cognitoSub: `mixed-super-b-${++seq}` });
    const firstActor: ActorContext = { ...superAdmin, actorId: first.cognitoSub };
    const secondActor: ActorContext = { ...superAdmin, actorId: second.cognitoSub };
    const { port } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const results = await Promise.all([
      h.disableUser(req(firstActor, { params: { userId: second.userId } })),
      h.assignRoles(req(secondActor, { params: { userId: first.userId }, body: { roles: ['PlatformOperator'] } })),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal(
      await prisma.user.count({
        where: { status: { not: 'DISABLED' }, roles: { some: { roleCode: 'PlatformSuperAdmin' } } },
      }),
      1,
    );
  });

  test('Cognito 已生效但 DB 写失败时恢复旧 Groups，并关闭对账意图', async () => {
    const target = await plantUser({ roles: ['Auditor'] });
    const { port, calls } = fakeCognito();
    const failingClient = prisma.$extends({
      query: {
        userRole: {
          async createMany() {
            throw new Error('injected user_roles write failure');
          },
        },
      },
    });
    let failed = false;
    try {
      await assignUserRoles(
        { client: failingClient as unknown as UserAdminDeps['client'], now: () => NOW, cognito: port },
        superAdmin,
        target.userId,
        { roles: ['PlatformOperator'] },
      );
    } catch {
      failed = true;
    }
    assert.isTrue(failed);
    const groupCalls = calls.filter((call) => call.method === 'setUserGroups');
    assert.equal(groupCalls.length, 2);
    assert.deepEqual(groupCalls[0]?.input.groups, ['Auditor', 'PlatformOperator']);
    assert.deepEqual(groupCalls[1]?.input.groups, ['Auditor']);
    assert.deepEqual(
      (await prisma.userRole.findMany({ where: { userId: target.userId } })).map((role) => role.roleCode),
      ['Auditor'],
    );
    const intent = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: target.userId, eventType: 'COGNITO_ADMIN_RECONCILIATION' },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(intent.status, 'PUBLISHED');
  });

  test('Cognito 调用结果不确定时保留 PENDING 对账意图并产生告警审计', async () => {
    const target = await plantUser({ roles: ['Auditor'] });
    const { port, calls } = fakeCognito();
    const uncertainPort: CognitoAdminPort = {
      ...port,
      async setUserGroups(input) {
        calls.push({ method: 'setUserGroups', input: { ...input } });
        throw new Error('injected uncertain Cognito response');
      },
    };
    let failed = false;
    try {
      await assignUserRoles(userDeps(uncertainPort), superAdmin, target.userId, { roles: ['PlatformOperator'] });
    } catch {
      failed = true;
    }
    assert.isTrue(failed);
    const intent = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: target.userId, eventType: 'COGNITO_ADMIN_RECONCILIATION' },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(intent.status, 'PENDING');
    assert.equal(intent.retryCount, 1);
    assert.equal(intent.lastError, 'RECONCILIATION_REQUIRED');
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: target.userId, action: 'user.cognito.reconciliation_required', result: 'FAILURE' },
      }),
      1,
    );
  });

  test('拒绝：角色类型不可变（customer → platform 提升）；Customer actor 跨 Customer 授权', async () => {
    const { port } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const customerA = await plantCustomer();
    const customerB = await plantCustomer();
    const target = await plantUser({ roles: ['CustomerAdmin'], customerId: customerA });

    // CustomerAdmin 用户提升为平台角色 → 403（角色类型不可变）
    const promote = await h.assignRoles(
      req(superAdmin, { params: { userId: target.userId }, body: { roles: ['PlatformOperator'] } }),
    );
    assert.equal(promote.status, 403);

    // Customer actor（服务层直接调用，矩阵层已 403；此处验证服务层双重防护）
    const custActor: ActorContext = {
      actorId: 'sub-ca-x',
      username: 'ca-x',
      actorType: 'customer',
      roles: ['CustomerAdmin'],
      customerId: customerB,
      tokenUse: 'access',
    };
    const deps = userDeps(port);
    // 跨 Customer 邀请 → FORBIDDEN
    await expectReject(
      inviteUser(deps, custActor, {
        email: 'cross@example.com',
        displayName: 'X',
        roles: ['CustomerViewer'],
        customerId: customerA,
      }),
      'FORBIDDEN',
    );
    // 跨 Customer 改 scope（目标 Customer 非 actor 所属）→ FORBIDDEN
    await expectReject(setUserScope(deps, custActor, target.userId, { customerId: customerA }), 'FORBIDDEN');
  });
});

// ---------- Scope 变更 / 停用 / 密码重置 ----------

describe('BE-RBAC-01 Scope 变更、停用与密码重置', () => {
  test('Scope 变更：成功（Cognito custom:customer_id 先行 + 审计）；平台角色用户 → 400', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const customerA = await plantCustomer();
    const customerB = await plantCustomer();
    const target = await plantUser({ roles: ['CustomerViewer'], customerId: customerA });

    const res = await h.setScope(
      req(superAdmin, { params: { userId: target.userId }, body: { customerId: customerB } }),
    );
    assert.equal(res.status, 200);
    assert.equal((res.body as DataBody).data.customerId, customerB);
    assert.equal(calls[0]?.method, 'setUserCustomerScope');
    assert.deepEqual(calls[0]?.input, { cognitoSub: target.cognitoSub, customerId: customerB });

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'user', objectId: target.userId, action: 'user.scope.change' },
    });
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0]?.beforeValue, { customerId: customerA });
    assert.deepEqual(audits[0]?.afterValue, { customerId: customerB });

    // 平台角色用户无 Customer scope → 400
    const platformUser = await plantUser({ roles: ['Auditor'] });
    const bad = await h.setScope(
      req(superAdmin, { params: { userId: platformUser.userId }, body: { customerId: customerA } }),
    );
    assert.equal(bad.status, 400);
  });

  test('停用：成功 + Cognito disable 先行 + 审计；幂等回放；自我停用 → 403；最后 SuperAdmin → 409', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const target = await plantUser({ roles: ['Auditor'] });

    const res = await h.disableUser(req(superAdmin, { params: { userId: target.userId } }));
    assert.equal(res.status, 200);
    assert.equal((res.body as DataBody).data.status, 'DISABLED');
    assert.equal(calls[0]?.method, 'disableUser');
    assert.deepEqual(calls[0]?.input, { cognitoSub: target.cognitoSub });
    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'user', objectId: target.userId, action: 'user.disable' },
    });
    assert.equal(audits.length, 1);

    // 幂等回放：不再调用 Cognito、不再写审计
    const replay = await h.disableUser(req(superAdmin, { params: { userId: target.userId } }));
    assert.equal(replay.status, 200);
    assert.equal(calls.filter((c) => c.method === 'disableUser').length, 1);
    assert.equal(
      (await prisma.auditLog.findMany({ where: { objectId: target.userId, action: 'user.disable' } })).length,
      1,
    );

    // 自我停用 → 403（专用 actor，其 actorId 即目标 cognitoSub）
    const selfActor: ActorContext = { ...superAdmin, actorId: 'sub-self-disable' };
    const self = await plantUser({ roles: ['PlatformSuperAdmin'], cognitoSub: selfActor.actorId });
    const selfRes = await h.disableUser(req(selfActor, { params: { userId: self.userId } }));
    assert.equal(selfRes.status, 403);

    // 最后一个非停用 SuperAdmin 停用 → 409（self 是当前唯一非停用 SuperAdmin，换 actor 操作）
    await prisma.user.updateMany({
      where: {
        roles: { some: { roleCode: 'PlatformSuperAdmin' } },
        id: { not: self.userId },
      },
      data: { status: 'DISABLED' },
    });
    const otherAdmin: ActorContext = { ...superAdmin, actorId: 'sub-other-admin' };
    const lastRes = await h.disableUser(req(otherAdmin, { params: { userId: self.userId } }));
    assert.equal(lastRes.status, 409);
  });

  test('密码重置触发：响应仅 {userId,status} 不含凭证；DISABLED 用户 → 409；审计齐备', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const target = await plantUser({ roles: ['Auditor'] });

    const res = await h.triggerPasswordReset(req(superAdmin, { params: { userId: target.userId } }));
    assert.equal(res.status, 200);
    const data = (res.body as DataBody).data;
    assert.deepEqual(Object.keys(data).sort(), ['status', 'userId']);
    assert.equal(data.status, 'RESET_TRIGGERED');
    expectNoCredentialLeak(res.body);
    assert.equal(calls[0]?.method, 'triggerPasswordReset');
    assert.deepEqual(calls[0]?.input, { cognitoSub: target.cognitoSub });

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'user', objectId: target.userId, action: 'user.password_reset.trigger' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');

    const disabled = await plantUser({ roles: ['Auditor'], status: 'DISABLED' });
    const res2 = await h.triggerPasswordReset(req(superAdmin, { params: { userId: disabled.userId } }));
    assert.equal(res2.status, 409);

    const ghost = await h.triggerPasswordReset(req(superAdmin, { params: { userId: 'user-ghost' } }));
    assert.equal(ghost.status, 404);
  });
});

describe('CMP T02 / R07 R08 账号启停', () => {
  test('生产适配器命令、列表读回、重复启停和重新登录保持一致', async () => {
    const target = await plantUser({ roles: ['Auditor'] });
    let identityEnabled = true;
    const commands: string[] = [];
    const port = createCognitoAdminPort({
      userPoolId: 'test-pool',
      client: {
        async send(command) {
          const request = command as { constructor: { name: string }; input: Record<string, unknown> };
          assert.equal(request.input.UserPoolId, 'test-pool');
          if (request.constructor.name === 'ListUsersCommand') {
            assert.equal(request.input.Filter, `sub = "${target.cognitoSub}"`);
            return { Users: [{ Username: 'managed-account' }] };
          }
          assert.equal(request.input.Username, 'managed-account');
          assert.include(['AdminDisableUserCommand', 'AdminEnableUserCommand'], request.constructor.name);
          commands.push(request.constructor.name);
          identityEnabled = request.constructor.name === 'AdminEnableUserCommand';
          return {};
        },
      },
    });
    const keys = await generateTestKeySet();
    const oldest = Math.floor(NOW.getTime() / 1000);
    const tokenFor = (tokenUse: 'id' | 'access', authenticatedAtSeconds: number) =>
      signToken(keys, {
        tokenUse,
        sub: target.cognitoSub,
        groups: ['Auditor'],
        authenticatedAtSeconds,
      });
    const read = createAdminLambdaRouter(
      testConfig(keys.jwks),
      () => async (request) => ({
        status: request.actor?.roles.includes('Auditor') ? 200 : 403,
        body: {},
      }),
      {
        onAuthenticated: async (actor, requestId) => {
          await activateInvitedUserOnAuthenticatedRequest({ client: prisma }, actor, requestId);
        },
      },
    );
    const readWith = (jwt: string) =>
      read({
        httpMethod: 'GET',
        headers: { authorization: `Bearer ${jwt}` },
        requestContext: { requestId: 'status-auth' },
      });
    const h = createAdminUserHandlers(userDeps(port));
    const mutation = req(superAdmin, { params: { userId: target.userId } });
    const oldTokens = await Promise.all([tokenFor('id', oldest - 1), tokenFor('access', oldest)]);
    assert.equal((await readWith(oldTokens[0]!)).statusCode, 200);
    const assertList = async (status: string) => {
      const result = await h.listUsers(req(superAdmin, { query: { status, q: `planted-${seq}@` } }));
      const listed = (result.body as ListBody).data.find((item) => item.userId === target.userId);
      assert.equal(listed?.status, status);
      assert.deepEqual(listed?.roles, ['Auditor']);
    };

    const disabled = await h.disableUser(mutation);
    assertOpenApiResponse('disableUser', 200, disabled.body);
    assert.equal((disabled.body as DataBody).data.status, 'DISABLED');
    assert.isFalse(identityEnabled);
    assert.deepEqual((await h.disableUser(mutation)).body, disabled.body);
    await assertList('DISABLED');
    for (const token of oldTokens) assert.equal((await readWith(token)).statusCode, 401);

    const enabled = await h.enableUser(mutation);
    assertOpenApiResponse('enableUser', 200, enabled.body);
    assert.equal((enabled.body as DataBody).data.status, 'ACTIVE');
    assert.isTrue(identityEnabled);
    assert.deepEqual((await h.enableUser(mutation)).body, enabled.body);
    await assertList('ACTIVE');
    for (const token of oldTokens) assert.equal((await readWith(token)).statusCode, 401);
    assert.equal((await readWith(await tokenFor('access', oldest + 1))).statusCode, 200);
    assert.deepEqual(commands, ['AdminDisableUserCommand', 'AdminEnableUserCommand']);
    const audits = await prisma.auditLog.findMany({ where: { objectId: target.userId } });
    assert.lengthOf(audits, 2);
    const enableAudit = audits.find((audit) => audit.action === 'user.enable');
    assert.equal(enableAudit?.result, 'SUCCESS');
    assert.deepEqual(enableAudit?.beforeValue, { status: 'DISABLED' });
    assert.deepEqual(enableAudit?.afterValue, { status: 'ACTIVE' });
  });

  test.each(['INVITED', 'DISABLED'])('未完成邀请和无历史停用账号 (%s) 恢复到 INVITED', async (status) => {
    const target = await plantUser({ roles: ['Auditor'], status });
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const mutation = req(superAdmin, { params: { userId: target.userId } });
    if (status === 'INVITED') assert.equal((await h.disableUser(mutation)).status, 200);
    const enabled = await h.enableUser(mutation);
    assert.equal(enabled.status, 200);
    assert.equal((enabled.body as DataBody).data.status, 'INVITED');
    assert.deepEqual((await h.enableUser(mutation)).body, enabled.body);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.userId } });
    assert.equal(row.status, 'INVITED');
    assert.isNotNull(row.lastDisabledAt);
    const actor: ActorContext = {
      ...operator,
      actorId: target.cognitoSub,
      roles: ['Auditor'],
      authenticatedAt: new Date(row.lastDisabledAt!.getTime() + 1000).toISOString(),
    };
    assert.isTrue(await activateInvitedUserOnAuthenticatedRequest({ client: prisma }, actor, 'after-enable'));
    assert.equal(((await h.enableUser(mutation)).body as DataBody).data.status, 'ACTIVE');
    assert.lengthOf(
      calls.filter((call) => call.method === 'enableUser'),
      1,
    );
  });

  test('未授权、非法实体、缺少身份和不存在的账号不调用 Cognito', async () => {
    const target = await plantUser({ roles: ['Auditor'], status: 'DISABLED' });
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const params = { userId: target.userId };
    for (const roles of [['PlatformOperator'], ['Auditor'], ['CustomerAdmin'], ['CustomerViewer']] as const) {
      const result = await h.enableUser(req({ ...operator, roles }, { params }));
      assert.equal(result.status, 403);
      assertOpenApiResponse('enableUser', 403, result.body);
    }
    assert.equal((await h.enableUser(req(undefined, { params }))).status, 401);
    assert.equal((await h.enableUser(req(superAdmin, { params, body: {} }))).status, 400);
    assert.equal((await h.enableUser(req(superAdmin, { params: { userId: 'absent' } }))).status, 404);
    await prisma.user.update({ where: { id: target.userId }, data: { cognitoSub: null } });
    assert.equal((await h.enableUser(req(superAdmin, { params }))).status, 409);
    assert.equal((await h.disableUser(req(superAdmin, { params }))).status, 200);
    assert.deepEqual(calls, []);
  });

  test('重复并发启用只执行和审计一次；排队停用读到已提交的状态', async () => {
    const target = await plantUser({ roles: ['Auditor'], status: 'DISABLED' });
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const mutation = req(superAdmin, { params: { userId: target.userId } });
    const enabled = await Promise.all([h.enableUser(mutation), h.enableUser(mutation)]);
    assert.deepEqual(
      enabled.map((response) => response.status),
      [200, 200],
    );
    assert.deepEqual(enabled[0]?.body, enabled[1]?.body);
    assert.deepEqual(
      calls.map((call) => call.method),
      ['enableUser'],
    );
    assert.equal(await prisma.auditLog.count({ where: { objectId: target.userId, action: 'user.enable' } }), 1);

    let atCognito!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      atCognito = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const concurrent = createAdminUserHandlers(
      userDeps({
        ...port,
        async disableUser(input) {
          await port.disableUser(input);
          atCognito();
          await paused;
        },
      }),
    );
    const disabling = concurrent.disableUser(mutation);
    await started;
    const enabling = concurrent.enableUser(mutation);
    resume();
    const pair = await Promise.all([disabling, enabling]);
    assert.deepEqual(
      pair.map((result) => result.status),
      [200, 200],
    );
    assert.deepEqual(
      pair.map((result) => (result.body as DataBody).data.status),
      ['DISABLED', 'INVITED'],
    );
    assert.deepEqual(
      calls.map((call) => call.method),
      ['enableUser', 'disableUser', 'enableUser'],
    );
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).status, 'INVITED');
  });

  test.each(['not-applied', 'applied', 'database'])('启用失败 (%s) 时补偿并保留停用和失败审计', async (scenario) => {
    const target = await plantUser({ roles: ['Auditor'], status: 'DISABLED' });
    const { port } = fakeCognito();
    let identityEnabled = false;
    const failingClient = prisma.$extends({
      query: {
        user: {
          async updateMany() {
            throw new Error('controlled status write failure');
          },
        },
      },
    });
    const h = createAdminUserHandlers({
      client: scenario === 'database' ? (failingClient as unknown as UserAdminDeps['client']) : prisma,
      cognito: {
        ...port,
        async enableUser() {
          if (scenario !== 'not-applied') identityEnabled = true;
          if (scenario !== 'database') throw new Error('controlled Cognito failure');
        },
        async disableUser() {
          identityEnabled = false;
        },
      },
    });
    const result = await h.enableUser(req(superAdmin, { params: { userId: target.userId } }));
    assert.equal(result.status, 500);
    assertOpenApiResponse('enableUser', 500, result.body);
    assert.isFalse(identityEnabled);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).status, 'DISABLED');
    const intent = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: target.userId } });
    assert.equal(intent.status, 'PUBLISHED');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { objectId: target.userId, action: 'user.enable' } });
    assert.equal(audit.result, 'FAILURE');
  });

  test('部分生效且补偿失败时保留待对账意图；重复停用恢复一致性', async () => {
    const target = await plantUser({ roles: ['Auditor'], status: 'DISABLED' });
    const { port } = fakeCognito();
    let identityEnabled = false;
    let failCompensation = true;
    const h = createAdminUserHandlers(
      userDeps({
        ...port,
        async enableUser() {
          identityEnabled = true;
          throw new Error('response lost');
        },
        async disableUser() {
          if (failCompensation) throw new Error('Cognito unavailable');
          identityEnabled = false;
        },
      }),
    );
    const mutation = req(superAdmin, { params: { userId: target.userId } });
    assert.equal((await h.enableUser(mutation)).status, 500);
    assert.isTrue(identityEnabled);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: target.userId } })).status, 'DISABLED');
    const pending = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: target.userId, status: 'PENDING', lastError: 'RECONCILIATION_REQUIRED' },
    });
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: target.userId, action: 'user.cognito.reconciliation_required', result: 'FAILURE' },
      }),
      1,
    );
    failCompensation = false;
    assert.equal((await h.disableUser(mutation)).status, 200);
    assert.isFalse(identityEnabled);
    assert.equal((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: pending.id } })).status, 'PUBLISHED');
    assert.equal(await prisma.auditLog.count({ where: { objectId: target.userId, action: 'user.disable' } }), 0);
  });
});

// ---------- 列表 ----------

describe('BE-RBAC-01 用户列表', () => {
  test('筛选（roleType/status/customerId/q）+ 键集游标分页；视图不泄露 cognitoSub；非法筛选 → 400', async () => {
    const { port } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const customerX = await plantCustomer();
    const u1 = await plantUser({ roles: ['PlatformOperator'] });
    const u2 = await plantUser({ roles: ['CustomerAdmin'], customerId: customerX });
    await plantUser({ roles: ['CustomerViewer'], customerId: customerX, status: 'DISABLED' });

    const all = await h.listUsers(req(superAdmin, { query: {} }));
    assert.ok((all.body as ListBody).data.length >= 3);
    assert.ok(!('cognitoSub' in (all.body as ListBody).data[0]!));

    const platform = await h.listUsers(req(superAdmin, { query: { roleType: 'platform' } }));
    assert.ok((platform.body as ListBody).data.some((u) => u.userId === u1.userId));
    assert.ok(!(platform.body as ListBody).data.some((u) => u.userId === u2.userId));

    const byCustomer = await h.listUsers(req(superAdmin, { query: { customerId: customerX } }));
    assert.ok((byCustomer.body as ListBody).data.length >= 2);
    assert.ok((byCustomer.body as ListBody).data.every((u) => u.customerId === customerX));

    const disabledOnly = await h.listUsers(req(superAdmin, { query: { status: 'DISABLED', roleType: 'customer' } }));
    assert.ok((disabledOnly.body as ListBody).data.every((u) => u.status === 'DISABLED'));

    const searched = await h.listUsers(req(superAdmin, { query: { q: `planted-${seq}` } }));
    assert.equal((searched.body as ListBody).data.length, 1);

    // 分页
    const page1 = await h.listUsers(req(superAdmin, { query: { customerId: customerX, limit: '1' } }));
    assert.equal((page1.body as ListBody).data.length, 1);
    assert.ok((page1.body as ListBody).meta.nextCursor);
    const page2 = await h.listUsers(
      req(superAdmin, {
        query: { customerId: customerX, limit: '1', cursor: (page1.body as ListBody).meta.nextCursor },
      }),
    );
    assert.equal((page2.body as ListBody).data.length, 1);
    assert.notEqual((page1.body as ListBody).data[0]?.userId, (page2.body as ListBody).data[0]?.userId);

    // 非法筛选 → 400
    assert.equal((await h.listUsers(req(superAdmin, { query: { roleType: 'root' } }))).status, 400);
    assert.equal((await h.listUsers(req(superAdmin, { query: { status: 'BANNED' } }))).status, 400);
  });
});
