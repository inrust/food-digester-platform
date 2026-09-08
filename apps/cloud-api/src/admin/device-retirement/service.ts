/**
 * BE-DEV-04 Device Retirement 工作流 Service。
 *
 * 管理员 retire（POST /admin/devices/{id}/retire，强制原因 + 确认标志）：
 * 1. DOM-01 迁移 Active/Suspended → Retired（仅 PlatformSuperAdmin，Retired 永久不可恢复，
 *    operational 镜像状态历史同事务落库）；
 * 2. 撤销 Assignment（ACTIVE → ENDED，授权窗口闭合）；
 * 3. 撤销 License（非终态 → Revoked）并停用其 Entitlement（enabled=false）；
 * 4. 创建待确认退役记录（device_retirements PENDING_CONFIRMATION）；
 * 5. 生成 DEVICE_RETIRED Notification（Outbox 下行，deviceAction=SYNC）；
 * 6. 证书保持 ACTIVE——顺序约束：设备须能调用 BE-SYNC-02 deactivate 确认后才断证。
 *
 * force-complete（POST /admin/devices/{id}/retire/complete，强制原因）：
 * 离线设备不等待确认，由调用方触发完成退役（CONFIRMED + FORCE_COMPLETE + 撤销 ACTIVE 证书），
 * 与 BE-SYNC-02 共享 completeRetirementStep。DEC-014@1.0.0 的超时评估器按
 * initiatedAt+72h 自动完成并记录 UNCONFIRMED_TIMEOUT；重复调度和并发确认均无重复副作用。
 *
 * 幂等：已 Retired 且退役记录存在 → replayed；force-complete 已 CONFIRMED → replayed。
 * 审计：device.retire / device.retire.force_complete（DOM-03 audited）。
 */
import type { DbClient } from '@fdp/database';
import { audited, recordAudit, withTransaction } from '@fdp/database';
import { RETIREMENT_CONFIRMATION_WINDOW_MS } from '@fdp/auth';
import { transitionLifecycle } from '@fdp/domain';
import type { OperationalStatus } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import {
  COMPLETION_FORCE_COMPLETE,
  COMPLETION_UNCONFIRMED_TIMEOUT,
  RETIREMENT_CONFIRMED,
  RETIREMENT_PENDING,
  completeRetirementStep,
} from '../../device/deactivate.js';
import {
  retirementConflict,
  retirementNotFound,
  retirementStateNotAllowed,
  retirementValidationFailed,
} from './errors.js';
import {
  processRetirementIotRevocations,
  type RetirementCertificateRevoker,
  type RetirementIotRevocationResult,
} from './iot-revocation.js';
import { parseStrictObject } from '../shared/strict-object.js';

export const DEVICE_RETIRED_NOTIFICATION = 'DEVICE_RETIRED' as const;
/** DOM-01：仅 Active/Suspended 可退役。 */
export const RETIREABLE_LIFECYCLES = ['Active', 'Suspended'] as const;
/** 撤销 License 的非终态集合（Expired/Revoked 不重复处理）。 */
export const REVOCABLE_LICENSE_STATUSES = ['Draft', 'Issued', 'Active', 'ExpiringSoon', 'Renewed'] as const;

const notificationTopic = (deviceId: string): string => `bnx/device/${deviceId}/notification`;

export interface RetirementRecordView {
  readonly retirementId: string;
  readonly status: string;
  readonly reason: string;
  readonly initiatedBy: string;
  readonly initiatedAt: string;
  readonly confirmedAt: string | null;
  readonly completionMethod: string | null;
  readonly certificateRevokedAt: string | null;
}

export interface RetirementView {
  readonly deviceId: string;
  readonly lifecycleStatus: 'Retired';
  readonly retirement: RetirementRecordView;
  /** retire 真实变更生成 DEVICE_RETIRED；force-complete/重放为 null。 */
  readonly notification: typeof DEVICE_RETIRED_NOTIFICATION | null;
  readonly replayed: boolean;
}

interface DeviceRow {
  readonly id: string;
  readonly customerId: string | null;
  readonly lifecycleStatus: string;
}

