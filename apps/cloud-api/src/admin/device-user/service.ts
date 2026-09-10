/**
 * BE-DUSR-01 Device User 管理 Service（业务核心，框架无关）。
 *
 * 事实源与规则：
 * - DEC-004@1.0.0：账号与云端 Cognito 用户分离；写接口受控接收明文密码并立即派生
 *   Argon2id PHC，数据库只保存 passwordHash；DTO/日志/审计永不返回密码或 PHC；
 * - 租户：CustomerAdmin 只能管理自身 Customer（创建强制 actor.customerId；其余操作行级校验，
 *   跨 Customer → 404 不泄露存在性）；平台角色全量；
 * - 同步版本：device_users.version 兼作乐观锁（If-Match）与设备同步版本——任何用户/分配变化
 *   version+1 并向受影响设备发 USERS_CHANGED（Outbox，deviceAction=SYNC；每设备一条）；
 * - 停用：ACTIVE→DISABLED（重复停用 409）；停用用户不可新分配、不进入新 Sync（BE-SYNC-01
 *   仅下发 ACTIVE 用户）；分配历史 append-only（ACTIVE/REVOKED + revokedAt）；
 * - 批量分配/撤销：单事务全成或全败；部分唯一索引 device_user_assignments_one_active 兜底。
 */
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import {
  deviceUserConflict,
  deviceUserNotFound,
  deviceUserValidationFailed,
  deviceUserVersionConflict,
} from './errors.js';
import { hashDeviceUserPassword } from './verifier.js';

export const USERS_CHANGED_NOTIFICATION = 'USERS_CHANGED' as const;

const notificationTopic = (deviceId: string): string => `bnx/device/${deviceId}/notification`;

export interface DeviceUserDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
  /** 测试可注入；生产缺省使用 DEC-004 固定参数 Argon2id。 */
  readonly hashPassword?: (password: string) => Promise<string>;
}

