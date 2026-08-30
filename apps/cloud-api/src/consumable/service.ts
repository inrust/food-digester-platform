/**
 * BE-CNS-01 耗材状态投影与查询 Service（框架无关）。
 *
 * 事实源与规则：
 * - DEC-008：类型封闭集合（CARBON_FILTER/BIO_ADDITIVE）；仅保存设备上报值（原始名经领域字典映射，
 *   未知失败关闭）；云端不推算百分比；未上报为 null（DTO 显示 unknown，绝不默认 50%）；
 * - 每设备每耗材仅最新投影：乱序倒退防护走领域 decideProjectionUpdate（旧消息不覆盖、
 *   同消息 replay 幂等），并发由 observedAt 条件更新兜底；
 * - stale 读取时点派生（observedAt 超阈值/未上报 → stale），不回写；
 * - 联系人授权摘要（Site 联系方式）：仅 PlatformSuperAdmin/PlatformOperator/CustomerAdmin 可见，
 *   Auditor/CustomerViewer 遮蔽为 null；Customer 角色租户隔离（仅本 Customer 设备）。
 */
import type { DbClient } from '@fdp/database';
import {
  CONSUMABLE_TYPES,
  assertRemainingPercent,
  decideProjectionUpdate,
  isConsumableStale,
  mapConsumableRawName,
} from '@fdp/domain';
import type { ConsumableType } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import { DEFAULT_CONNECTIVITY_THRESHOLD_MS, deriveConnectivity } from '../admin/device/repository.js';
import { consumableNotFound, consumableValidationFailed } from './errors.js';

export interface ConsumableDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

// ---------- 投影写路径（设备上报落库；供采集链路调用，见 BE-IOT-05 边界） ----------

export interface ConsumableReportInput {
  readonly deviceId: string;
  /** 设备上报原始名称（经 DEC-008 字典映射；未知失败关闭）。 */
  readonly rawName: string;
  /** 设备上报剩余百分比（0~100 整数）；未上报维度为 null。 */
  readonly remainingPercent: number | null;
  readonly sourceMessageId: string;
  readonly observedAt: Date;
}

export interface ConsumableReportResult {
  readonly applied: boolean;
  /** 同消息同时间幂等回放（无写入）。 */
  readonly replayed: boolean;
  readonly deviceId: string;
  readonly consumableType: ConsumableType;
}

interface ProjectionRow {
  readonly deviceId: string;
  readonly consumableType: string;
  readonly remainingPercent: number | null;
  readonly sourceMessageId: string | null;
  readonly observedAt: Date | null;
  readonly stale: boolean;
  readonly customerId: string;
}

