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
 * - ADMIN 原有开放申请重放；DEVICE 请求绑定证书设备、当前分配和持久化请求标识；
 *   完成后保留完整记录（终态行 + 审计历史）。
 */
import { createHash } from 'node:crypto';
import type { DbClient } from '@fdp/database';
import { audited, recordAudit } from '@fdp/database';
import {
  CONSUMABLE_REQUEST_STATUSES,
  OPEN_REQUEST_STATUSES,
  assertConsumableRequestTransition,
  assertKnownConsumableType,
} from '@fdp/domain';
import type { ConsumableRequestStatus } from '@fdp/domain';
import { forbidden } from '@fdp/auth';
import type { ActorContext, DeviceAuthContext } from '@fdp/auth';
import {
  consumableConflict,
  consumableIdempotencyConflict,
  consumableNotFound,
  consumableValidationFailed,
  consumableVersionConflict,
} from './errors.js';

export interface ConsumableRequestDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

type NoteStage = 'request' | 'processing' | 'completion' | 'cancellation';
export type ConsumableRequestStageNote =
  | { readonly note: string; readonly source: 'RECORDED' }
  | { readonly note: string; readonly source: 'AUDIT'; readonly auditId: string };
export type ConsumableRequestStageNotes = Readonly<
  Partial<Record<NoteStage, ConsumableRequestStageNote>> & { legacy?: readonly string[] }
>;

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
  readonly stageNotes: ConsumableRequestStageNotes;
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
  readonly stageNotes: ConsumableRequestStageNotes | null;
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