interface RetirementRow {
  readonly id: string;
  readonly deviceId: string;
  readonly status: string;
  readonly reason: string;
  readonly initiatedBy: string;
  readonly initiatedAt: Date;
  readonly confirmedAt: Date | null;
  readonly completionMethod: string | null;
  readonly certificateRevokedAt: Date | null;
}

interface DeviceDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface RetirementDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<RetirementRow | null>;
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    take?: number;
  }): Promise<RetirementRow[]>;
  create(args: { data: Record<string, unknown> }): Promise<RetirementRow>;
}

interface UpdateManyDelegate {
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function devices(client: DbClient): DeviceDelegate {
  return (client as unknown as Record<string, unknown>).device as DeviceDelegate;
}

function retirements(client: DbClient): RetirementDelegate {
  return (client as unknown as Record<string, unknown>).deviceRetirement as RetirementDelegate;
}

function toRecordView(row: RetirementRow): RetirementRecordView {
  return {
    retirementId: row.id,
    status: row.status,
    reason: row.reason,
    initiatedBy: row.initiatedBy,
    initiatedAt: row.initiatedAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    completionMethod: row.completionMethod,
    certificateRevokedAt: row.certificateRevokedAt?.toISOString() ?? null,
  };
}

function requireReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw retirementValidationFailed('The reason is required for this operation');
  }
  return value.trim();
}

/** 解析 retire 请求体：强制原因 + 确认标志。 */
export function parseRetireBody(body: unknown): { reason: string; confirm: true } {
  const input = parseStrictObject(body, ['reason', 'confirm'], retirementValidationFailed);
  const reason = requireReason(input.reason);
  if (input.confirm !== true) {
    throw retirementValidationFailed('confirm must be true to retire a device');
  }
  return { reason, confirm: true };
}

/** 解析 force-complete 请求体：强制原因。 */
export function parseForceCompleteBody(body: unknown): { reason: string } {
  const input = parseStrictObject(body, ['reason'], retirementValidationFailed);
  return { reason: requireReason(input.reason) };
}

async function loadDeviceAndRetirement(
  client: DbClient,
  deviceId: string,
): Promise<{ device: DeviceRow; retirement: RetirementRow | null }> {
  const device = await devices(client).findFirst({ where: { id: deviceId } });
  if (!device) throw retirementNotFound();
  const retirement = await retirements(client).findFirst({ where: { deviceId } });
  return { device, retirement };
}

