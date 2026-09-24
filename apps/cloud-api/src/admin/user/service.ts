/**
 * BE-RBAC-01 用户/角色/Scope 管理领域服务（框架无关）。
 *
 * 规则（事实源：AUTH-01 角色模型/权限矩阵、DEC-012@1.0.0 原型角色映射与固定矩阵）：
 * - 角色封闭集（5 个，@fdp/auth ROLES）；平台/Customer 角色禁止混绑（单一 actorType）；
 *   平台角色无 Customer scope（customerId 恒 null）；角色类型（platform/customer）创建后不可变；
 * - 只有 PlatformSuperAdmin 可变更平台角色（user:write 矩阵 + 服务层双重校验）；
 *   CustomerAdmin 不可提升为平台角色；Customer actor 不得跨 Customer 授权；
 * - 自我提权/自我角色变更/自我停用拒绝（目标 cognitoSub === actor.actorId）；
 * - 最后一个非停用 PlatformSuperAdmin 不可被移除角色或停用；
 * - 邀请/密码重置的临时凭证由 Cognito 生成并发送（CognitoAdminPort），本服务不接触密码；
 * - 外部变更前先持久化 COGNITO_ADMIN_RECONCILIATION 意图；Cognito 调用置于 audited
 *   事务内，DB 失败确定性恢复 Groups/Scope/Enabled 状态；结果不确定或补偿失败时保留
 *   PENDING 对账意图并写 reconciliation_required 失败审计，禁止静默形成权限漂移；
 * - 所有权限变化审计（DOM-03）：user.invite / user.activate / user.role.assign /
 *   user.scope.change / user.disable / user.password_reset.trigger；
 * - 功能边界：不负责 Cognito 租户运维、MFA 客服重置和人工账号恢复。
 */
import { randomUUID } from 'node:crypto';
import type { DbClient, Page } from '@fdp/database';
import {
  audited,
  decodeKeysetCursor,
  encodeKeysetCursor,
  normalizeLimit,
  recordAudit,
  withTransaction,
} from '@fdp/database';
import type { ActorContext, Role } from '@fdp/auth';
import { CUSTOMER_ROLES, PLATFORM_ROLES, actorTypeOf, isRole } from '@fdp/auth';
import { userConflict, userForbidden, userNotFound, userValidationFailed } from './errors.js';
import type { CognitoAdminPort } from './cognito-port.js';

export interface UserAdminDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
  readonly cognito: CognitoAdminPort;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_STATUSES = ['INVITED', 'ACTIVE', 'DISABLED'] as const;
const SUPER_ADMIN_ROLE = 'PlatformSuperAdmin' as const;

// ---------- 行类型与数据访问 ----------

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly cognitoSub: string | null;
  readonly status: string;
  readonly mfaEnabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface UserRoleRow {
  readonly userId: string;
  readonly roleCode: string;
}

interface UserScopeRow {
  readonly id: string;
  readonly userId: string;
  readonly customerId: string | null;
}

interface TableDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<never>;
  findMany(args: Record<string, unknown>): Promise<never[]>;
  create(args: { data: Record<string, unknown> }): Promise<never>;
  createMany(args: { data: readonly Record<string, unknown>[] }): Promise<unknown>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

