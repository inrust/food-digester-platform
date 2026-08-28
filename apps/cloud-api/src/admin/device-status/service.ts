/**
 * BE-DEV-03 Device Suspend/Reactivate 领域服务。
 *
 * 规则（技术对接要求 + DOM-01 迁移表）：
 * - suspend：仅 Active → Suspended（DOM-01 ADMIN + SuperAdmin/Operator，强制原因）；
 *   生成 DEVICE_SUSPENDED Notification（Outbox 下行，deviceAction=SYNC）；
 * - reactivate：仅 Suspended → Active；强制原因 + 问题已解决标志（issueResolved=true），
 *   管理员批准 = 持有 device:write 的调用者（批准人写入审计）；生成 STATUS_CHANGED Notification；
 * - 镜像：DOM-01 operationalMirror 产出的 operational 轴状态历史同事务落库
 *   （device_latest_state.operationalStatus 为设备上报口径，由 Heartbeat 维护，本服务不写）；
 * - 幂等：已处于目标状态的重复请求 → 重放（无写入、无新通知、无新审计）；
 * - 并发：生命周期条件更新兜底，状态漂移 → 409 CONFLICT；
 * - 功能边界：不执行设备端模式切换（仅通知，设备拉取差异由 Sync 负责）。
 */
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';
import { transitionLifecycle } from '@fdp/domain';
import type { LifecycleStatus, OperationalStatus } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import {
  deviceStatusConflict,
  deviceStatusNotFound,
  deviceStatusTransitionNotAllowed,
  deviceStatusValidationFailed,
} from './errors.js';

export const DEVICE_SUSPENDED_NOTIFICATION = 'DEVICE_SUSPENDED' as const;
export const STATUS_CHANGED_NOTIFICATION = 'STATUS_CHANGED' as const;

const notificationTopic = (deviceId: string): string => `bnx/device/${deviceId}/notification`;

export interface DeviceStatusView {
  readonly deviceId: string;
  readonly lifecycleStatus: string;
  readonly operationalStatus: string | null;
  /** 本次真实变更生成的通知类型；幂等重放为 null。 */
  readonly notification: typeof DEVICE_SUSPENDED_NOTIFICATION | typeof STATUS_CHANGED_NOTIFICATION | null;
  readonly replayed: boolean;
}

interface DeviceRow {
  readonly id: string;
  readonly customerId: string | null;
  readonly lifecycleStatus: string;
}

interface DeviceDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface LatestStateDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<{ operationalStatus: string | null } | null>;
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

function latestStates(client: DbClient): LatestStateDelegate {
  return (client as unknown as Record<string, unknown>).deviceLatestState as LatestStateDelegate;
}

function requireReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw deviceStatusValidationFailed('The reason is required for this operation');
  }
  return value.trim();
}

interface TransitionInput {
  readonly deviceId: string;
  readonly action: 'suspend' | 'reactivate';
  readonly from: LifecycleStatus;
  readonly to: LifecycleStatus;
  readonly notification: typeof DEVICE_SUSPENDED_NOTIFICATION | typeof STATUS_CHANGED_NOTIFICATION;
  readonly reason: string;
  readonly issueResolved?: boolean;
}