/** 管理员 retire：Active/Suspended → Retired + 撤销 Assignment/License/Entitlement + 待确认记录 + DEVICE_RETIRED。 */
export async function retireDevice(
  rootClient: DbClient,
  actor: ActorContext,
  input: { readonly deviceId: string; readonly reason: string },
  now: () => Date = () => new Date(),
): Promise<RetirementView> {
  const { device, retirement } = await loadDeviceAndRetirement(rootClient, input.deviceId);
  // 幂等：已退役且记录存在 → 重放
  if (device.lifecycleStatus === 'Retired') {
    if (retirement) {
      return {
        deviceId: device.id,
        lifecycleStatus: 'Retired',
        retirement: toRecordView(retirement),
        notification: null,
        replayed: true,
      };
    }
    throw retirementConflict('The device is retired but has no retirement record');
  }
  if (!(RETIREABLE_LIFECYCLES as readonly string[]).includes(device.lifecycleStatus)) {
    throw retirementStateNotAllowed(`The device lifecycle status ${device.lifecycleStatus} does not allow retirement`);
  }
  const from = device.lifecycleStatus as 'Active' | 'Suspended';
  const at = now();

  return audited<RetirementView>(
    rootClient,
    {
      objectType: 'device',
      objectId: device.id,
      action: 'device.retire',
      reason: input.reason,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: device.customerId,
      beforeValue: { lifecycleStatus: from },
      afterValue: (result: unknown) => {
        const view = result as RetirementView;
        return { lifecycleStatus: view.lifecycleStatus, retirementId: view.retirement.retirementId };
      },
    },
    async (tx) => {
      const latest = (tx as unknown as Record<string, unknown>).deviceLatestState as {
        findFirst(args: { where: Record<string, unknown> }): Promise<{ operationalStatus: string | null } | null>;
      };
      const latestState = await latest.findFirst({ where: { deviceId: device.id } });

      // DOM-01 迁移（角色/原因由领域层强制；Operator → FORBIDDEN）
      const effects = transitionLifecycle(
        {
          id: device.id,
          lifecycleStatus: from,
          operationalStatus: (latestState?.operationalStatus ?? null) as OperationalStatus | null,
        },
        'Retired',
        {
          actorType: 'ADMIN',
          actorId: actor.actorId,
          actorRole: actor.roles[0] as 'PlatformSuperAdmin' | 'PlatformOperator',
        },
        { reason: input.reason },
      );

      // 并发兜底：生命周期条件更新
      const { count } = await devices(tx).updateMany({
        where: { id: device.id, lifecycleStatus: from },
        data: { lifecycleStatus: 'Retired' },
      });
      if (count !== 1) throw retirementConflict('The device state was changed concurrently; refresh and retry');

      const stateHistory = (tx as unknown as Record<string, unknown>).deviceStateHistory as {
        create(args: { data: Record<string, unknown> }): Promise<unknown>;
      };
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

      // 撤销 Assignment（授权窗口闭合）
      await ((tx as unknown as Record<string, unknown>).deviceAssignment as UpdateManyDelegate).updateMany({
        where: { deviceId: device.id, status: 'ACTIVE' },
        data: { status: 'ENDED', endedAt: at },
      });

      // 撤销 License（非终态 → Revoked）并停用其 Entitlement
      const licenses = (tx as unknown as Record<string, unknown>).license as UpdateManyDelegate & {
        findMany(args: { where: Record<string, unknown> }): Promise<{ id: string }[]>;
      };
      const revocable = await licenses.findMany({
        where: { deviceId: device.id, status: { in: [...REVOCABLE_LICENSE_STATUSES] } },
      });
      if (revocable.length > 0) {
        const ids = revocable.map((l) => l.id);
        await licenses.updateMany({ where: { id: { in: ids } }, data: { status: 'Revoked' } });
        await ((tx as unknown as Record<string, unknown>).licenseEntitlement as UpdateManyDelegate).updateMany({
          where: { licenseId: { in: ids }, enabled: true },
          data: { enabled: false },
        });
      }

      // 待确认退役记录（证书保持 ACTIVE：设备须能确认 Deactivate，见 BE-SYNC-02）
      const retirementRow = await retirements(tx).create({
        data: {
          deviceId: device.id,
          status: RETIREMENT_PENDING,
          reason: input.reason,
          initiatedBy: actor.actorId,
          initiatedAt: at,
        },
      });

      // CT-04 通知经 Outbox 下发
      const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as {
        create(args: { data: Record<string, unknown> }): Promise<unknown>;
      };
      await outbox.create({
        data: {
          eventType: DEVICE_RETIRED_NOTIFICATION,
          aggregateType: 'device',
          aggregateId: device.id,
          payload: {
            topic: notificationTopic(device.id),
            data: { type: DEVICE_RETIRED_NOTIFICATION, action: 'SYNC' },
            retirementId: retirementRow.id,
          },
        },
      });

      return {
        deviceId: device.id,
        lifecycleStatus: 'Retired',
        retirement: toRecordView(retirementRow),
        notification: DEVICE_RETIRED_NOTIFICATION,
        replayed: false,
      };
    },
  );
}