/** 管理查询 DTO 永不包含 passwordHash（DEC-004 脱敏）。 */
export interface DeviceUserView {
  readonly deviceUserId: string;
  readonly customerId: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly status: string;
  /** 同步版本（兼 If-Match 乐观锁）。 */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeviceUserListItemView extends DeviceUserView {
  readonly activeDeviceCount: number;
}

export interface DeviceUserAssignmentView {
  readonly assignmentId: string;
  readonly deviceId: string;
  readonly status: string;
  readonly assignedAt: string;
  readonly revokedAt: string | null;
}

export interface DeviceUserDetailView extends DeviceUserView {
  readonly assignments: readonly DeviceUserAssignmentView[];
  readonly syncStates: readonly DeviceUserSyncStateView[];
}

export interface DeviceUserSyncStateView {
  readonly deviceId: string;
  readonly entityVersion: number | null;
  readonly notificationStatus: 'PENDING' | 'PUBLISHED' | 'FAILED' | 'NOT_REQUESTED';
  readonly notificationPublishedAt: string | null;
  readonly deliveredEntityVersion: number | null;
  readonly snapshotStatus: 'NOT_SERVED' | 'SERVED' | 'ACKNOWLEDGED';
  readonly snapshotServedAt: string | null;
  readonly deviceReportedLastSyncAt: string | null;
  /** 当前协议没有设备应用确认回执；禁止把消息发布或快照确认误报为已应用。 */
  readonly deviceApplyStatus: 'NOT_REPORTED';
}

interface UserRow {
  readonly id: string;
  readonly customerId: string;
  readonly username: string;
  readonly displayName: string | null;
  readonly status: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface AssignmentRow {
  readonly id: string;
  readonly deviceUserId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly status: string;
  readonly assignedAt: Date;
  readonly revokedAt: Date | null;
}

interface DeviceUserDelegate {
  findFirst(args: Record<string, unknown>): Promise<UserRow | null>;
  findMany(args: Record<string, unknown>): Promise<(UserRow & { assignments: { deviceId: string }[] })[]>;
  create(args: { data: Record<string, unknown> }): Promise<UserRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface AssignmentDelegate {
  findMany(args: Record<string, unknown>): Promise<AssignmentRow[]>;
  create(args: { data: Record<string, unknown> }): Promise<AssignmentRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface OutboxDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findMany(args: Record<string, unknown>): Promise<
    readonly {
      status: string;
      payload: unknown;
      publishedAt: Date | null;
      createdAt: Date;
    }[]
  >;
}

interface SyncReceiptDelegate {
  findMany(args: Record<string, unknown>): Promise<
    readonly {
      deviceId: string;
      entityVersion: number;
      servedAt: Date;
      deviceReportedLastSyncAt: Date | null;
      acknowledgedAt: Date | null;
    }[]
  >;
}

function users(client: DbClient): DeviceUserDelegate {
  return (client as unknown as Record<string, unknown>).deviceUser as DeviceUserDelegate;
}

function assignments(client: DbClient): AssignmentDelegate {
  return (client as unknown as Record<string, unknown>).deviceUserAssignment as AssignmentDelegate;
}

function toView(row: UserRow): DeviceUserView {
  return {
    deviceUserId: row.id,
    customerId: row.customerId,
    username: row.username,
    displayName: row.displayName,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAssignmentView(row: AssignmentRow): DeviceUserAssignmentView {
  return {
    assignmentId: row.id,
    deviceId: row.deviceId,
    status: row.status,
    assignedAt: row.assignedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** 加载用户并做租户校验（Customer 角色跨 Customer → 404）。 */
async function loadUser(client: DbClient, actor: ActorContext, deviceUserId: string): Promise<UserRow> {
  const row = await users(client).findFirst({ where: { id: deviceUserId } });
  if (!row) throw deviceUserNotFound();
  if (actor.actorType === 'customer' && row.customerId !== actor.customerId) throw deviceUserNotFound();
  return row;
}

function auditActor(actor: ActorContext): { actorId: string; actorRole: string } {
  return { actorId: actor.actorId, actorRole: actor.roles[0] };
}

/** 事务内向设备发 USERS_CHANGED（Outbox，deviceAction=SYNC）。 */
async function enqueueUsersChanged(
  tx: DbClient,
  deviceId: string,
  deviceUserId: string,
  entityVersion: number,
): Promise<void> {
  const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
  await outbox.create({
    data: {
      eventType: USERS_CHANGED_NOTIFICATION,
      aggregateType: 'deviceUser',
      aggregateId: deviceUserId,
      payload: {
        topic: notificationTopic(deviceId),
        data: { type: USERS_CHANGED_NOTIFICATION, action: 'SYNC' },
        deviceId,
        deviceUserId,
        entityVersion,
      },
    },
  });
}

/** 用户当前 ACTIVE 分配的设备 ID 集合。 */
async function activeDeviceIds(tx: DbClient, deviceUserId: string): Promise<string[]> {
  const rows = await assignments(tx).findMany({ where: { deviceUserId, status: 'ACTIVE' } });
  return rows.map((r) => r.deviceId);
}

/** 版本条件更新（If-Match 乐观锁 + 同步版本递增）；漂移 → 409。 */
async function bumpVersion(
  tx: DbClient,
  row: UserRow,
  ifMatchVersion: number,
  data: Record<string, unknown>,
): Promise<void> {
  const { count } = await users(tx).updateMany({
    where: { id: row.id, version: ifMatchVersion },
    data: { ...data, version: { increment: 1 } },
  });
  if (count !== 1) throw deviceUserVersionConflict();
}

// ---------- 创建 ----------

export interface CreateDeviceUserInput {
  /** 平台角色必传；Customer 角色强制本 Customer（忽略入参）。 */
  readonly customerId?: string | undefined;
  readonly username: string;
  readonly displayName?: string | undefined;
  /** 仅用于本次派生；不得持久化、返回或写入审计。 */
  readonly password: string;
  readonly reason?: string | undefined;
}

/** 创建设备操作员（device-user:write）：(customerId, username) 唯一（P2002 → 409）。 */
export async function createDeviceUser(
  deps: DeviceUserDeps,
  actor: ActorContext,
  input: CreateDeviceUserInput,
): Promise<DeviceUserView> {
  const customerId = actor.actorType === 'customer' ? (actor.customerId ?? undefined) : input.customerId;
  if (!customerId) throw deviceUserValidationFailed('customerId is required');
  if (input.username.trim().length === 0 || input.username.trim().length > 64) {
    throw deviceUserValidationFailed('username must be 1~64 characters');
  }
  const passwordHash = await (deps.hashPassword ?? hashDeviceUserPassword)(input.password);
  const customer = await (
    (deps.client as unknown as Record<string, unknown>).customer as {
      findFirst(args: Record<string, unknown>): Promise<{ id: string } | null>;
    }
  ).findFirst({ where: { id: customerId } });
  if (!customer) throw deviceUserNotFound();

  try {
    return await audited<DeviceUserView>(
      deps.client,
      {
        objectType: 'deviceUser',
        objectId: customerId,
        action: 'device.user.create',
        reason: input.reason ?? null,
        ...auditActor(actor),
        customerId,
        afterValue: { username: input.username.trim(), status: 'ACTIVE' },
      },
      async (tx) => {
        const row = await users(tx).create({
          data: {
            customerId,
            username: input.username.trim(),
            displayName: input.displayName ?? null,
            passwordHash,
            status: 'ACTIVE',
          },
        });
        return toView(row);
      },
    );
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') {
      throw deviceUserConflict('The username already exists for this customer');
    }
    throw err;
  }
}

// ---------- 修改 / 停用 ----------

export interface DeviceUserWriteInput {
  readonly deviceUserId: string;
  readonly ifMatchVersion: number;
  readonly reason: string;
}

/** 修改（device-user:write + If-Match）：displayName；可通过 password 轮换 PHC。 */
export async function updateDeviceUser(
  deps: DeviceUserDeps,
  actor: ActorContext,
  input: DeviceUserWriteInput & {
    readonly displayName?: string | null | undefined;
    readonly password?: string | undefined;
  },
): Promise<DeviceUserView> {
  const passwordHash =
    input.password === undefined ? undefined : await (deps.hashPassword ?? hashDeviceUserPassword)(input.password);
  const row = await loadUser(deps.client, actor, input.deviceUserId);
  if (row.status === 'DISABLED') throw deviceUserConflict('A disabled user cannot be updated');

  return audited<DeviceUserView>(
    deps.client,
    {
      objectType: 'deviceUser',
      objectId: row.id,
      action: 'device.user.update',
      reason: input.reason,
      ...auditActor(actor),
      customerId: row.customerId,
      beforeValue: { version: input.ifMatchVersion },
      afterValue: { status: 'ACTIVE', passwordRotated: passwordHash !== undefined },
    },
    async (tx) => {
      const data: Record<string, unknown> = {};
      if (input.displayName !== undefined) data.displayName = input.displayName;
      if (passwordHash !== undefined) data.passwordHash = passwordHash;
      await bumpVersion(tx, row, input.ifMatchVersion, data);
      // 验证材料轮换/资料变更 → 通知全部已分配设备
      for (const deviceId of await activeDeviceIds(tx, row.id)) {
        await enqueueUsersChanged(tx, deviceId, row.id, row.version + 1);
      }
      const fresh = await users(tx).findFirst({ where: { id: row.id } });
      if (!fresh) throw deviceUserNotFound();
      return toView(fresh);
    },
  );
}

/** 停用（device-user:write + If-Match + 强制原因）：ACTIVE→DISABLED；停用用户不进入新 Sync。 */
export async function disableDeviceUser(
  deps: DeviceUserDeps,
  actor: ActorContext,
  input: DeviceUserWriteInput,
): Promise<DeviceUserView> {
  const row = await loadUser(deps.client, actor, input.deviceUserId);
  if (row.status === 'DISABLED') throw deviceUserConflict('The user is already disabled');

  return audited<DeviceUserView>(
    deps.client,
    {
      objectType: 'deviceUser',
      objectId: row.id,
      action: 'device.user.disable',
      reason: input.reason,
      ...auditActor(actor),
      customerId: row.customerId,
      beforeValue: { status: 'ACTIVE', version: input.ifMatchVersion },
      afterValue: { status: 'DISABLED' },
    },
    async (tx) => {
      await bumpVersion(tx, row, input.ifMatchVersion, { status: 'DISABLED' });
      for (const deviceId of await activeDeviceIds(tx, row.id)) {
        await enqueueUsersChanged(tx, deviceId, row.id, row.version + 1);
      }
      const fresh = await users(tx).findFirst({ where: { id: row.id } });
      if (!fresh) throw deviceUserNotFound();
      return toView(fresh);
    },
  );
}

// ---------- 设备分配 ----------

export interface AssignDevicesInput extends DeviceUserWriteInput {
  readonly deviceIds: readonly string[];
}

export interface AssignDevicesResult {
  readonly deviceUserId: string;
  readonly deviceIds: readonly string[];
  readonly assignments: readonly DeviceUserAssignmentView[];
}

/** 批量分配设备（device-user:write + If-Match）：跨 Customer/Retired/停用用户 → 409；全成或全败。 */
export async function assignDevices(
  deps: DeviceUserDeps,
  actor: ActorContext,
  input: AssignDevicesInput,
): Promise<AssignDevicesResult> {
  const deviceIds = [...new Set(input.deviceIds)];
  if (deviceIds.length === 0) throw deviceUserValidationFailed('deviceIds must be a non-empty array');
  const row = await loadUser(deps.client, actor, input.deviceUserId);
  if (row.status === 'DISABLED') throw deviceUserConflict('A disabled user cannot be assigned to devices');
  const deviceRows = await (
    (deps.client as unknown as Record<string, unknown>).device as {
      findMany(
        args: Record<string, unknown>,
      ): Promise<{ id: string; customerId: string | null; lifecycleStatus: string }[]>;
    }
  ).findMany({ where: { id: { in: deviceIds } }, select: { id: true, customerId: true, lifecycleStatus: true } });
  if (deviceRows.length !== deviceIds.length) throw deviceUserNotFound();
  for (const d of deviceRows) {
    if (d.customerId !== row.customerId) {
      throw deviceUserConflict(`The device ${d.id} does not belong to the user customer`);
    }
    if (d.lifecycleStatus === 'Retired') throw deviceUserConflict(`The device ${d.id} is retired`);
  }

  try {
    return await audited<AssignDevicesResult>(
      deps.client,
      {
        objectType: 'deviceUser',
        objectId: row.id,
        action: 'device.user.assign',
        reason: input.reason,
        ...auditActor(actor),
        customerId: row.customerId,
        afterValue: { deviceIds },
      },
      async (tx) => {
        await bumpVersion(tx, row, input.ifMatchVersion, {});
        const created: DeviceUserAssignmentView[] = [];
        for (const deviceId of deviceIds) {
          const a = await assignments(tx).create({
            data: { deviceUserId: row.id, deviceId, customerId: row.customerId, status: 'ACTIVE' },
          });
          created.push(toAssignmentView(a));
          await enqueueUsersChanged(tx, deviceId, row.id, row.version + 1);
        }
        return { deviceUserId: row.id, deviceIds, assignments: created };
      },
    );
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') {
      throw deviceUserConflict('The device already has an active assignment for this user');
    }
    throw err;
  }
}

/** 批量撤销分配（device-user:write + If-Match）：任一无 ACTIVE 分配 → 409 全部回滚。 */
export async function revokeDevices(
  deps: DeviceUserDeps,
  actor: ActorContext,
  input: AssignDevicesInput,
): Promise<{ deviceUserId: string; deviceIds: readonly string[] }> {
  const at = deps.now?.() ?? new Date();
  const deviceIds = [...new Set(input.deviceIds)];
  if (deviceIds.length === 0) throw deviceUserValidationFailed('deviceIds must be a non-empty array');
  const row = await loadUser(deps.client, actor, input.deviceUserId);
  const active = await assignments(deps.client).findMany({
    where: { deviceUserId: row.id, deviceId: { in: deviceIds }, status: 'ACTIVE' },
  });
  const activeIds = new Set(active.map((a) => a.deviceId));
  const missing = deviceIds.filter((id) => !activeIds.has(id));
  if (missing.length > 0) {
    throw deviceUserConflict(`The device(s) ${missing.join(', ')} have no active assignment for this user`);
  }

  return audited<{ deviceUserId: string; deviceIds: readonly string[] }>(
    deps.client,
    {
      objectType: 'deviceUser',
      objectId: row.id,
      action: 'device.user.revoke',
      reason: input.reason,
      ...auditActor(actor),
      customerId: row.customerId,
      beforeValue: { deviceIds },
      afterValue: { revoked: deviceIds },
    },
    async (tx) => {
      await bumpVersion(tx, row, input.ifMatchVersion, {});
      for (const deviceId of deviceIds) {
        const { count } = await assignments(tx).updateMany({
          where: { deviceUserId: row.id, deviceId, status: 'ACTIVE' },
          data: { status: 'REVOKED', revokedAt: at },
        });
        if (count !== 1) throw deviceUserConflict('The assignment was changed concurrently; refresh and retry');
        await enqueueUsersChanged(tx, deviceId, row.id, row.version + 1);
      }
      return { deviceUserId: row.id, deviceIds };
    },
  );
}

// ---------- 查询 ----------

export interface ListDeviceUsersFilter {
  readonly customerId?: string | undefined;
  readonly status?: string | undefined;
  readonly keyword?: string | undefined;
}

/** 列表（device-user:read）：Customer 租户隔离；返回 ACTIVE 分配设备数。 */
export async function listDeviceUsers(
  deps: DeviceUserDeps,
  actor: ActorContext,
  filter: ListDeviceUsersFilter = {},
): Promise<DeviceUserListItemView[]> {
  if (filter.status !== undefined && !['ACTIVE', 'DISABLED'].includes(filter.status)) {
    throw deviceUserValidationFailed('status must be ACTIVE or DISABLED');
  }
  const scopedCustomer = actor.actorType === 'customer' ? (actor.customerId ?? '__none__') : filter.customerId;
  const rows = await users(deps.client).findMany({
    where: {
      ...(scopedCustomer !== undefined ? { customerId: scopedCustomer } : {}),
      ...(filter.status !== undefined ? { status: filter.status } : {}),
      ...(filter.keyword !== undefined && filter.keyword.trim() !== ''
        ? {
            OR: [
              { username: { contains: filter.keyword.trim() } },
              { displayName: { contains: filter.keyword.trim() } },
            ],
          }
        : {}),
    },
    include: { assignments: { where: { status: 'ACTIVE' }, select: { deviceId: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
  });
  return rows.map((r) => ({ ...toView(r), activeDeviceCount: r.assignments.length }));
}

/** 详情（device-user:read）：含分配历史（ACTIVE/REVOKED）；跨 Customer → 404。 */
export async function getDeviceUser(
  deps: DeviceUserDeps,
  actor: ActorContext,
  deviceUserId: string,
): Promise<DeviceUserDetailView> {
  const row = await loadUser(deps.client, actor, deviceUserId);
  const rows = await assignments(deps.client).findMany({
    where: { deviceUserId: row.id },
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
  });
  const outbox = (deps.client as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
  const events = await outbox.findMany({
    where: { aggregateType: 'deviceUser', aggregateId: row.id, eventType: USERS_CHANGED_NOTIFICATION },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 500,
  });
  const receipts = await (
    (deps.client as unknown as Record<string, unknown>).deviceUserSyncReceipt as SyncReceiptDelegate
  ).findMany({
    where: { deviceUserId: row.id },
    orderBy: [{ servedAt: 'desc' }, { id: 'desc' }],
    take: 500,
  });
  const latestReceiptByDevice = new Map<string, (typeof receipts)[number]>();
  for (const receipt of receipts) {
    if (!latestReceiptByDevice.has(receipt.deviceId)) latestReceiptByDevice.set(receipt.deviceId, receipt);
  }
  const latestByDevice = new Map<string, DeviceUserSyncStateView>();
  for (const event of events) {
    const payload = event.payload as { deviceId?: unknown; entityVersion?: unknown } | null;
    const deviceId = typeof payload?.deviceId === 'string' ? payload.deviceId : null;
    if (deviceId === null || latestByDevice.has(deviceId)) continue;
    const status = ['PENDING', 'PUBLISHED', 'FAILED'].includes(event.status)
      ? (event.status as 'PENDING' | 'PUBLISHED' | 'FAILED')
      : 'PENDING';
    const receipt = latestReceiptByDevice.get(deviceId);
    latestByDevice.set(deviceId, {
      deviceId,
      entityVersion: typeof payload?.entityVersion === 'number' ? payload.entityVersion : null,
      notificationStatus: status,
      notificationPublishedAt: event.publishedAt?.toISOString() ?? null,
      deliveredEntityVersion: receipt?.entityVersion ?? null,
      snapshotStatus: receipt ? (receipt.acknowledgedAt ? 'ACKNOWLEDGED' : 'SERVED') : 'NOT_SERVED',
      snapshotServedAt: receipt?.servedAt.toISOString() ?? null,
      deviceReportedLastSyncAt: receipt?.deviceReportedLastSyncAt?.toISOString() ?? null,
      deviceApplyStatus: 'NOT_REPORTED',
    });
  }
  for (const assignment of rows) {
    if (!latestByDevice.has(assignment.deviceId)) {
      const receipt = latestReceiptByDevice.get(assignment.deviceId);
      latestByDevice.set(assignment.deviceId, {
        deviceId: assignment.deviceId,
        entityVersion: null,
        notificationStatus: 'NOT_REQUESTED',
        notificationPublishedAt: null,
        deliveredEntityVersion: receipt?.entityVersion ?? null,
        snapshotStatus: receipt ? (receipt.acknowledgedAt ? 'ACKNOWLEDGED' : 'SERVED') : 'NOT_SERVED',
        snapshotServedAt: receipt?.servedAt.toISOString() ?? null,
        deviceReportedLastSyncAt: receipt?.deviceReportedLastSyncAt?.toISOString() ?? null,
        deviceApplyStatus: 'NOT_REPORTED',
      });
    }
  }
  return { ...toView(row), assignments: rows.map(toAssignmentView), syncStates: [...latestByDevice.values()] };
}

// ---------- Sync 读取路径（BE-SYNC-01 消费） ----------

export interface DeviceUserSyncAssignment {
  readonly deviceId: string;
  readonly assignedAt: string;
}

export interface DeviceUserSyncEntry {
  readonly userId: string;
  readonly version: number;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly status: 'ACTIVE';
  /** ACTIVE 分配的设备（含授权时间，供 Sync 按设备过滤）。 */
  readonly assignments: readonly DeviceUserSyncAssignment[];
}

interface SyncUserRow extends UserRow {
  readonly passwordHash: string;
  readonly assignments: readonly { deviceId: string; assignedAt: Date }[];
}

/** Device Users 域同步读取：仅 ACTIVE 用户 + ACTIVE 分配（停用用户不进入新 Sync）。 */
export async function listDeviceUsersForSync(deps: DeviceUserDeps, customerId: string): Promise<DeviceUserSyncEntry[]> {
  const rows = (await users(deps.client).findMany({
    where: { customerId, status: 'ACTIVE', passwordHash: { not: null } },
    select: {
      id: true,
      customerId: true,
      username: true,
      displayName: true,
      status: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      passwordHash: true,
      assignments: { where: { status: 'ACTIVE' }, select: { deviceId: true, assignedAt: true } },
    },
    orderBy: { id: 'asc' },
  })) as unknown as SyncUserRow[];
  return rows.map((r) => ({
    userId: r.id,
    version: r.version,
    username: r.username,
    displayName: r.displayName ?? r.username,
    passwordHash: r.passwordHash,
    status: 'ACTIVE',
    assignments: r.assignments.map((a) => ({ deviceId: a.deviceId, assignedAt: a.assignedAt.toISOString() })),
  }));
}
