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
 * - 邀请的临时密码、重置的验证码由 Cognito 生成并发送（CognitoAdminPort），本服务不接触密码；
 * - 外部变更前先持久化 COGNITO_ADMIN_RECONCILIATION 意图；Cognito 调用置于 audited
 *   事务内，DB 失败确定性恢复 Groups/Scope/Enabled 状态；结果不确定或补偿失败时保留
 *   PENDING 对账意图并写 reconciliation_required 失败审计，禁止静默形成权限漂移；
 * - 所有权限变化审计（DOM-03）：user.invite / user.activate / user.role.assign /
 *   user.scope.change / user.disable / user.enable / user.password_reset.trigger；
 * - 功能边界：不负责 Cognito 租户运维、MFA 客服重置和人工账号恢复。
 */
import { randomUUID } from 'node:crypto';
import { observeDataPathPhase } from '@fdp/observability';
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
import { CUSTOMER_ROLES, PLATFORM_ROLES, actorTypeOf, isRole, unauthenticated } from '@fdp/auth';
import { userConflict, userForbidden, userNotFound, userValidationFailed } from './errors.js';
import type { CognitoAdminPort } from './cognito-port.js';
import { readAuthenticatedAccount } from './account-read-candidate.js';

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
  readonly lastDisabledAt: Date | null;
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
  /** Explicit test-only R1; runtime guard enforces pool1/engine/preconnect. */
  readonly accountReadCandidate?: boolean;
  readonly client: DbClient;
  readonly observeProcessCpu?: boolean;
  readonly now?: () => Date;
}

function assertAccountAuthentication(
  account: { status: string; lastDisabledAt: Date | null } | null,
  actor: ActorContext,
): void {
  if (account?.status === 'DISABLED') throw unauthenticated();
  if (account?.lastDisabledAt) {
    const authenticatedAt = Date.parse(actor.authenticatedAt ?? '');
    // Cognito auth_time has second precision; reject sessions from the disable second as well.
    if (!(authenticatedAt > account.lastDisabledAt.getTime())) throw unauthenticated();
  }
}

/**
 * 每个通过验签的管理 API 请求均检查业务账号状态，拒绝已停用账号的旧 Token。
 * Cognito 完成首次登录后，把对应 INVITED 业务用户激活。
 * 无对应业务记录的启动账号维持既有认证/授权边界；不缓存账号状态。
 * 条件更新保证并发/重复请求至多迁移一次，状态更新与 SUCCESS 审计同事务提交。
 */
