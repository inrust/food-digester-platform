/**
 * BE-DEV-02 Device Assignment 领域服务：分配/调整 Customer 和 Site。
 *
 * 规则（技术对接要求）：
 * - 仅 Onboarded/Assigned 生命周期合法；首次分配（Onboarded）经 DOM-01 transitionLifecycle
 *   迁移到 Assigned（该迁移按 DOM-01 迁移表仅 PlatformSuperAdmin 可执行，Operator 触发 403）；
 *   Assigned 状态下的调整为同状态再分配（无生命周期迁移）；
 * - Site 必须属于目标 Customer（跨 Customer Site → 400）；Customer/Site 不存在或已删除 → 404；
 * - Assignment 历史与 Authorization Window：device_assignments 每行即一段授权窗口
 *   （[assignedAt, endedAt)）；再分配时当前 ACTIVE 行闭合（ENDED + endedAt），新行 ACTIVE；
 * - 每次真实变更恰好生成一个 ASSIGNMENT_CHANGED Notification（经 Outbox，下行分发器投递）；
 * - 幂等：目标与当前 ACTIVE 分配相同 → 重放（无写入、无新通知）；并发首次分配撞部分唯一
 *   索引 → 回读胜出记录，同目标重放、异目标 409；
 * - 功能边界：不自动创建 License（BE-LIC 任务）。
 *
 * 审计：DOM-03 audited（device.assignment.assign），SUCCESS 与业务同事务，失败记 FAILURE；
 * 首次分配的 DOM-01 状态历史（lifecycle Onboarded→Assigned）同事务落库。
 */
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';
import { transitionLifecycle } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import {
  assignmentConflict,
  assignmentNotFound,
  assignmentStateNotAllowed,
  assignmentValidationFailed,
} from './errors.js';
import { parseStrictObject } from '../shared/strict-object.js';

export const ASSIGNMENT_CHANGED_NOTIFICATION = 'ASSIGNMENT_CHANGED' as const;
export const ASSIGNABLE_LIFECYCLES = ['Onboarded', 'Assigned'] as const;

const notificationTopic = (deviceId: string): string => `bnx/device/${deviceId}/notification`;

export interface AssignDeviceInput {
  readonly deviceId: string;
  readonly customerId: string;
  readonly siteId: string;
  readonly reason?: string | undefined;
}

export interface AssignmentView {
  readonly assignmentId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly siteId: string;
  readonly status: string;
  readonly assignedBy: string;
  readonly reason: string | null;
  /** 授权窗口起点。 */
  readonly assignedAt: string;
  /** 授权窗口终点（ACTIVE 为 null）。 */
  readonly endedAt: string | null;
  /** 操作后的设备生命周期。 */
  readonly lifecycleStatus: string;
  /** 本次是否真实产生了 ASSIGNMENT_CHANGED 通知（重放为 null）。 */
  readonly notification: typeof ASSIGNMENT_CHANGED_NOTIFICATION | null;
  /** 幂等重放：目标与当前 ACTIVE 分配一致，未产生任何写入。 */
  readonly replayed: boolean;
}

interface DeviceRow {
  readonly id: string;
  readonly customerId: string | null;
  readonly siteId: string | null;
  readonly lifecycleStatus: string;
}

interface AssignmentRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly siteId: string;
  readonly status: string;
  readonly assignedBy: string;
  readonly reason: string | null;
  readonly assignedAt: Date;
  readonly endedAt: Date | null;
}

interface DeviceDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface AssignmentDelegate {
  findFirst(args: Record<string, unknown>): Promise<AssignmentRow | null>;
  findMany(args: Record<string, unknown>): Promise<AssignmentRow[]>;
  create(args: { data: Record<string, unknown> }): Promise<AssignmentRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface LookupDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string; customerId?: string } | null>;
}

interface StateHistoryDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

interface OutboxDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

function devices(client: DbClient): DeviceDelegate {
  return (client as unknown as Record<string, unknown>).device as DeviceDelegate;
}