function stageNotesFor(row: RequestRow): ConsumableRequestStageNotes {
  const notes = row.stageNotes ?? {};
  const { legacy = [], ...stages } = notes;
  const latestNote = row.processNote;
  if (
    latestNote === null ||
    legacy.includes(latestNote) ||
    Object.values(stages).some((entry) => entry.note === latestNote)
  )
    return notes;
  // An older server may have written only the legacy field after the migration.
  return { ...notes, legacy: [...legacy, latestNote] };
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
    stageNotes: stageNotesFor(row),
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

type RequestOrigin =
  | { readonly source: 'ADMIN'; readonly actorId: string; readonly actorRole: string }
  | {
      readonly source: 'DEVICE';
      readonly actorId: string;
      readonly actorRole: 'DEVICE';
      readonly auth: DeviceAuthContext;
      readonly requestKey: string;
      readonly occurredAt: Date;
      readonly payloadHash: string;
    };

export type DeviceConsumableSubmissionOutcome = 'CREATED' | 'LINKED_OPEN' | 'REPLAYED';
export interface DeviceConsumableSubmissionInput extends Omit<CreateConsumableRequestInput, 'deviceId'> {
  readonly schemaVersion: 1;
  readonly requestKey: string;
  readonly occurredAt: Date;
}

interface OpenRequestResult {
  readonly view: ConsumableRequestView;
  readonly outcome: DeviceConsumableSubmissionOutcome;
}

/** The admin entry point binds origin to the authenticated actor. */
export async function createConsumableRequest(
  deps: ConsumableRequestDeps,
  actor: ActorContext,
  input: CreateConsumableRequestInput,
): Promise<CreateConsumableRequestResult> {
  const { view, outcome } = await createOpenRequest(deps, input, { source: 'ADMIN', ...auditActor(actor) });
  return { view, replayed: outcome !== 'CREATED' };
}

export async function createDeviceConsumableRequest(
  deps: ConsumableRequestDeps,
  auth: DeviceAuthContext,
  input: DeviceConsumableSubmissionInput,
): Promise<OpenRequestResult> {
  // Client software can be upgraded while an offline request is queued. The build is an admission check,
  // while the normalized business fields form the retry identity.
  const payloadHash = createHash('sha256')
    .update(
      JSON.stringify([input.schemaVersion, input.consumableType, input.occurredAt.toISOString(), input.note ?? null]),
    )
    .digest('hex');
  return createOpenRequest(
    deps,
    { ...input, deviceId: auth.deviceId },
    {
      source: 'DEVICE',
      actorId: auth.deviceId,
      actorRole: 'DEVICE',
      auth,
      requestKey: input.requestKey,
      occurredAt: input.occurredAt,
      payloadHash,
    },
  );
}

async function currentSubmissionAssignment(
  tx: DbClient,
  origin: Extract<RequestOrigin, { source: 'DEVICE' }>,
  device: { readonly id: string; readonly customerId: string; readonly siteId: string | null },
  at: Date,
): Promise<string> {
  const { customerId, siteId } = device;
  if (customerId !== origin.auth.customerId || siteId === null || siteId !== origin.auth.siteId) {
    throw consumableConflict('The current device assignment does not support this request');
  }
  if (origin.occurredAt > at) throw consumableValidationFailed('occurredAt must not be in the future');
  const [assignment, customer, site] = await Promise.all([
    tx.deviceAssignment.findFirst({
      where: { deviceId: device.id, customerId, siteId, status: 'ACTIVE', endedAt: null },
      select: { id: true, assignedAt: true },
    }),
    tx.customer.findFirst({ where: { id: customerId, status: 'ACTIVE', deletedAt: null }, select: { id: true } }),
    tx.site.findFirst({ where: { id: siteId, customerId, deletedAt: null }, select: { id: true } }),
  ]);
  if (!customer || !site || !assignment || origin.occurredAt < assignment.assignedAt) {
    throw consumableConflict('The request does not belong to the current active assignment');
  }
  return assignment.id;
}

async function createOpenRequest(
  deps: ConsumableRequestDeps,
  input: CreateConsumableRequestInput,
  origin: RequestOrigin,
): Promise<OpenRequestResult> {
  const consumableType = assertKnownConsumableType(input.consumableType);
  const at = deps.now?.() ?? new Date();
  const execute = () =>
    audited<OpenRequestResult>(
      deps.client,
      {
        objectType: 'consumableRequest',
        objectId: input.deviceId,
        action: 'consumable.request.create',
        reason: input.note ?? null,
        actorId: origin.actorId,
        actorRole: origin.actorRole,
        customerId: (result) => (result as OpenRequestResult).view.customerId,
        auditSuccessWhen: (result) => result.outcome === 'CREATED',
        afterValue: (result: unknown) => {
          const { view } = result as OpenRequestResult;
          return {
            requestId: view.requestId,
            deviceId: view.deviceId,
            consumableType,
            status: view.status,
            source: view.source,
            version: view.version,
            ...(origin.source === 'DEVICE' ? { requestKey: origin.requestKey } : {}),
          };
        },
      },
      async (tx) => {
        // Serialize intake with lifecycle/assignment writes and other sources for the same device.
        await tx.$queryRaw`SELECT id FROM devices WHERE id = ${input.deviceId} FOR UPDATE`;
        const device = await tx.device.findUnique({
          where: { id: input.deviceId },
          select: { id: true, customerId: true, siteId: true, lifecycleStatus: true },
        });
        if (!device) throw consumableNotFound();
        if (origin.source === 'DEVICE' && device.lifecycleStatus !== 'Active') {
          throw forbidden('Only an active device can submit a consumable request');
        }
        const { customerId } = device;
        if (customerId === null) throw consumableConflict('The device is not assigned to a customer');
        if (device.lifecycleStatus === 'Retired') throw consumableConflict('The device is retired');

        const submission =
          origin.source === 'DEVICE'
            ? {
                deviceId: device.id,
                requestKey: origin.requestKey,
                occurredAt: origin.occurredAt,
                payloadHash: origin.payloadHash,
                assignmentId: await currentSubmissionAssignment(tx, origin, { ...device, customerId }, at),
              }
            : null;
        if (submission) {
          const prior = await tx.consumableDeviceSubmission.findUnique({
            where: { deviceId_requestKey: { deviceId: device.id, requestKey: submission.requestKey } },
            include: { request: true },
          });
          if (prior) {
            if (prior.payloadHash !== submission.payloadHash) throw consumableIdempotencyConflict();
            if (prior.assignmentId !== submission.assignmentId || prior.request.customerId !== customerId) {
              throw consumableConflict('The request does not belong to the current active assignment');
            }
            return { view: toView(prior.request as RequestRow), outcome: 'REPLAYED' };
          }
        }

        const existing = await requests(tx).findFirst({
          where: { deviceId: device.id, consumableType, status: { in: [...OPEN_REQUEST_STATUSES] } },
        });
        if (existing && existing.customerId !== customerId) {
          throw consumableConflict(
            'An open request must be resolved before submitting another request for this device',
          );
        }
        const row =
          existing ??
          (await requests(tx).create({
            data: {
              customerId,
              deviceId: device.id,
              consumableType,
              status: 'PENDING',
              source: origin.source,
              requestedBy: origin.actorId,
              processNote: input.note ?? null,
              stageNotes: input.note === undefined ? {} : { request: { note: input.note, source: 'RECORDED' } },
            },
          }));
        if (submission) {
          await tx.consumableDeviceSubmission.create({ data: { ...submission, requestId: row.id } });
          if (existing) {
            await recordAudit(tx, {
              objectType: 'consumableRequest',
              objectId: row.id,
              action: 'consumable.request.link',
              actorId: origin.actorId,
              actorRole: origin.actorRole,
              customerId,
              result: 'SUCCESS',
              reason: input.note ?? null,
              afterValue: { requestId: row.id, deviceId: device.id, requestKey: submission.requestKey },
            });
          }
        }
        return { view: toView(row), outcome: existing ? (submission ? 'LINKED_OPEN' : 'REPLAYED') : 'CREATED' };
      },
    );
  try {
    return await execute();
  } catch (err) {
    // During rollout an older admin process can still win the open-request unique index.
    if ((err as { code?: string })?.code === 'P2002') return execute();
    throw err;
  }
}

// ---------- 状态迁移（If-Match + 授权角色 + 审计） ----------

export interface TransitionRequestInput {
  readonly requestId: string;
  readonly ifMatchVersion: number;
  /** 当前阶段备注（完成和取消必填，处理选填）。 */
  readonly note?: string | undefined;
}

const TRANSITION_NOTE_STAGE = {
  PROCESSING: 'processing',
  COMPLETED: 'completion',
  CANCELLED: 'cancellation',
} as const satisfies Record<Exclude<ConsumableRequestStatus, 'PENDING'>, NoteStage>;

async function transition(
  deps: ConsumableRequestDeps,
  actor: ActorContext,
  input: TransitionRequestInput,
  to: keyof typeof TRANSITION_NOTE_STAGE,
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
      if (input.note !== undefined) {
        data.processNote = input.note;
        data.stageNotes = {
          ...stageNotesFor(current),
          [TRANSITION_NOTE_STAGE[to]]: { note: input.note, source: 'RECORDED' },
        };
      }
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

/** PROCESSING→COMPLETED（授权角色；完成备注必填；记录 completedAt）。 */
export async function completeConsumableRequest(
  deps: ConsumableRequestDeps,
  actor: ActorContext,
  input: TransitionRequestInput,
): Promise<ConsumableRequestView> {
  if (!input.note || input.note.trim().length === 0) {
    throw consumableValidationFailed('A completion note is required when completing a request');
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
