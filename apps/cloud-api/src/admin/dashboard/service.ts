/**
 * BE-DASH-01 管理后台总览聚合领域服务（框架无关，只读）。
 *
 * 指标定义（固定，分母/时间窗口如下；与 admin-dashboard-api.json DTO 注释一致）：
 * - 有效 Contract 总数：status ∉ {DRAFT, TERMINATED} 且 startAt <= generatedAt < endAt
 *   （EFFECTIVE + EXPIRING_SOON；分母为 scope 内全部 Contract）；
 * - 设备总数：scope 内 devices 行数（分母）；在线数：lastHeartbeatAt 距 generatedAt
 *   ≤ 10 分钟（暂定值，复用 BE-DEV-01 deriveConnectivity，不读取 connectivity 存储字段）；
 *   在线率 = online/total×100 保留 1 位小数，total=0 → 0（无数据返回 0 而非错误）；
 * - 授权状态分布：device_latest_state.licenseStatus → 设备数；无状态行计入 NONE 桶；
 * - 今日 ESG：esg_daily_summary 按 summaryDate = generatedAt 的 UTC 日历日 + scope 内
 *   设备求和（carbonReductionKg/powerConsumptionKwh/feedingWeightKg）；无数据为 0；
 * - 最新业务告警：status = ACTIVE，detectedTime 倒序 + id 决胜，固定 5 条（排序稳定）；
 * - 设备卡片：scope 内按 deviceId 升序固定前 10 台；四轴分离（DEC-010：lifecycle /
 *   operational / connectivity / license 不合并不派生单字段）；允许动作只返回
 *   command/allowed/denyReason——actor 无 command:send → FORBIDDEN（与 BE-CMD-01
 *   权限矩阵一致）；设备状态门经 resolveCommandGateStatus + commandDenyReason，
 *   不在查询中执行命令；
 * - Customer scope：Customer actor 强制 actor.customerId（汇总不串线）；平台角色全平台口径；
 * - 功能边界：不返回 AWS CPU、队列深度等运维指标。
 */
import { COMMAND_CATALOG } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import type { DbClient } from '@fdp/database';
import { DEFAULT_CONNECTIVITY_THRESHOLD_MS, deriveConnectivity } from '../device/repository.js';
import { commandAuthorizationDenyReason } from '../command/authorization.js';

export interface DashboardDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

/** 最新业务告警固定条数。 */
export const DASHBOARD_LATEST_ALARM_LIMIT = 5;
/** 设备卡片固定台数（scope 内 deviceId 升序前 N 台）。 */
export const DASHBOARD_DEVICE_CARD_LIMIT = 10;

// ---------- 行类型与数据访问 ----------

interface DeviceRow {
  readonly id: string;
  readonly serialNumber: string;
  readonly alias: string | null;
  readonly model: string;
  readonly lifecycleStatus: string;
  readonly firmwareVersion: string | null;
  readonly customerId: string | null;
}

interface LatestStateRow {
  readonly deviceId: string;
  readonly lastHeartbeatAt: Date | null;
  readonly operationalStatus: string | null;
  readonly licenseStatus: string | null;
  readonly firmwareVersion: string | null;
  readonly signalStrength: number | null;
  readonly networkType: string | null;
}

interface AlarmRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string | null;
  readonly code: string;
  readonly severity: string;
  readonly status: string;
  readonly detectedTime: Date;
}

interface ConsumableRow {
  readonly deviceId: string;
  readonly consumableType: string;
  readonly remainingPercent: number | null;
  readonly stale: boolean;
}

interface LicenseRow {
  readonly deviceId: string;
}

interface TableDelegate {
  findMany(args: Record<string, unknown>): Promise<never[]>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
  aggregate(args: Record<string, unknown>): Promise<Record<string, Record<string, unknown>>>;
}

function table(client: DbClient, name: string): TableDelegate {
  return (client as unknown as Record<string, unknown>)[name] as TableDelegate;
}

// ---------- DTO ----------