export async function activateInvitedUserOnAuthenticatedRequest(
  deps: AuthenticatedUserSyncDeps,
  actor: ActorContext,
  requestId: string,
): Promise<boolean> {
  const now = deps.now?.() ?? new Date();
  const target = await observeDataPathPhase(
    'admin-account-query',
    () => readAuthenticatedAccount(deps.client, actor.actorId, deps.accountReadCandidate),
    { processCpu: deps.observeProcessCpu === true },
  );
  assertAccountAuthentication(target, actor);
  if (!target || target.status !== 'INVITED') return false;

  return observeDataPathPhase('admin-account-activation', () =>
    withTransaction(deps.client, async (tx) => {
      const updated = await users(tx).updateMany({
        where: { id: target.id, cognitoSub: actor.actorId, status: 'INVITED', lastDisabledAt: target.lastDisabledAt },
        data: { status: 'ACTIVE', updatedAt: now },
      });
      if (updated.count !== 1) {
        // 停用可能在首次查询与条件激活之间提交，不能把失败的激活当作可继续访问。
        const current = (await users(tx).findFirst({ where: { id: target.id } })) as unknown as UserRow | null;
        assertAccountAuthentication(current, actor);
        return false;
      }

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
    }),
  );
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

/** The authenticated subject is the sole selector for the caller's business profile. */
export async function getOwnAccountProfile(
  deps: Pick<UserAdminDeps, 'client'>,
  actor: ActorContext,
): Promise<{ userId: string | null; displayName: string | null }> {
  const account = await deps.client.user.findUnique({
    where: { cognitoSub: actor.actorId },
    select: { id: true, displayName: true, status: true, lastDisabledAt: true },
  });
  assertAccountAuthentication(account, actor);
  return {
    userId: account?.id ?? null,
    displayName: account?.displayName.trim() || null,
  };
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

// ---------- 启停 ----------

async function lockAccountStatus(client: DbClient, userId: string): Promise<UserRow> {
  // Role changes share the first lock. The row lock also serializes first-login activation.
  await lockSuperAdminInvariant(client);
  await client.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
  const target = await client.user.findUnique({ where: { id: userId } });
  if (!target) throw userNotFound();
  return target;
}

async function restoredStatus(client: DbClient, userId: string): Promise<'INVITED' | 'ACTIVE'> {
  const activated = await client.auditLog.findFirst({
    where: {
      objectType: 'user',
      objectId: userId,
      result: 'SUCCESS',
      OR: [
        { action: 'user.activate' },
        { action: 'user.disable', beforeValue: { path: ['status'], equals: 'ACTIVE' } },
      ],
    },
    select: { id: true },
  });
  // Legacy rows without activation evidence use the normal first-authentication transition.
  return activated ? 'ACTIVE' : 'INVITED';
}

function setCognitoEnabled(cognito: CognitoAdminPort, cognitoSub: string, enabled: boolean): Promise<void> {
  return enabled ? cognito.enableUser({ cognitoSub }) : cognito.disableUser({ cognitoSub });
}

async function changeUserEnabled(
  deps: UserAdminDeps,
  actor: ActorContext,
  userId: string,
  enabled: boolean,
): Promise<UserView> {
  const target = await deps.client.user.findUnique({ where: { id: userId } });
  if (!target) throw userNotFound();
  const cognitoSub = target.cognitoSub;
  if (!cognitoSub) {
    if (!enabled && target.status === 'DISABLED') return toUserView(deps.client, target);
    throw userConflict('The user has no Cognito identity');
  }
  const now = deps.now ?? (() => new Date());
  const action = enabled ? 'ENABLE' : 'DISABLE';
  const intentId = await startCognitoReconciliationIntent(deps.client, userId, action, { cognitoSub });
  const audit = {
    objectType: 'user',
    objectId: userId,
    action: enabled ? 'user.enable' : 'user.disable',
    actorId: actor.actorId,
    actorRole: actor.roles[0],
    customerId: null,
  };
  let beforeValue: { status: string } | undefined;
  let cognitoAttempted = false;
  try {
    return await withTransaction(deps.client, async (tx) => {
      const locked = await lockAccountStatus(tx, userId);
      beforeValue = { status: locked.status };
      if (locked.cognitoSub !== cognitoSub) throw userConflict('The user identity changed; refresh and retry');
      const changing = (locked.status !== 'DISABLED') !== enabled;
      if (changing) {
        assertNotSelf(locked, actor, enabled ? 'enable' : 'disable');
        if (!enabled) {
          const superAdminRole = await tx.userRole.findFirst({ where: { userId, roleCode: SUPER_ADMIN_ROLE } });
          await assertNotLastSuperAdmin(tx, locked, superAdminRole !== null);
        }
      }
      const pending = await tx.outboxEvent.findMany({
        where: {
          aggregateId: userId,
          aggregateType: 'user',
          eventType: 'COGNITO_ADMIN_RECONCILIATION',
          status: 'PENDING',
          AND: [
            { payload: { path: ['cognitoSub'], equals: cognitoSub } },
            { OR: ['ENABLE', 'DISABLE'].map((value) => ({ payload: { path: ['action'], equals: value } })) },
          ],
        },
        select: { id: true, lastError: true, createdAt: true },
      });
      // Include ambiguous failures and abandoned requests. Fresh queued requests keep their own intent.
      const abandonedBefore = Date.now() - 60_000; // Longer than the Admin API Lambda can run.
      const unresolved = pending.filter(
        (intent) =>
          intent.id !== intentId &&
          (intent.lastError === 'RECONCILIATION_REQUIRED' || intent.createdAt.getTime() < abandonedBefore),
      );
      if (changing || unresolved.length > 0) {
        if (!pending.some((intent) => intent.id === intentId)) {
          throw userConflict('The account status changed; refresh and retry');
        }
        const status = changing ? (enabled ? await restoredStatus(tx, userId) : 'DISABLED') : locked.status;
        const startedAt = now();
        cognitoAttempted = true;
        await setCognitoEnabled(deps.cognito, cognitoSub, enabled);
        if (changing) {
          const changedAt = now();
          let lastDisabledAt = changedAt;
          if (enabled) {
            // A previous API version may have disabled the account without updating the cutoff.
            lastDisabledAt =
              locked.lastDisabledAt && locked.lastDisabledAt >= locked.updatedAt ? locked.lastDisabledAt : startedAt;
          }
          await tx.user.updateMany({ where: { id: userId }, data: { status, updatedAt: changedAt, lastDisabledAt } });
          await recordAudit(tx, {
            ...audit,
            result: 'SUCCESS',
            reason: `${locked.status} → ${status}`,
            beforeValue,
            afterValue: { status },
          });
        }
        await tx.outboxEvent.updateMany({
          where: { id: { in: unresolved.map((intent) => intent.id) }, status: 'PENDING' },
          data: { status: 'PUBLISHED', publishedAt: now(), lastError: null },
        });
      }
      await resolveCognitoIntent(tx, intentId, now());
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      return toUserView(tx, fresh);
    });
  } catch (err) {
    if (cognitoAttempted) {
      try {
        await withTransaction(deps.client, async (tx) => {
          // A later request may already have committed. Reconcile against the locked DB state.
          const current = await lockAccountStatus(tx, userId);
          const pending = await tx.outboxEvent.findFirst({ where: { id: intentId, status: 'PENDING' } });
          if (!pending) return;
          if (current.cognitoSub !== cognitoSub) throw userConflict('The user identity changed');
          await setCognitoEnabled(deps.cognito, cognitoSub, current.status !== 'DISABLED');
          await resolveCognitoIntent(tx, intentId, now());
        });
      } catch {
        await markCognitoReconciliationRequired(deps, actor, userId, intentId, action);
      }
    } else {
      await resolveCognitoIntent(deps.client, intentId, now()).catch(() => undefined);
    }
    await recordAudit(deps.client, { ...audit, result: 'FAILURE', beforeValue }).catch(() => undefined);
    throw err;
  }
}

export function disableUser(deps: UserAdminDeps, actor: ActorContext, userId: string): Promise<UserView> {
  return changeUserEnabled(deps, actor, userId, false);
}

export function enableUser(deps: UserAdminDeps, actor: ActorContext, userId: string): Promise<UserView> {
  return changeUserEnabled(deps, actor, userId, true);
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