interface ProjectionDelegate {
  findFirst(args: Record<string, unknown>): Promise<ProjectionRow | null>;
  findMany(args: Record<string, unknown>): Promise<ProjectionRow[]>;
  create(args: { data: Record<string, unknown> }): Promise<ProjectionRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function projections(client: DbClient): ProjectionDelegate {
  return (client as unknown as Record<string, unknown>).consumableProjection as ProjectionDelegate;
}

/**
 * 保存设备上报的耗材投影：字典映射 + 百分比校验 + 乱序防护。
 * 设备不存在 → 404；未知耗材名 → ConsumableError(UNKNOWN_CONSUMABLE_TYPE)，不落库。
 */
export async function recordConsumableReport(
  deps: ConsumableDeps,
  input: ConsumableReportInput,
): Promise<ConsumableReportResult> {
  const consumableType = mapConsumableRawName(input.rawName);
  assertRemainingPercent(input.remainingPercent);
  const device = await (
    (deps.client as unknown as Record<string, unknown>).device as {
      findFirst(args: Record<string, unknown>): Promise<{ id: string; customerId: string | null } | null>;
    }
  ).findFirst({ where: { id: input.deviceId }, select: { id: true, customerId: true } });
  if (!device) throw consumableNotFound();

  const table = projections(deps.client);
  const data = {
    customerId: device.customerId,
    remainingPercent: input.remainingPercent,
    sourceMessageId: input.sourceMessageId,
    observedAt: input.observedAt,
    stale: false,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await table.findFirst({
      where: { deviceId: input.deviceId, consumableType },
    });
    const decision = decideProjectionUpdate(existing, {
      observedAt: input.observedAt,
      sourceMessageId: input.sourceMessageId,
    });
    if (decision !== 'apply') {
      return { applied: false, replayed: decision === 'replay', deviceId: input.deviceId, consumableType };
    }
    if (existing === null) {
      try {
        await table.create({ data: { deviceId: input.deviceId, consumableType, ...data } });
        return { applied: true, replayed: false, deviceId: input.deviceId, consumableType };
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') continue; // 并发建行 → 重读分类
        throw err;
      }
    }
    // 并发兜底：仅当既有 observedAt 更旧时落库（防乱序竞态）
    const { count } = await table.updateMany({
      where: {
        deviceId: input.deviceId,
        consumableType,
        OR: [{ observedAt: null }, { observedAt: { lt: input.observedAt } }],
      },
      data,
    });
    if (count === 1) {
      return { applied: true, replayed: false, deviceId: input.deviceId, consumableType };
    }
    // 并发下已有更新者 → 重读分类
  }
  const final = await table.findFirst({ where: { deviceId: input.deviceId, consumableType } });
  const decision = decideProjectionUpdate(final, {
    observedAt: input.observedAt,
    sourceMessageId: input.sourceMessageId,
  });
  return { applied: false, replayed: decision === 'replay', deviceId: input.deviceId, consumableType };
}

// ---------- 查询路径（管理端） ----------

export interface ConsumableValueView {
  /** 设备上报原始百分比；未上报为 null（unknown，绝不默认 50%）。 */
  readonly remainingPercent: number | null;
  /** 展示值：'<n>%' 或 'unknown'。 */
  readonly remainingDisplay: string;
  readonly stale: boolean;
  readonly observedAt: string | null;
  readonly sourceMessageId: string | null;
}

export interface ConsumableContactSummary {
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
}

export interface ConsumableStatusView {
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly alias: string | null;
  readonly lifecycleStatus: string;
  readonly site: {
    readonly siteId: string;
    readonly name: string;
    readonly region: string | null;
    readonly subregion: string | null;
  } | null;
  readonly connectivity: 'ONLINE' | 'OFFLINE';
  /** 两种耗材列恒在；未上报为 null。 */
  readonly consumables: Readonly<Record<ConsumableType, ConsumableValueView | null>>;
  /** 设备联系人授权摘要（未授权角色为 null）。 */
  readonly contact: ConsumableContactSummary | null;
}

export interface ListConsumablesFilter {
  readonly region?: string | undefined;
  readonly subregion?: string | undefined;
  readonly siteId?: string | undefined;
  readonly connectivity?: string | undefined;
  /** 设备 ID/序列号/别名关键字。 */
  readonly keyword?: string | undefined;
  /** 阈值筛选：指定耗材（缺省任一已上报耗材）remainingPercent 低于该值。 */
  readonly maxRemainingPercent?: number | undefined;
  readonly consumableType?: string | undefined;
  readonly customerId?: string | undefined;
}

interface DeviceWithRelations {
  readonly id: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly alias: string | null;
  readonly lifecycleStatus: string;
  readonly customerId: string | null;
  readonly siteId: string | null;
  readonly site: {
    readonly id: string;
    readonly name: string;
    readonly region: string | null;
    readonly subregion: string | null;
    readonly contactName: string | null;
    readonly contactPhone: string | null;
    readonly contactEmail: string | null;
  } | null;
  readonly latestState: { readonly lastHeartbeatAt: Date | null } | null;
}

/** 联系人授权角色：SuperAdmin/Operator（平台运营）与 CustomerAdmin（本客户管理）。 */
function canViewContact(actor: ActorContext): boolean {
  return ['PlatformSuperAdmin', 'PlatformOperator', 'CustomerAdmin'].some((r) => actor.roles.includes(r as never));
}

function toValueView(row: ProjectionRow | undefined, at: Date): ConsumableValueView | null {
  if (!row) return null;
  return {
    remainingPercent: row.remainingPercent,
    remainingDisplay: row.remainingPercent === null ? 'unknown' : `${row.remainingPercent}%`,
    stale: isConsumableStale(row.observedAt, at),
    observedAt: row.observedAt?.toISOString() ?? null,
    sourceMessageId: row.sourceMessageId,
  };
}

function toView(
  row: DeviceWithRelations,
  projectionRows: readonly ProjectionRow[],
  at: Date,
  actor: ActorContext,
): ConsumableStatusView {
  const byType = new Map(projectionRows.map((p) => [p.consumableType as ConsumableType, p]));
  return {
    deviceId: row.id,
    serialNumber: row.serialNumber,
    model: row.model,
    alias: row.alias,
    lifecycleStatus: row.lifecycleStatus,
    site: row.site
      ? { siteId: row.site.id, name: row.site.name, region: row.site.region, subregion: row.site.subregion }
      : null,
    connectivity: deriveConnectivity(row.latestState?.lastHeartbeatAt ?? null, at, DEFAULT_CONNECTIVITY_THRESHOLD_MS),
    consumables: {
      CARBON_FILTER: toValueView(byType.get('CARBON_FILTER'), at),
      BIO_ADDITIVE: toValueView(byType.get('BIO_ADDITIVE'), at),
    },
    contact:
      canViewContact(actor) && row.site
        ? { name: row.site.contactName, phone: row.site.contactPhone, email: row.site.contactEmail }
        : null,
  };
}

/**
 * 耗材状态查询（device:read）：Region/Subregion/Site、连接状态、关键字、耗材阈值筛选（AND 组合）。
 * Customer 角色租户隔离（仅本 Customer）。阈值作用于指定耗材或任一已上报耗材。
 */
export async function listConsumableStatus(
  deps: ConsumableDeps,
  actor: ActorContext,
  filter: ListConsumablesFilter = {},
): Promise<ConsumableStatusView[]> {
  const at = deps.now?.() ?? new Date();
  if (filter.connectivity !== undefined && !['ONLINE', 'OFFLINE'].includes(filter.connectivity)) {
    throw consumableValidationFailed('connectivity must be ONLINE or OFFLINE');
  }
  if (filter.consumableType !== undefined && !(CONSUMABLE_TYPES as readonly string[]).includes(filter.consumableType)) {
    throw consumableValidationFailed('consumableType must be one of CARBON_FILTER, BIO_ADDITIVE');
  }
  if (
    filter.maxRemainingPercent !== undefined &&
    (!Number.isInteger(filter.maxRemainingPercent) ||
      filter.maxRemainingPercent < 0 ||
      filter.maxRemainingPercent > 100)
  ) {
    throw consumableValidationFailed('maxRemainingPercent must be an integer between 0 and 100');
  }

  // Customer 角色租户隔离：强制本 Customer（忽略越权 customerId 参数）
  const scopedCustomerId = actor.actorType === 'customer' ? (actor.customerId ?? '__none__') : filter.customerId;

  const deviceDelegate = (deps.client as unknown as Record<string, unknown>).device as {
    findMany(args: Record<string, unknown>): Promise<DeviceWithRelations[]>;
  };
  const rows = await deviceDelegate.findMany({
    where: {
      lifecycleStatus: { not: 'Retired' },
      ...(scopedCustomerId !== undefined ? { customerId: scopedCustomerId } : {}),
      ...(filter.siteId !== undefined ? { siteId: filter.siteId } : {}),
      ...(filter.region !== undefined ? { site: { region: filter.region } } : {}),
      ...(filter.subregion !== undefined ? { site: { subregion: filter.subregion } } : {}),
      ...(filter.keyword !== undefined && filter.keyword.trim() !== ''
        ? {
            OR: [
              { id: { contains: filter.keyword.trim() } },
              { serialNumber: { contains: filter.keyword.trim() } },
              { alias: { contains: filter.keyword.trim() } },
            ],
          }
        : {}),
    },
    include: {
      site: {
        select: {
          id: true,
          name: true,
          region: true,
          subregion: true,
          contactName: true,
          contactPhone: true,
          contactEmail: true,
        },
      },
      latestState: { select: { lastHeartbeatAt: true } },
    },
    orderBy: { id: 'asc' },
    take: 200,
  });

  // consumable_projections 与 devices 无 Prisma 关系（独立表），单独查询后按设备归并
  const projectionRows = rows.length
    ? await projections(deps.client).findMany({ where: { deviceId: { in: rows.map((r) => r.id) } } })
    : [];
  const projectionsByDevice = new Map<string, ProjectionRow[]>();
  for (const p of projectionRows) {
    const list = projectionsByDevice.get(p.deviceId) ?? [];
    list.push(p);
    projectionsByDevice.set(p.deviceId, list);
  }

  return rows
    .map((row) => toView(row, projectionsByDevice.get(row.id) ?? [], at, actor))
    .filter((view) => {
      if (filter.connectivity !== undefined && view.connectivity !== filter.connectivity) return false;
      if (filter.maxRemainingPercent !== undefined) {
        const types =
          filter.consumableType !== undefined ? [filter.consumableType as ConsumableType] : CONSUMABLE_TYPES;
        return types.some((type) => {
          const value = view.consumables[type];
          return (
            value !== null &&
            value.remainingPercent !== null &&
            value.remainingPercent < (filter.maxRemainingPercent as number)
          );
        });
      }
      return true;
    });
}