interface OutboxDelegate {
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function table(client: DbClient, name: string): TableDelegate {
  return (client as unknown as Record<string, unknown>)[name] as TableDelegate;
}

const users = (c: DbClient) => table(c, 'user');
const userRoles = (c: DbClient) => table(c, 'userRole');
const userScopes = (c: DbClient) => table(c, 'userScope');
const customers = (c: DbClient) => table(c, 'customer');
const outbox = (c: DbClient) => (c as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;

async function lockSuperAdminInvariant(client: DbClient): Promise<void> {
  await (client as DbClient & { $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> }).$queryRawUnsafe(
    'SELECT code FROM "roles" WHERE code = $1 FOR UPDATE',
    SUPER_ADMIN_ROLE,
  );
}

async function startCognitoReconciliationIntent(
  client: DbClient,
  userId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await outbox(client).create({
    data: {
      id,
      eventType: 'COGNITO_ADMIN_RECONCILIATION',
      aggregateType: 'user',
      aggregateId: userId,
      idempotencyKey: `cognito-reconciliation:${id}`,
      payload: { action, ...payload },
      status: 'PENDING',
    },
  });
  return id;
}

async function resolveCognitoIntent(client: DbClient, intentId: string, now: Date): Promise<void> {
  await outbox(client).updateMany({
    where: { id: intentId, status: 'PENDING' },
    data: { status: 'PUBLISHED', publishedAt: now, lastError: null },
  });
}

async function markCognitoReconciliationRequired(
  deps: UserAdminDeps,
  actor: ActorContext,
  userId: string,
  intentId: string,
  action: string,
): Promise<void> {
  await Promise.allSettled([
    outbox(deps.client).updateMany({
      where: { id: intentId, status: 'PENDING' },
      data: { retryCount: { increment: 1 }, lastError: 'RECONCILIATION_REQUIRED' },
    }),
    recordAudit(deps.client, {
      objectType: 'user',
      objectId: userId,
      action: 'user.cognito.reconciliation_required',
      result: 'FAILURE',
      reason: action,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      afterValue: { reconciliationIntentId: intentId },
    }),
  ]);
}

async function compensateCognito(
  deps: UserAdminDeps,
  actor: ActorContext,
  userId: string,
  intentId: string,
  action: string,
  compensation: () => Promise<void>,
  now: Date,
): Promise<void> {
  try {
    await compensation();
    await resolveCognitoIntent(deps.client, intentId, now);
  } catch {
    await markCognitoReconciliationRequired(deps, actor, userId, intentId, action);
  }
}

// ---------- DTO ----------

export interface UserView {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: string;
  readonly mfaEnabled: boolean;
  readonly roles: readonly string[];
  readonly customerId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

async function toUserView(client: DbClient, row: UserRow): Promise<UserView> {
  const [roles, scopes] = await Promise.all([
    userRoles(client).findMany({ where: { userId: row.id } }) as unknown as Promise<UserRoleRow[]>,
    userScopes(client).findMany({ where: { userId: row.id } }) as unknown as Promise<UserScopeRow[]>,
  ]);
  return {
    userId: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    mfaEnabled: row.mfaEnabled,
    roles: roles.map((r) => r.roleCode).sort(),
    customerId: scopes.find((s) => s.customerId !== null)?.customerId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

// ---------- 首次认证状态收敛 ----------

export interface AuthenticatedUserSyncDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

/**
 * Cognito 完成首次登录后，在第一个通过验签的管理 API 请求中把对应业务用户激活。
 * 条件更新保证并发/重复请求至多迁移一次，状态更新与 SUCCESS 审计同事务提交。
 */
export async function activateInvitedUserOnAuthenticatedRequest(
  deps: AuthenticatedUserSyncDeps,
  actor: ActorContext,
  requestId: string,
): Promise<boolean> {
  const now = deps.now?.() ?? new Date();
  const target = (await users(deps.client).findFirst({
    where: { cognitoSub: actor.actorId },
  })) as unknown as UserRow | null;
  if (!target || target.status !== 'INVITED') return false;

  return withTransaction(deps.client, async (tx) => {
    const updated = await users(tx).updateMany({
      where: { id: target.id, cognitoSub: actor.actorId, status: 'INVITED' },
      data: { status: 'ACTIVE', updatedAt: now },
    });
    if (updated.count !== 1) return false;

    await recordAudit(tx, {
      objectType: 'user',
      objectId: target.id,
      action: 'user.activate',
      result: 'SUCCESS',
      reason: 'first authenticated admin API request',
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: actor.customerId,
      requestId,
      beforeValue: { status: 'INVITED' },
      afterValue: { status: 'ACTIVE' },
    });
    return true;
  });
}

// ---------- 角色集校验 ----------

/** 角色集校验：封闭集 + 非空 + 平台/Customer 禁止混绑。返回 actorType。 */
function validateRoleSet(roleCodes: readonly string[]): 'platform' | 'customer' {
  if (roleCodes.length === 0) throw userValidationFailed('roles must not be empty');
  for (const code of roleCodes) {
    if (!isRole(code)) throw userValidationFailed(`Unknown role: ${code}`);
  }
  const types = new Set(roleCodes.map((r) => actorTypeOf(r as Role)));
  if (types.size !== 1) throw userValidationFailed('Platform and customer roles must not be mixed');
  return [...types][0] as 'platform' | 'customer';
}

/** Customer 必须存在且可用（ACTIVE 且未软删除）。 */
async function assertUsableCustomer(client: DbClient, customerId: string): Promise<void> {
  const customer = (await customers(client).findFirst({
    where: { id: customerId },
  })) as unknown as { status: string; deletedAt: Date | null } | null;
  if (!customer) throw userNotFound();
  if (customer.deletedAt !== null || customer.status !== 'ACTIVE') {
    throw userConflict('The customer is not active');
  }
}

/** Customer actor 不得跨 Customer 授权；且不可涉及平台角色。 */
function assertCustomerActorScope(
  actor: ActorContext,
  roleType: 'platform' | 'customer',
  customerId: string | null,
): void {
  if (actor.actorType !== 'customer') return;
  if (roleType === 'platform') {
    throw userForbidden('A customer actor cannot grant platform roles');
  }
  if (!customerId || customerId !== actor.customerId) {
    throw userForbidden('A customer actor cannot grant access outside its own customer');
  }
}

/** 平台角色变更仅 PlatformSuperAdmin（服务层双重校验；矩阵层 user:write 已限 SuperAdmin）。 */
function assertPlatformRoleChangeAllowed(actor: ActorContext, roleType: 'platform' | 'customer'): void {
  if (roleType === 'platform' && !actor.roles.includes(SUPER_ADMIN_ROLE)) {
    throw userForbidden('Only PlatformSuperAdmin can change platform roles');
  }
}

/** 自我操作防护：角色变更/停用不得作用于自己（目标 cognitoSub === actor.actorId）。 */
function assertNotSelf(target: UserRow, actor: ActorContext, action: string): void {
  if (target.cognitoSub !== null && target.cognitoSub === actor.actorId) {
    throw userForbidden(`An actor cannot ${action} itself`);
  }
}

/** 最后一个非停用 PlatformSuperAdmin 不可被移除角色或停用。 */
async function assertNotLastSuperAdmin(client: DbClient, target: UserRow, removingSuperAdmin: boolean): Promise<void> {
  if (!removingSuperAdmin) return;
  const others = await users(client).count({
    where: {
      id: { not: target.id },
      status: { not: 'DISABLED' },
      roles: { some: { roleCode: SUPER_ADMIN_ROLE } },
    },
  });
  if (others === 0) {
    throw userConflict('The last active PlatformSuperAdmin cannot be removed or disabled');
  }
}

// ---------- 列表 ----------

export interface ListUsersFilter {
  readonly roleType?: string | undefined;
  readonly status?: string | undefined;
  readonly customerId?: string | undefined;
  readonly q?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

export async function listUsers(
  deps: UserAdminDeps,
  _actor: ActorContext,
  filter: ListUsersFilter = {},
): Promise<Page<UserView>> {
  if (filter.roleType !== undefined && filter.roleType !== 'platform' && filter.roleType !== 'customer') {
    throw userValidationFailed('roleType must be one of: platform, customer');
  }
  if (filter.status !== undefined && !(USER_STATUSES as readonly string[]).includes(filter.status)) {
    throw userValidationFailed(`status must be one of: ${USER_STATUSES.join(', ')}`);
  }
  const limit = normalizeLimit(filter.limit ?? null);
  const where: Record<string, unknown> = {};
  if (filter.status) where.status = filter.status;
  if (filter.roleType) {
    where.roles = {
      some: { roleCode: { in: [...(filter.roleType === 'platform' ? PLATFORM_ROLES : CUSTOMER_ROLES)] } },
    };
  }
  if (filter.customerId) where.scopes = { some: { customerId: filter.customerId } };
  if (filter.q) {
    where.OR = [
      { email: { contains: filter.q, mode: 'insensitive' } },
      { displayName: { contains: filter.q, mode: 'insensitive' } },
    ];
  }
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = (await users(deps.client).findMany({
    where,
    orderBy: { id: 'asc' },
    take: limit + 1,
  })) as unknown as UserRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: await Promise.all(page.map((r) => toUserView(deps.client, r))),
    nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null,
  };
}

// ---------- 邀请 ----------

export interface InviteUserInput {
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly customerId?: string | undefined;
}

export async function inviteUser(deps: UserAdminDeps, actor: ActorContext, input: InviteUserInput): Promise<UserView> {
  const now = deps.now?.() ?? new Date();
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!EMAIL_PATTERN.test(email) || email.length > 254)
    throw userValidationFailed('email must be a valid email address');
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (displayName.length === 0 || displayName.length > 128) {
    throw userValidationFailed('displayName is required and must not exceed 128 characters');
  }
  const roleType = validateRoleSet(input.roles);
  const customerId = input.customerId ?? null;
  if (roleType === 'platform' && customerId !== null) {
    throw userValidationFailed('Platform roles must not carry a customer scope');
  }
  if (roleType === 'customer') {
    if (!customerId) throw userValidationFailed('customerId is required for customer roles');
    await assertUsableCustomer(deps.client, customerId);
  }
  assertCustomerActorScope(actor, roleType, customerId);
  assertPlatformRoleChangeAllowed(actor, roleType);

  const duplicate = await users(deps.client).findFirst({ where: { email } });
  if (duplicate) throw userConflict('A user with this email already exists');

  const userId = randomUUID();
  const roles = [...new Set(input.roles)];
  const intentId = await startCognitoReconciliationIntent(deps.client, userId, 'INVITE', {
    email,
    after: { roles, customerId },
  });
  let invited: { readonly cognitoSub: string } | undefined;
  let cognitoAttempted = false;
  try {
    const result = await audited<UserView>(
      deps.client,
      {
        objectType: 'user',
        objectId: userId,
        action: 'user.invite',
        reason: `roles=${[...input.roles].sort().join(',')}`,
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        customerId,
        afterValue: (v: unknown) => {
          const view = v as UserView;
          return { userId, email, roles: view.roles, customerId: view.customerId, status: view.status };
        },
      },
      async (tx) => {
        cognitoAttempted = true;
        invited = await deps.cognito.inviteUser({ email, groups: roles, customerId });
        const row = (await users(tx).create({
          data: {
            id: userId,
            email,
            displayName,
            cognitoSub: invited.cognitoSub,
            status: 'INVITED',
            createdAt: now,
            updatedAt: now,
          },
        })) as unknown as UserRow;
        await userRoles(tx).createMany({
          data: roles.map((roleCode) => ({ userId, roleCode, createdAt: now })),
        });
        if (roleType === 'customer' && customerId) {
          await userScopes(tx).create({ data: { id: randomUUID(), userId, customerId } });
        }
        return toUserView(tx, row);
      },
    );
    await resolveCognitoIntent(deps.client, intentId, now).catch(() => undefined);
    return result;
  } catch (err) {
    if (invited) {
      await compensateCognito(
        deps,
        actor,
        userId,
        intentId,
        'INVITE',
        () => deps.cognito.deleteUser({ cognitoSub: invited!.cognitoSub }),
        now,
      );
    } else if (cognitoAttempted) {
      await markCognitoReconciliationRequired(deps, actor, userId, intentId, 'INVITE');
    } else {
      await resolveCognitoIntent(deps.client, intentId, now).catch(() => undefined);
    }
    if (isUniqueViolation(err)) throw userConflict('A user with this email already exists');
    throw err;
  }
}

// ---------- 角色分配（整体替换） ----------

export async function assignUserRoles(
  deps: UserAdminDeps,
  actor: ActorContext,
  userId: string,
  input: { readonly roles: readonly string[] },
): Promise<UserView> {
  const now = deps.now?.() ?? new Date();
  const target = (await users(deps.client).findFirst({ where: { id: userId } })) as unknown as UserRow | null;
  if (!target) throw userNotFound();
  const currentRoles = (
    (await userRoles(deps.client).findMany({
      where: { userId },
    })) as unknown as UserRoleRow[]
  ).map((r) => r.roleCode);
  const currentType = currentRoles.length > 0 ? actorTypeOf(currentRoles[0] as Role) : null;

  const nextRoles = [...new Set(input.roles)];
  const nextType = validateRoleSet(nextRoles);

  assertNotSelf(target, actor, 'change the roles of');
  assertPlatformRoleChangeAllowed(actor, nextType);
  // CustomerAdmin 不可提升为平台角色；角色类型（platform/customer）创建后不可变
  if (currentType !== null && nextType !== currentType) {
    throw userForbidden('Changing between platform and customer role types is not allowed');
  }
  if (actor.actorType === 'customer') {
    const scope = (await userScopes(deps.client).findFirst({ where: { userId } })) as unknown as UserScopeRow | null;
    assertCustomerActorScope(actor, nextType, scope?.customerId ?? null);
  }
  if (!target.cognitoSub) throw userConflict('The user has no Cognito identity');
  const intentId = await startCognitoReconciliationIntent(deps.client, userId, 'SET_GROUPS', {
    cognitoSub: target.cognitoSub,
    before: { roles: [...currentRoles].sort() },
    after: { roles: [...nextRoles].sort() },
  });
  let cognitoApplied = false;
  let cognitoAttempted = false;
  let lockedCurrentRoles = currentRoles;
  try {
    const result = await audited<UserView>(
      deps.client,
      {
        objectType: 'user',
        objectId: userId,
        action: 'user.role.assign',
        reason: `roles ${currentRoles.sort().join(',')} → ${nextRoles.sort().join(',')}`,
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        customerId: null,
        beforeValue: { roles: currentRoles.sort() },
        afterValue: { roles: [...nextRoles].sort() },
      },
      async (tx) => {
        await lockSuperAdminInvariant(tx);
        const lockedTarget = (await users(tx).findFirst({ where: { id: userId } })) as unknown as UserRow | null;
        if (!lockedTarget) throw userNotFound();
        lockedCurrentRoles = ((await userRoles(tx).findMany({ where: { userId } })) as unknown as UserRoleRow[]).map(
          (role) => role.roleCode,
        );
        const removingSuperAdmin =
          lockedCurrentRoles.includes(SUPER_ADMIN_ROLE) && !nextRoles.includes(SUPER_ADMIN_ROLE);
        await assertNotLastSuperAdmin(tx, lockedTarget, removingSuperAdmin && lockedTarget.status !== 'DISABLED');
        cognitoAttempted = true;
        await deps.cognito.setUserGroups({ cognitoSub: target.cognitoSub!, groups: nextRoles });
        cognitoApplied = true;
        await userRoles(tx).deleteMany({ where: { userId } });
        await userRoles(tx).createMany({
          data: nextRoles.map((roleCode) => ({ userId, roleCode, createdAt: now })),
        });
        await users(tx).updateMany({ where: { id: userId }, data: { updatedAt: now } });
        const fresh = (await users(tx).findFirst({ where: { id: userId } })) as unknown as UserRow;
        return toUserView(tx, fresh);
      },
    );
    await resolveCognitoIntent(deps.client, intentId, now).catch(() => undefined);
    return result;
  } catch (err) {
    if (cognitoApplied) {
      await compensateCognito(
        deps,
        actor,
        userId,
        intentId,
        'SET_GROUPS',
        () => deps.cognito.setUserGroups({ cognitoSub: target.cognitoSub!, groups: lockedCurrentRoles }),
        now,
      );
    } else if (cognitoAttempted) {
      await markCognitoReconciliationRequired(deps, actor, userId, intentId, 'SET_GROUPS');
    } else {
      await resolveCognitoIntent(deps.client, intentId, now).catch(() => undefined);
    }
    throw err;
  }
}

// ---------- Customer scope 变更 ----------

export async function setUserScope(
  deps: UserAdminDeps,
  actor: ActorContext,
  userId: string,
  input: { readonly customerId: string },
): Promise<UserView> {
  const now = deps.now?.() ?? new Date();
  const target = (await users(deps.client).findFirst({ where: { id: userId } })) as unknown as UserRow | null;
  if (!target) throw userNotFound();
  const roles = (
    (await userRoles(deps.client).findMany({
      where: { userId },
    })) as unknown as UserRoleRow[]
  ).map((r) => r.roleCode);
  if (roles.length === 0 || roles.some((r) => (PLATFORM_ROLES as readonly string[]).includes(r))) {
    throw userValidationFailed('Only customer-role users carry a customer scope');
  }
  await assertUsableCustomer(deps.client, input.customerId);
  assertCustomerActorScope(actor, 'customer', input.customerId);

  const before = (await userScopes(deps.client).findMany({ where: { userId } })) as unknown as UserScopeRow[];
  const beforeCustomerId = before.find((s) => s.customerId !== null)?.customerId ?? null;

  if (!target.cognitoSub) throw userConflict('The user has no Cognito identity');
  const intentId = await startCognitoReconciliationIntent(deps.client, userId, 'SET_CUSTOMER_SCOPE', {
    cognitoSub: target.cognitoSub,
    before: { customerId: beforeCustomerId },
    after: { customerId: input.customerId },
  });
  let cognitoApplied = false;
  let cognitoAttempted = false;
  try {
    const result = await audited<UserView>(
      deps.client,
      {
        objectType: 'user',
        objectId: userId,
        action: 'user.scope.change',
        reason: `customerId ${beforeCustomerId ?? 'null'} → ${input.customerId}`,
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        customerId: input.customerId,
        beforeValue: { customerId: beforeCustomerId },
        afterValue: { customerId: input.customerId },
      },
      async (tx) => {
        cognitoAttempted = true;
        await deps.cognito.setUserCustomerScope({ cognitoSub: target.cognitoSub!, customerId: input.customerId });
        cognitoApplied = true;
        await userScopes(tx).deleteMany({ where: { userId } });
        await userScopes(tx).create({ data: { id: randomUUID(), userId, customerId: input.customerId } });
        await users(tx).updateMany({ where: { id: userId }, data: { updatedAt: now } });
        const fresh = (await users(tx).findFirst({ where: { id: userId } })) as unknown as UserRow;
        return toUserView(tx, fresh);
      },
    );
    await resolveCognitoIntent(deps.client, intentId, now).catch(() => undefined);
    return result;
  } catch (err) {
    if (cognitoApplied) {
      await compensateCognito(
        deps,
        actor,
        userId,
        intentId,
        'SET_CUSTOMER_SCOPE',
        () => deps.cognito.setUserCustomerScope({ cognitoSub: target.cognitoSub!, customerId: beforeCustomerId }),
        now,
      );
    } else if (cognitoAttempted) {
      await markCognitoReconciliationRequired(deps, actor, userId, intentId, 'SET_CUSTOMER_SCOPE');
    } else {
      await resolveCognitoIntent(deps.client, intentId, now).catch(() => undefined);
    }
    throw err;
  }
}

// ---------- 停用 ----------

export async function disableUser(deps: UserAdminDeps, actor: ActorContext, userId: string): Promise<UserView> {
  const now = deps.now?.() ?? new Date();
  const target = (await users(deps.client).findFirst({ where: { id: userId } })) as unknown as UserRow | null;
  if (!target) throw userNotFound();
  if (target.status === 'DISABLED') return toUserView(deps.client, target); // 幂等回放
  assertNotSelf(target, actor, 'disable');
  const roles = (
    (await userRoles(deps.client).findMany({
      where: { userId },
    })) as unknown as UserRoleRow[]
  ).map((r) => r.roleCode);
  if (!target.cognitoSub) throw userConflict('The user has no Cognito identity');
  const intentId = await startCognitoReconciliationIntent(deps.client, userId, 'DISABLE', {
    cognitoSub: target.cognitoSub,
    before: { status: target.status, roles },
    after: { status: 'DISABLED' },
  });
  let cognitoApplied = false;
  let cognitoAttempted = false;
  try {
    const result = await audited<UserView>(
      deps.client,
      {
        objectType: 'user',
        objectId: userId,
        action: 'user.disable',
        reason: `${target.status} → DISABLED`,
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        customerId: null,
        beforeValue: { status: target.status },
        afterValue: { status: 'DISABLED' },
      },
      async (tx) => {
        await lockSuperAdminInvariant(tx);
        const lockedTarget = (await users(tx).findFirst({ where: { id: userId } })) as unknown as UserRow | null;
        if (!lockedTarget) throw userNotFound();
        if (lockedTarget.status === 'DISABLED') return toUserView(tx, lockedTarget);
        const lockedRoles = ((await userRoles(tx).findMany({ where: { userId } })) as unknown as UserRoleRow[]).map(
          (role) => role.roleCode,
        );
        await assertNotLastSuperAdmin(tx, lockedTarget, lockedRoles.includes(SUPER_ADMIN_ROLE));
        cognitoAttempted = true;
        await deps.cognito.disableUser({ cognitoSub: target.cognitoSub! });
        cognitoApplied = true;
        await users(tx).updateMany({ where: { id: userId }, data: { status: 'DISABLED', updatedAt: now } });
        const fresh = (await users(tx).findFirst({ where: { id: userId } })) as unknown as UserRow;
        return toUserView(tx, fresh);
      },
    );
    await resolveCognitoIntent(deps.client, intentId, now).catch(() => undefined);
    return result;
  } catch (err) {
    if (cognitoApplied) {
      await compensateCognito(
        deps,
        actor,
        userId,
        intentId,
        'DISABLE',
        () => deps.cognito.enableUser({ cognitoSub: target.cognitoSub! }),
        now,
      );
    } else if (cognitoAttempted) {
      await markCognitoReconciliationRequired(deps, actor, userId, intentId, 'DISABLE');
    } else {
      await resolveCognitoIntent(deps.client, intentId, now).catch(() => undefined);
    }
    throw err;
  }
}

// ---------- 受控密码重置触发 ----------

export interface PasswordResetResult {
  readonly userId: string;
  readonly status: 'RESET_TRIGGERED';
}

export async function triggerUserPasswordReset(
  deps: UserAdminDeps,
  actor: ActorContext,
  userId: string,
): Promise<PasswordResetResult> {
  const target = (await users(deps.client).findFirst({ where: { id: userId } })) as unknown as UserRow | null;
  if (!target) throw userNotFound();
  if (target.status === 'DISABLED') throw userConflict('A disabled user cannot be reset');
  if (!target.cognitoSub) throw userConflict('The user has no Cognito identity');

  const result: PasswordResetResult = { userId, status: 'RESET_TRIGGERED' };
  const now = deps.now?.() ?? new Date();
  const intentId = await startCognitoReconciliationIntent(deps.client, userId, 'PASSWORD_RESET', {
    cognitoSub: target.cognitoSub,
  });
  let cognitoApplied = false;
  let cognitoAttempted = false;
  try {
    await audited<PasswordResetResult>(
      deps.client,
      {
        objectType: 'user',
        objectId: userId,
        action: 'user.password_reset.trigger',
        reason: 'administrator-triggered password reset',
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        customerId: null,
        afterValue: { status: 'RESET_TRIGGERED' },
      },
      async () => {
        cognitoAttempted = true;
        await deps.cognito.triggerPasswordReset({ cognitoSub: target.cognitoSub! });
        cognitoApplied = true;
        return result;
      },
    );
    await resolveCognitoIntent(deps.client, intentId, now).catch(() => undefined);
    return result;
  } catch (err) {
    if (cognitoApplied || cognitoAttempted) {
      await markCognitoReconciliationRequired(deps, actor, userId, intentId, 'PASSWORD_RESET');
    } else {
      await resolveCognitoIntent(deps.client, intentId, now).catch(() => undefined);
    }
    throw err;
  }
}