async function executeTransition(
  rootClient: DbClient,
  actor: ActorContext,
  input: TransitionInput,
): Promise<DeviceStatusView> {
  const device = await devices(rootClient).findFirst({ where: { id: input.deviceId } });
  if (!device) throw deviceStatusNotFound();
  // 幂等：已处于目标状态 → 重放（重复请求不重复通知）
  if (device.lifecycleStatus === input.to) {
    const latest = await latestStates(rootClient).findFirst({ where: { deviceId: device.id } });
    return {
      deviceId: device.id,
      lifecycleStatus: input.to,
      operationalStatus: latest?.operationalStatus ?? null,
      notification: null,
      replayed: true,
    };
  }
  if (device.lifecycleStatus !== input.from) {
    throw deviceStatusTransitionNotAllowed(device.lifecycleStatus, input.action);
  }

  return audited<DeviceStatusView>(
    rootClient,
    {
      objectType: 'device',
      objectId: input.deviceId,
      action: `device.${input.action}`,
      reason: input.reason,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: device.customerId,
      beforeValue: { lifecycleStatus: input.from },
      afterValue: (result: unknown) => {
        const view = result as DeviceStatusView;
        return {
          lifecycleStatus: view.lifecycleStatus,
          operationalStatus: view.operationalStatus,
          notification: view.notification,
          // 恢复审批：问题已解决标志 + 批准人（管理员批准写审计）
          ...(input.action === 'reactivate' ? { issueResolved: true, approvedBy: actor.actorId } : {}),
        };
      },
    },
    async (tx) => {
      const latest = await latestStates(tx).findFirst({ where: { deviceId: device.id } });
      const effects = transitionLifecycle(
        {
          id: device.id,
          lifecycleStatus: input.from,
          operationalStatus: (latest?.operationalStatus ?? null) as OperationalStatus | null,
        },
        input.to,
        {
          actorType: 'ADMIN',
          actorId: actor.actorId,
          actorRole: actor.roles[0] as 'PlatformSuperAdmin' | 'PlatformOperator',
        },
        {
          reason: input.reason,
          ...(input.action === 'reactivate' ? { issueResolvedApproved: true } : {}),
        },
      );

      // 并发兜底：生命周期条件更新，仅一个事务完成迁移
      const { count } = await devices(tx).updateMany({
        where: { id: device.id, lifecycleStatus: input.from },
        data: { lifecycleStatus: input.to },
      });
      if (count !== 1) throw deviceStatusConflict();

      const history = (tx as unknown as Record<string, unknown>).deviceStateHistory as StateHistoryDelegate;
      for (const entry of effects.stateHistory) {
        await history.create({
          data: {
            deviceId: entry.deviceId,
            fromStatus: entry.fromStatus,
            toStatus: entry.toStatus,
            actorType: entry.actorType,
            actorId: entry.actorId,
            reason: entry.reason,
          },
        });
      }

      // CT-04 通知经 Outbox 下发（下行分发器投递 MQTT；本任务不直接发布，不执行设备端模式切换）
      const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
      await outbox.create({
        data: {
          eventType: input.notification,
          aggregateType: 'device',
          aggregateId: device.id,
          payload: {
            topic: notificationTopic(device.id),
            data: { type: input.notification, action: 'SYNC' },
          },
        },
      });

      return {
        deviceId: device.id,
        lifecycleStatus: input.to,
        operationalStatus: effects.operational?.to ?? latest?.operationalStatus ?? null,
        notification: input.notification,
        replayed: false,
      };
    },
  );
}

export interface SuspendInput {
  readonly deviceId: string;
  readonly reason: string;
}

/** 挂起：Active → Suspended（强制原因 + DEVICE_SUSPENDED 通知）。 */
export async function suspendDevice(
  rootClient: DbClient,
  actor: ActorContext,
  input: SuspendInput,
): Promise<DeviceStatusView> {
  return executeTransition(rootClient, actor, {
    deviceId: input.deviceId,
    action: 'suspend',
    from: 'Active',
    to: 'Suspended',
    notification: DEVICE_SUSPENDED_NOTIFICATION,
    reason: input.reason,
  });
}

export interface ReactivateInput {
  readonly deviceId: string;
  readonly reason: string;
  /** 问题已解决标志（必须为 true；管理员批准由调用者身份承担并写审计）。 */
  readonly issueResolved: boolean;
}

/** 恢复：Suspended → Active（强制原因 + 问题已解决标志 + STATUS_CHANGED 通知）。 */
export async function reactivateDevice(
  rootClient: DbClient,
  actor: ActorContext,
  input: ReactivateInput,
): Promise<DeviceStatusView> {
  if (input.issueResolved !== true) {
    throw deviceStatusValidationFailed('issueResolved must be true to reactivate a device');
  }
  return executeTransition(rootClient, actor, {
    deviceId: input.deviceId,
    action: 'reactivate',
    from: 'Suspended',
    to: 'Active',
    notification: STATUS_CHANGED_NOTIFICATION,
    reason: input.reason,
    issueResolved: true,
  });
}

/** 解析 suspend/reactivate 请求体。 */
export function parseSuspendBody(body: unknown): { reason: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  return { reason: requireReason(input.reason) };
}

export function parseReactivateBody(body: unknown): { reason: string; issueResolved: boolean } {
  const input = (body ?? {}) as Record<string, unknown>;
  return { reason: requireReason(input.reason), issueResolved: input.issueResolved === true };
}