function assignments(client: DbClient): AssignmentDelegate {
  return (client as unknown as Record<string, unknown>).deviceAssignment as AssignmentDelegate;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

function toView(
  row: AssignmentRow,
  lifecycleStatus: string,
  notification: typeof ASSIGNMENT_CHANGED_NOTIFICATION | null,
  replayed: boolean,
): AssignmentView {
  return {
    assignmentId: row.id,
    deviceId: row.deviceId,
    customerId: row.customerId,
    siteId: row.siteId,
    status: row.status,
    assignedBy: row.assignedBy,
    reason: row.reason,
    assignedAt: row.assignedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    lifecycleStatus,
    notification,
    replayed,
  };
}

/** 解析并校验分配请求体（跨 Customer Site 引用在此拒绝）。 */
export function parseAssignInput(deviceId: string, body: unknown): AssignDeviceInput {
  const input = parseStrictObject(body, ['customerId', 'siteId', 'reason'], assignmentValidationFailed);
  const customerId =
    typeof input.customerId === 'string' && input.customerId.trim().length > 0 ? input.customerId.trim() : null;
  if (!customerId) throw assignmentValidationFailed('customerId is required');
  const siteId = typeof input.siteId === 'string' && input.siteId.trim().length > 0 ? input.siteId.trim() : null;
  if (!siteId) throw assignmentValidationFailed('siteId is required');
  const reason =
    input.reason === undefined || input.reason === null
      ? undefined
      : typeof input.reason === 'string'
        ? input.reason
        : (() => {
            throw assignmentValidationFailed('reason must be a string');
          })();
  return { deviceId, customerId, siteId, ...(reason !== undefined ? { reason } : {}) };
}

async function loadCurrentAssignment(client: DbClient, deviceId: string): Promise<AssignmentRow | null> {
  return assignments(client).findFirst({ where: { deviceId, status: 'ACTIVE' } });
}

export async function assignDevice(
  rootClient: DbClient,
  actor: ActorContext,
  input: AssignDeviceInput,
  now: () => Date = () => new Date(),
): Promise<AssignmentView> {
  // 前置校验（事务外）：设备/Customer/Site 存在性与归属
  const device = await devices(rootClient).findFirst({ where: { id: input.deviceId } });
  if (!device) throw assignmentNotFound();
  if (!(ASSIGNABLE_LIFECYCLES as readonly string[]).includes(device.lifecycleStatus)) {
    throw assignmentStateNotAllowed(device.lifecycleStatus);
  }
  const customers = (rootClient as unknown as Record<string, unknown>).customer as LookupDelegate;
  const customer = await customers.findFirst({ where: { id: input.customerId, deletedAt: null } });
  if (!customer) throw assignmentNotFound('The referenced customer does not exist');
  const sites = (rootClient as unknown as Record<string, unknown>).site as LookupDelegate;
  const site = await sites.findFirst({ where: { id: input.siteId, deletedAt: null } });
  if (!site) throw assignmentNotFound('The referenced site does not exist');
  if (site.customerId !== input.customerId) {
    // 跨 Customer Site 被拒绝
    throw assignmentValidationFailed('siteId does not belong to the given customerId');
  }

  // 幂等：目标与当前 ACTIVE 分配一致 → 重放，不产生写入/通知
  const current = await loadCurrentAssignment(rootClient, input.deviceId);
  if (current && current.customerId === input.customerId && current.siteId === input.siteId) {
    return toView(current, device.lifecycleStatus, null, true);
  }

  const reason = input.reason?.trim() || null;
  const execute = async (tx: DbClient): Promise<{ row: AssignmentRow; lifecycleStatus: string }> => {
    // 首次分配：DOM-01 Onboarded → Assigned（角色/前置由领域层强制）
    let toLifecycle: string = device.lifecycleStatus;
    if (device.lifecycleStatus === 'Onboarded') {
      const effects = transitionLifecycle(
        { id: device.id, lifecycleStatus: 'Onboarded', operationalStatus: null },
        'Assigned',
        {
          actorType: 'ADMIN',
          actorId: actor.actorId,
          actorRole: actor.roles[0] as 'PlatformSuperAdmin' | 'PlatformOperator',
        },
        { assignment: { customerId: input.customerId, siteId: input.siteId } },
      );
      const { count } = await devices(tx).updateMany({
        where: { id: device.id, lifecycleStatus: 'Onboarded' },
        data: { customerId: input.customerId, siteId: input.siteId, lifecycleStatus: 'Assigned' },
      });
      if (count === 0) throw assignmentConflict('The device state was changed concurrently; refresh and retry');
      toLifecycle = 'Assigned';
      const stateHistory = (tx as unknown as Record<string, unknown>).deviceStateHistory as StateHistoryDelegate;
      for (const entry of effects.stateHistory) {
        await stateHistory.create({
          data: {
            deviceId: entry.deviceId,
            axis: entry.axis,
            fromStatus: entry.fromStatus,
            toStatus: entry.toStatus,
            actorType: entry.actorType,
            actorId: entry.actorId,
            reason: entry.reason,
          },
        });
      }
    } else {
      // Assigned 同状态再分配：仅更新归属（无生命周期迁移）
      const { count } = await devices(tx).updateMany({
        where: { id: device.id, lifecycleStatus: 'Assigned' },
        data: { customerId: input.customerId, siteId: input.siteId },
      });
      if (count === 0) throw assignmentConflict('The device state was changed concurrently; refresh and retry');
    }

    // 闭合当前授权窗口（Authorization Window），开启新窗口
    await assignments(tx).updateMany({
      where: { deviceId: device.id, status: 'ACTIVE' },
      data: { status: 'ENDED', endedAt: now() },
    });
    const row = await assignments(tx).create({
      data: {
        deviceId: device.id,
        customerId: input.customerId,
        siteId: input.siteId,
        status: 'ACTIVE',
        assignedBy: actor.actorId,
        reason,
      },
    });

    // CT-04 通知经 Outbox 下发（下行分发器投递 MQTT；本任务不直接发布）
    const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
    await outbox.create({
      data: {
        eventType: ASSIGNMENT_CHANGED_NOTIFICATION,
        aggregateType: 'device',
        aggregateId: device.id,
        payload: {
          topic: notificationTopic(device.id),
          data: { type: ASSIGNMENT_CHANGED_NOTIFICATION, action: 'SYNC' },
          assignmentId: row.id,
        },
      },
    });
    return { row, lifecycleStatus: toLifecycle };
  };

  try {
    const result = await audited<{ row: AssignmentRow; lifecycleStatus: string }>(
      rootClient,
      {
        objectType: 'device',
        objectId: input.deviceId,
        action: 'device.assignment.assign',
        reason,
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        customerId: input.customerId,
        afterValue: (r: unknown) => {
          const { row, lifecycleStatus } = r as { row: AssignmentRow; lifecycleStatus: string };
          return { assignmentId: row.id, customerId: row.customerId, siteId: row.siteId, lifecycleStatus };
        },
      },
      execute,
    );
    return toView(result.row, result.lifecycleStatus, ASSIGNMENT_CHANGED_NOTIFICATION, false);
  } catch (err) {
    // 并发首次分配撞部分唯一索引（每设备仅一条 ACTIVE）：回读胜出记录幂等收口
    if (isUniqueViolation(err)) {
      const winner = await loadCurrentAssignment(rootClient, input.deviceId);
      if (winner && winner.customerId === input.customerId && winner.siteId === input.siteId) {
        const fresh = await devices(rootClient).findFirst({ where: { id: input.deviceId } });
        return toView(winner, fresh?.lifecycleStatus ?? device.lifecycleStatus, null, true);
      }
      throw assignmentConflict('A conflicting assignment was created concurrently');
    }
    throw err;
  }
}

/** Assignment 历史（含已闭合授权窗口），按 assignedAt 倒序，上限 50 条。 */
export async function listAssignmentHistory(
  client: DbClient,
  deviceId: string,
  lifecycleStatus: string,
): Promise<AssignmentView[]> {
  const rows = await assignments(client).findMany({
    where: { deviceId },
    orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
    take: 50,
  });
  return rows.map((row) => toView(row, lifecycleStatus, null, false));
}