export interface DashboardOverview {
  readonly generatedAt: string;
  readonly contracts: { readonly effectiveTotal: number };
  readonly devices: {
    readonly total: number;
    readonly online: number;
    readonly onlineRatePct: number;
    readonly licenseDistribution: Readonly<Record<string, number>>;
  };
  readonly esgToday: {
    readonly summaryDate: string;
    readonly carbonReductionKg: number;
    readonly powerConsumptionKwh: number;
    readonly feedingWeightKg: number;
  };
  readonly latestAlarms: readonly {
    readonly alarmId: string;
    readonly deviceId: string;
    readonly customerId: string | null;
    readonly code: string;
    readonly severity: string;
    readonly status: string;
    readonly detectedTime: string;
  }[];
  readonly deviceCards: readonly DeviceCardView[];
}

export interface DeviceCardView {
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly alias: string | null;
  readonly model: string;
  readonly lifecycleStatus: string;
  readonly operationalStatus: string | null;
  readonly connectivity: 'ONLINE' | 'OFFLINE';
  readonly licenseStatus: string | null;
  readonly firmwareVersion: string | null;
  readonly signalStrength: number | null;
  readonly networkType: string | null;
  readonly consumables: readonly {
    readonly consumableType: string;
    readonly remainingPercent: number | null;
    readonly stale: boolean;
  }[];
  readonly actions: readonly {
    readonly command: string;
    readonly allowed: boolean;
    readonly denyReason: string | null;
  }[];
}

// ---------- 聚合 ----------