/** force-complete：离线设备不等待确认，由调用方触发完成退役 + 证书停用 + 审计。 */
export async function forceCompleteRetirement(
  rootClient: DbClient,
  actor: ActorContext,
  input: { readonly deviceId: string; readonly reason: string },
  now: () => Date = () => new Date(),
): Promise<RetirementView> {
  const { device, retirement } = await loadDeviceAndRetirement(rootClient, input.deviceId);
  if (device.lifecycleStatus !== 'Retired') {
    throw retirementStateNotAllowed(
      `The device lifecycle status ${device.lifecycleStatus} does not allow force-complete`,
    );
  }
  if (!retirement) throw retirementConflict('The device has no retirement record');
  if (retirement.status === RETIREMENT_CONFIRMED) {
    return {
      deviceId: device.id,
      lifecycleStatus: 'Retired',
      retirement: toRecordView(retirement),
      notification: null,
      replayed: true,
    };
  }
  const at = now();

  return audited<RetirementView>(
    rootClient,
    {
      objectType: 'device',
      objectId: device.id,
      action: 'device.retire.force_complete',
      reason: input.reason,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: device.customerId,
      beforeValue: { retirementStatus: RETIREMENT_PENDING },
      afterValue: (result: unknown) => {
        const view = result as RetirementView;
        return { retirementStatus: view.retirement.status, completionMethod: view.retirement.completionMethod };
      },
    },
    async (tx) => {
      const step = await completeRetirementStep(tx, {
        deviceId: device.id,
        at,
        completionMethod: COMPLETION_FORCE_COMPLETE,
      });
      if (!step.confirmed) {
        throw retirementConflict('The retirement was confirmed concurrently; refresh and retry');
      }
      return {
        deviceId: device.id,
        lifecycleStatus: 'Retired',
        retirement: toRecordView({
          ...retirement,
          status: RETIREMENT_CONFIRMED,
          confirmedAt: at,
          completionMethod: COMPLETION_FORCE_COMPLETE,
          certificateRevokedAt: at,
        }),
        notification: null,
        replayed: false,
      };
    },
  );
}

export interface RetirementTimeoutEvaluation {
  readonly examined: number;
  readonly completed: number;
  readonly skipped: number;
  readonly completedDeviceIds: readonly string[];
  readonly iotRevocations: RetirementIotRevocationResult;
}

/**
 * DEC-014 超时评估器。候选查询只是优化，最终状态由事务内条件更新裁决；因此与设备确认、
 * 人工强制和重复调度并发时，只有一个执行者能完成撤证并写入一次成功审计。
 */
export async function evaluateRetirementTimeouts(
  rootClient: DbClient,
  options: {
    readonly now?: Date;
    readonly batchSize?: number;
    readonly revoker?: RetirementCertificateRevoker;
  } = {},
): Promise<RetirementTimeoutEvaluation> {
  const at = options.now ?? new Date();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 1000));
  const cutoff = new Date(at.getTime() - RETIREMENT_CONFIRMATION_WINDOW_MS);
  const candidates = await retirements(rootClient).findMany({
    where: { status: RETIREMENT_PENDING, initiatedAt: { lte: cutoff } },
    orderBy: { initiatedAt: 'asc' },
    take: batchSize,
  });
  const completedDeviceIds: string[] = [];
  let skipped = 0;

  for (const retirement of candidates) {
    const confirmed = await withTransaction(rootClient, async (tx) => {
      const step = await completeRetirementStep(tx, {
        deviceId: retirement.deviceId,
        at,
        completionMethod: COMPLETION_UNCONFIRMED_TIMEOUT,
      });
      if (!step.confirmed) return false;
      await recordAudit(tx, {
        objectType: 'device',
        objectId: retirement.deviceId,
        action: 'device.retire.timeout',
        result: 'SUCCESS',
        actorId: 'system:retirement-timeout',
        actorRole: 'SYSTEM',
        reason: COMPLETION_UNCONFIRMED_TIMEOUT,
        beforeValue: { retirementStatus: RETIREMENT_PENDING },
        afterValue: {
          retirementStatus: RETIREMENT_CONFIRMED,
          completionMethod: COMPLETION_UNCONFIRMED_TIMEOUT,
        },
      });
      return true;
    });
    if (confirmed) completedDeviceIds.push(retirement.deviceId);
    else skipped += 1;
  }

  const iotRevocations = options.revoker
    ? await processRetirementIotRevocations(rootClient, options.revoker, {
        now: at,
        batchSize,
      })
    : { examined: 0, completed: 0, failed: 0, skipped: 0 };

  return {
    examined: candidates.length,
    completed: completedDeviceIds.length,
    skipped,
    completedDeviceIds,
    iotRevocations,
  };
}
