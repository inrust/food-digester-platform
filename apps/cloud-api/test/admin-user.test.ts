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
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { assignUserRoles, createAdminUserHandlers, inviteUser, setUserScope } from '../src/index.js';
import type { AdminHttpRequest, CognitoAdminPort, UserAdminDeps } from '../src/index.js';
import { createTestDb } from './helpers.js';

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

// ---------- 邀请 ----------

describe('BE-RBAC-01 邀请用户', () => {
  test('成功：平台角色邀请 → 201 + Cognito 同步 + 角色落库 + 审计；响应不含凭证', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const res = await h.inviteUser(
      req(superAdmin, {
        body: { email: 'New.Admin@Example.com', displayName: 'New Admin', roles: ['Auditor'] },
      }),
    );
    assert.equal(res.status, 201);
    const view = (res.body as DataBody).data;
    assert.equal(view.email, 'new.admin@example.com'); // 规范化
    assert.equal(view.status, 'INVITED');
    assert.deepEqual(view.roles, ['Auditor']);
    assert.equal(view.customerId, null);
    expectNoCredentialLeak(res.body);

    // Cognito 同步：groups 去重、customerId null
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'inviteUser');
    assert.deepEqual(calls[0]?.input, { email: 'new.admin@example.com', groups: ['Auditor'], customerId: null });

    const row = await prisma.user.findUnique({ where: { id: view.userId } });
    assert.ok(row?.cognitoSub);

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'user', objectId: view.userId, action: 'user.invite' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.result, 'SUCCESS');
    assert.equal(audits[0]?.actorId, superAdmin.actorId);
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
    const valid = { email: 'strict@example.com', displayName: 'Strict', roles: ['Auditor'] };
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
        body: { email: existingEmail, displayName: 'Dup', roles: ['Auditor'] },
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

// ---------- 角色分配 ----------

describe('BE-RBAC-01 角色分配（整体替换）', () => {
  test('成功：Cognito groups 先行 + 落库 + 审计（before/after）', async () => {
    const { port, calls } = fakeCognito();
    const h = createAdminUserHandlers(userDeps(port));
    const target = await plantUser({ roles: ['Auditor'] });
    const res = await h.assignRoles(
      req(superAdmin, { params: { userId: target.userId }, body: { roles: ['PlatformOperator'] } }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual((res.body as DataBody).data.roles, ['PlatformOperator']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, 'setUserGroups');
    assert.deepEqual(calls[0]?.input, { cognitoSub: target.cognitoSub, groups: ['PlatformOperator'] });

    const audits = await prisma.auditLog.findMany({
      where: { objectType: 'user', objectId: target.userId, action: 'user.role.assign' },
    });
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0]?.beforeValue, { roles: ['Auditor'] });
    assert.deepEqual(audits[0]?.afterValue, { roles: ['PlatformOperator'] });
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
    assert.deepEqual(groupCalls[0]?.input.groups, ['PlatformOperator']);
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