/** UTC 日历日（esg_daily_summary.summaryDate 口径）。 */
function utcDateOf(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

export async function getDashboardOverview(deps: DashboardDeps, actor: ActorContext): Promise<DashboardOverview> {
  const now = deps.now?.() ?? new Date();
  const client = deps.client;
  // Customer scope：Customer actor 强制自身（汇总不串线）；平台角色全平台口径
  const scopedCustomerId = actor.actorType === 'customer' ? (actor.customerId ?? '__none__') : undefined;

  const devices = (await table(client, 'device').findMany({
    where: scopedCustomerId ? { customerId: scopedCustomerId } : {},
    orderBy: { id: 'asc' },
  })) as unknown as DeviceRow[];
  const deviceIds = devices.map((d) => d.id);

  const [latestStates, effectiveContracts, esgSum, alarms] = await Promise.all([
    table(client, 'deviceLatestState').findMany({
      where: { deviceId: { in: deviceIds } },
    }) as unknown as Promise<LatestStateRow[]>,
    table(client, 'contract').count({
      where: {
        ...(scopedCustomerId ? { customerId: scopedCustomerId } : {}),
        status: { notIn: ['DRAFT', 'TERMINATED'] },
        startAt: { lte: now },
        endAt: { gt: now },
      },
    }),
    table(client, 'esgDailySummary').aggregate({
      _sum: { carbonReductionKg: true, powerConsumptionKwh: true, feedingWeightKg: true },
      where: { summaryDate: utcDateOf(now), deviceId: { in: deviceIds } },
    }),
    table(client, 'alarm').findMany({
      where: { status: 'ACTIVE', ...(scopedCustomerId ? { customerId: scopedCustomerId } : {}) },
      orderBy: [{ detectedTime: 'desc' }, { id: 'desc' }],
      take: DASHBOARD_LATEST_ALARM_LIMIT,
    }) as unknown as Promise<AlarmRow[]>,
  ]);

  const stateByDevice = new Map(latestStates.map((s) => [s.deviceId, s]));

  // 在线/授权分布（四轴分离：connectivity 由 lastHeartbeatAt 派生，license 轴独立计数）
  let online = 0;
  const licenseDistribution: Record<string, number> = {};
  for (const device of devices) {
    const state = stateByDevice.get(device.id);
    if (deriveConnectivity(state?.lastHeartbeatAt ?? null, now, DEFAULT_CONNECTIVITY_THRESHOLD_MS) === 'ONLINE') {
      online += 1;
    }
    const bucket = state?.licenseStatus ?? 'NONE';
    licenseDistribution[bucket] = (licenseDistribution[bucket] ?? 0) + 1;
  }
  const total = devices.length;

  // 设备卡片（固定前 10 台）+ 耗材投影
  const cardDevices = devices.slice(0, DASHBOARD_DEVICE_CARD_LIMIT);
  const cardDeviceIds = cardDevices.map((d) => d.id);
  const [consumables, effectiveRemoteControlLicenses] = await Promise.all([
    table(client, 'consumableProjection').findMany({
      where: { deviceId: { in: cardDeviceIds } },
    }) as unknown as Promise<ConsumableRow[]>,
    table(client, 'license').findMany({
      where: {
        deviceId: { in: cardDeviceIds },
        status: { in: ['Active', 'ExpiringSoon'] },
        validFrom: { lte: now },
        validTo: { gt: now },
        entitlements: { some: { code: 'REMOTE_CONTROL', enabled: true } },
      },
      select: { deviceId: true },
    }) as unknown as Promise<LicenseRow[]>,
  ]);
  const remotelyControllableDeviceIds = new Set(effectiveRemoteControlLicenses.map((row) => row.deviceId));
  const consumablesByDevice = new Map<string, ConsumableRow[]>();
  for (const row of consumables) {
    const list = consumablesByDevice.get(row.deviceId) ?? [];
    list.push(row);
    consumablesByDevice.set(row.deviceId, list);
  }

  const cardViews: DeviceCardView[] = cardDevices.map((device) => {
    const state = stateByDevice.get(device.id);
    const actions = COMMAND_CATALOG.map((spec) => {
      const denyReason = commandAuthorizationDenyReason({
        actor,
        deviceCustomerId: device.customerId,
        lifecycleStatus: device.lifecycleStatus,
        operationalStatus: state?.operationalStatus ?? null,
        command: spec.command,
        hasRemoteControlEntitlement: remotelyControllableDeviceIds.has(device.id),
      });
      return { command: spec.command, allowed: denyReason === null, denyReason };
    });
    return {
      deviceId: device.id,
      serialNumber: device.serialNumber,
      alias: device.alias,
      model: device.model,
      lifecycleStatus: device.lifecycleStatus,
      operationalStatus: state?.operationalStatus ?? null,
      connectivity: deriveConnectivity(state?.lastHeartbeatAt ?? null, now, DEFAULT_CONNECTIVITY_THRESHOLD_MS),
      licenseStatus: state?.licenseStatus ?? null,
      firmwareVersion: state?.firmwareVersion ?? device.firmwareVersion,
      signalStrength: state?.signalStrength ?? null,
      networkType: state?.networkType ?? null,
      consumables: (consumablesByDevice.get(device.id) ?? []).map((c) => ({
        consumableType: c.consumableType,
        remainingPercent: c.remainingPercent,
        stale: c.stale,
      })),
      actions,
    };
  });

  const summaryDate = utcDateOf(now);
  return {
    generatedAt: now.toISOString(),
    contracts: { effectiveTotal: effectiveContracts },
    devices: {
      total,
      online,
      onlineRatePct: total === 0 ? 0 : Math.round((online / total) * 1000) / 10,
      licenseDistribution,
    },
    esgToday: {
      summaryDate: summaryDate.toISOString().slice(0, 10),
      carbonReductionKg: toNumber(esgSum._sum?.carbonReductionKg),
      powerConsumptionKwh: toNumber(esgSum._sum?.powerConsumptionKwh),
      feedingWeightKg: toNumber(esgSum._sum?.feedingWeightKg),
    },
    latestAlarms: (alarms as AlarmRow[]).map((a) => ({
      alarmId: a.id,
      deviceId: a.deviceId,
      customerId: a.customerId,
      code: a.code,
      severity: a.severity,
      status: a.status,
      detectedTime: a.detectedTime.toISOString(),
    })),
    deviceCards: cardViews,
  };
}
