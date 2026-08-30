/**
 * BE-CNS-02 耗材更换申请工作流 Service（框架无关）。
 *
 * 事实源与规则：
 * - 状态机走领域层（packages/domain/src/consumable.ts）：PENDING→PROCESSING→COMPLETED，
 *   PENDING/PROCESSING→CANCELLED；跳级/重复处理/终态迁移 → 409 CONFLICT；
 * - 幂等：同设备同耗材存在开放申请（PENDING/PROCESSING）时重复创建 → 返回现有记录
 *   replayed=true（无写入/审计）；部分唯一索引 consumable_requests_one_open_per_device_type 并发兜底；
 * - 状态迁移：If-Match 乐观锁（version 条件更新，漂移 → 409 VERSION_CONFLICT）+ 条件状态
 *   （并发下状态漂移 → 409 CONFLICT）+ DOM-03 audited 审计（consumable.request.create/process/complete/cancel）；
 * - 权限：创建/处理仅授权角色（device:write = PlatformSuperAdmin/PlatformOperator）；
 *   查询 device:read + Customer 角色租户隔离（仅本 Customer，跨 Customer 详情 → 404）；
 * - 边界：source 固定 ADMIN（协议冻结前仅管理端创建）；不实现工单派遣/库存/物流/短信；
 *   完成后保留完整记录（终态行 + 审计历史）。
 */
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';
import {
  CONSUMABLE_REQUEST_STATUSES,
  OPEN_REQUEST_STATUSES,
  assertConsumableRequestTransition,
  assertKnownConsumableType,
} from '@fdp/domain';
import type { ConsumableRequestStatus } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import {
  consumableConflict,
  consumableNotFound,
  consumableValidationFailed,
  consumableVersionConflict,
} from './errors.js';

export interface ConsumableRequestDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export interface ConsumableRequestView {
  readonly requestId: string;
  readonly customerId: string;
  readonly deviceId: string;
  readonly consumableType: string;
  readonly status: string;
  readonly source: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly processedBy: string | null;
  readonly processNote: string | null;
  readonly completedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RequestRow {
  readonly id: string;
  readonly customerId: string;
  readonly deviceId: string;
  readonly consumableType: string;
  readonly status: string;
  readonly source: string;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly processedBy: string | null;
  readonly processNote: string | null;
  readonly completedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RequestDelegate {
  findFirst(args: Record<string, unknown>): Promise<RequestRow | null>;
  findMany(args: Record<string, unknown>): Promise<RequestRow[]>;
  create(args: { data: Record<string, unknown> }): Promise<RequestRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function requests(client: DbClient): RequestDelegate {
  return (client as unknown as Record<string, unknown>).consumableRequest as RequestDelegate;
}

function toView(row: RequestRow): ConsumableRequestView {
  return {
    requestId: row.id,
    customerId: row.customerId,
    deviceId: row.deviceId,
    consumableType: row.consumableType,
    status: row.status,
    source: row.source,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    processedBy: row.processedBy,
    processNote: row.processNote,
    completedAt: row.completedAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Customer 角色租户隔离的 Customer 范围。 */
function scopedCustomerId(actor: ActorContext, requested?: string): string | undefined {
  return actor.actorType === 'customer' ? (actor.customerId ?? '__none__') : requested;
}

function auditActor(actor: ActorContext): { actorId: string; actorRole: string } {
  return { actorId: actor.actorId, actorRole: actor.roles[0] };
}

// ---------- 创建（幂等） ----------

export interface CreateConsumableRequestInput {
  readonly deviceId: string;
  readonly consumableType: string;
  /** 申请备注（可选）。 */
  readonly note?: string | undefined;
}

export interface CreateConsumableRequestResult {
  readonly view: ConsumableRequestView;
  /** 同设备同耗材存在开放申请 → 幂等返回现有记录（无写入/审计）。 */
  readonly replayed: boolean;
}

/** 创建更换申请（device:write）：幂等（开放申请重复 → replayed）；设备须已分配 Customer。 */
export async function createConsumableRequest(
  deps: ConsumableRequestDeps,
  actor: ActorContext,
  input: CreateConsumableRequestInput,
): Promise<CreateConsumableRequestResult> {
  const consumableType = assertKnownConsumableType(input.consumableType);
  const device = await (
    (deps.client as unknown as Record<string, unknown>).device as {
      findFirst(
        args: Record<string, unknown>,
      ): Promise<{ id: string; customerId: string | null; lifecycleStatus: string } | null>;
    }
  ).findFirst({ where: { id: input.deviceId }, select: { id: true, customerId: true, lifecycleStatus: true } });
  if (!device) throw consumableNotFound();
  if (device.customerId === null) {
    throw consumableConflict('The device is not assigned to a customer');
  }
  if (device.lifecycleStatus === 'Retired') {
    throw consumableConflict('The device is retired');
  }

  const openWhere = {
    deviceId: input.deviceId,
    consumableType,
    status: { in: [...OPEN_REQUEST_STATUSES] },
  };
  const existing = await requests(deps.client).findFirst({ where: openWhere });
  if (existing) return { view: toView(existing), replayed: true };

  try {
    const view = await audited<ConsumableRequestView>(
      deps.client,
      {
        objectType: 'consumableRequest',
        objectId: input.deviceId,
        action: 'consumable.request.create',
        reason: input.note ?? null,
        ...auditActor(actor),
        customerId: device.customerId,
        afterValue: { deviceId: input.deviceId, consumableType, status: 'PENDING' },
      },
      async (tx) => {
        const row = await requests(tx).create({
          data: {
            customerId: device.customerId,
            deviceId: input.deviceId,
            consumableType,
            status: 'PENDING',
            source: 'ADMIN',
            requestedBy: actor.actorId,
            processNote: input.note ?? null,
          },
        });
        return toView(row);
      },
    );
    return { view, replayed: false };
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') {
      // 并发撞部分唯一索引 → 重读返回现有记录（幂等）
      const winner = await requests(deps.client).findFirst({ where: openWhere });
      if (winner) return { view: toView(winner), replayed: true };
    }
    throw err;
  }
}

// ---------- 状态迁移（If-Match + 授权角色 + 审计） ----------

export interface TransitionRequestInput {
  readonly requestId: string;
  readonly ifMatchVersion: number;
  /** 处理备注（complete/cancel 强制；process 可选）。 */
  readonly note?: string | undefined;
}

async function transition(
  deps: ConsumableRequestDeps,
  actor: ActorContext,
  input: TransitionRequestInput,
  to: ConsumableRequestStatus,
  action: string,
): Promise<ConsumableRequestView> {
  const at = deps.now?.() ?? new Date();
  return audited<ConsumableRequestView>(
    deps.client,
    {
      objectType: 'consumableRequest',
      objectId: input.requestId,
      action,
      reason: input.note ?? null,
      ...auditActor(actor),
      beforeValue: { version: input.ifMatchVersion },
      afterValue: (result: unknown) => {
        const v = result as ConsumableRequestView;
        return { status: v.status, processedBy: v.processedBy, completedAt: v.completedAt, version: v.version };
      },
    },
    async (tx) => {
      const current = await requests(tx).findFirst({ where: { id: input.requestId } });
      if (!current) throw consumableNotFound();
      assertConsumableRequestTransition(current.status as ConsumableRequestStatus, to);
      const data: Record<string, unknown> = { status: to, processedBy: actor.actorId };
      if (input.note !== undefined) data.processNote = input.note;
      if (to === 'COMPLETED') data.completedAt = at;
      const { count } = await requests(tx).updateMany({
        where: { id: input.requestId, version: input.ifMatchVersion, status: current.status },
        data: { ...data, version: { increment: 1 } },
      });
      if (count !== 1) {
        const fresh = await requests(tx).findFirst({ where: { id: input.requestId } });
        if (fresh && fresh.version !== input.ifMatchVersion) throw consumableVersionConflict();
        throw consumableConflict('The request state changed concurrently; refresh and retry');
      }
      const row = await requests(tx).findFirst({ where: { id: input.requestId } });
      if (!row) throw consumableNotFound();
      return toView(row);
    },
  );
}

/** PENDING→PROCESSING（授权角色）。 */
export async function processConsumableRequest(
  deps: ConsumableRequestDeps,
  actor: ActorContext,
  input: TransitionRequestInput,
): Promise<ConsumableRequestView> {
  return transition(deps, actor, input, 'PROCESSING', 'consumable.request.process');
}

/** PROCESSING→COMPLETED（授权角色；强制处理备注；记录 completedAt）。 */
export async function completeConsumableRequest(
  deps: ConsumableRequestDeps,
  actor: ActorContext,
  input: TransitionRequestInput,
): Promise<ConsumableRequestView> {
  if (!input.note || input.note.trim().length === 0) {
    throw consumableValidationFailed('processNote is required when completing a request');
  }
  return transition(deps, actor, input, 'COMPLETED', 'consumable.request.complete');
}

/** PENDING/PROCESSING→CANCELLED（授权角色；强制原因）。 */
export async function cancelConsumableRequest(
  deps: ConsumableRequestDeps,
  actor: ActorContext,
  input: TransitionRequestInput,
): Promise<ConsumableRequestView> {
  if (!input.note || input.note.trim().length === 0) {
    throw consumableValidationFailed('reason is required when cancelling a request');
  }
  return transition(deps, actor, input, 'CANCELLED', 'consumable.request.cancel');
}

// ---------- 查询 ----------

export interface ListConsumableRequestsFilter {
  readonly customerId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly status?: string | undefined;
  readonly consumableType?: string | undefined;
}

/** 列表（device:read）：Customer 角色租户隔离；状态/类型筛选走封闭集合校验。 */
export async function listConsumableRequests(
  deps: ConsumableRequestDeps,
  actor: ActorContext,
  filter: ListConsumableRequestsFilter = {},
): Promise<ConsumableRequestView[]> {
  if (filter.status !== undefined && !(CONSUMABLE_REQUEST_STATUSES as readonly string[]).includes(filter.status)) {
    throw consumableValidationFailed('status must be one of PENDING, PROCESSING, COMPLETED, CANCELLED');
  }
  if (filter.consumableType !== undefined) assertKnownConsumableType(filter.consumableType);
  const rows = await requests(deps.client).findMany({
    where: {
      ...(scopedCustomerId(actor, filter.customerId) !== undefined
        ? { customerId: scopedCustomerId(actor, filter.customerId) }
        : {}),
      ...(filter.deviceId !== undefined ? { deviceId: filter.deviceId } : {}),
      ...(filter.status !== undefined ? { status: filter.status } : {}),
      ...(filter.consumableType !== undefined ? { consumableType: filter.consumableType } : {}),
    },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    take: 200,
  });
  return rows.map(toView);
}

/** 详情（device:read）：跨 Customer → 404（不泄露存在性）。 */
export async function getConsumableRequest(
  deps: ConsumableRequestDeps,
  actor: ActorContext,
  requestId: string,
): Promise<ConsumableRequestView> {
  const row = await requests(deps.client).findFirst({ where: { id: requestId } });
  if (!row) throw consumableNotFound();
  if (actor.actorType === 'customer' && row.customerId !== actor.customerId) throw consumableNotFound();
  return toView(row);
}
