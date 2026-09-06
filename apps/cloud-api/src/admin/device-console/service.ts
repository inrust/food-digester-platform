/**
 * BE-DEV-05 设备控制台组合查询领域服务（框架无关，只读）。
 *
 * 数据块事实源（原型设备查看页字段均可追溯）：
 * - device：devices 台账 + 四轴分离（DEC-010：lifecycle/operational/connectivity/license
 *   分字段返回，不派生 enabled 单字段）；connectivity 由 lastHeartbeatAt ≤ 10 分钟派生
 *   （暂定值，复用 BE-DEV-01 deriveConnectivity，不写回）；固件最近上报优先、回退台账；
 * - components：device_latest_state.sensor_status 五键（overall/temperature/humidity/
 *   weight/gas，未上报为 null）；
 * - metrics：telemetry_hourly 最新整点桶 metrics（avg/min/max/count；乱序遥测不倒退
 *   最新值——桶聚合为增量合并，见 BE-IOT-05）；单位固定映射（kg/%/°C/kW/ppm/A）；
 * - network：device_latest_state 信号强度/网络类型/网络状态；
 * - consumables：consumable_projections（remainingPercent null=未知，DEC-008）；
 * - recentAlarms：alarms 按 detectedTime 倒序 + id 决胜固定 5 条；
 * - contract：contract_devices ACTIVE 关联 → contracts 摘要（无关联为 null）；
 * - esgLast7Days：esg_daily_summary 按 generatedAt 的 UTC 日历日向前 7 个固定日槽
 *   （升序；无聚合行日槽指标为 null——部分缺失返回明确空值）；
 * - latestMedia：media_objects 按 captureTime 倒序取最新非 DELETED 一条（DEC-009：
 *   仅最新一张，非实时流）；无数据稳定返回 null，不阻塞 P1 核心查询。
 *
 * 通用规则：
 * - 心跳类数据块 observedAt = lastHeartbeatAt，stale = 距 generatedAt 超 10 分钟（暂定值）；
 *   遥测块 observedAt = 桶起点，stale = 桶早于 generatedAt 2 小时以上；
 * - 局部数据缺失不使整个响应失败：无 latestState/遥测/耗材/合约/Media 时对应块
 *   返回明确空值（null 字段/空数组）+ stale=true；
 * - Customer scope：Customer actor 仅自身设备（跨 Customer → 404 不泄露存在性）；
 * - 功能边界：不提供实时视频流（DEC-009），不透传 MQTT 原始消息。
 */
import type { DbClient } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { DEFAULT_CONNECTIVITY_THRESHOLD_MS, deriveConnectivity } from '../device/repository.js';
import { consoleNotFound } from './errors.js';

export interface DeviceConsoleDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

/** 遥测块 stale 阈值：最新整点桶早于 generatedAt 超过 2 小时（暂定值）。 */
export const TELEMETRY_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
/** 最近告警固定条数。 */
export const CONSOLE_RECENT_ALARM_LIMIT = 5;

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
  readonly networkStatus: string | null;
  readonly sensorStatus: unknown;
}

interface TelemetryHourlyRow {
  readonly bucketStart: Date;
  readonly metrics: unknown;
}

interface ConsumableRow {
  readonly consumableType: string;
  readonly remainingPercent: number | null;
  readonly observedAt: Date | null;
  readonly stale: boolean;
}

interface AlarmRow {
  readonly id: string;
  readonly code: string;
  readonly severity: string;
  readonly status: string;
  readonly detectedTime: Date;
}

interface ContractAssocRow {
  readonly contract: {
    readonly id: string;
    readonly contractNumber: string;
    readonly name: string;
    readonly status: string;
    readonly endAt: Date;
  } | null;
}

interface EsgDailyRow {
  readonly summaryDate: Date;
  readonly carbonReductionKg: unknown;
  readonly powerConsumptionKwh: unknown;
  readonly feedingWeightKg: unknown;
}

interface MediaRow {
  readonly id: string;
  readonly mediaType: string;
  readonly captureTime: Date;
}

interface TableDelegate {
  findFirst(args: Record<string, unknown>): Promise<unknown>;
  findMany(args: Record<string, unknown>): Promise<never[]>;
}

function table(client: DbClient, name: string): TableDelegate {
  return (client as unknown as Record<string, unknown>)[name] as TableDelegate;
}

// ---------- DTO ----------

export interface MetricValueView {
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly unit: string;
}

export interface DeviceConsoleView {
  readonly generatedAt: string;
  readonly device: {
    readonly deviceId: string;
    readonly serialNumber: string;
    readonly alias: string | null;
    readonly model: string;
    readonly lifecycleStatus: string;
    readonly operationalStatus: string | null;
    readonly connectivity: 'ONLINE' | 'OFFLINE';
    readonly licenseStatus: string | null;
    readonly firmwareVersion: string | null;
  };
  readonly components: {
    readonly observedAt: string | null;
    readonly stale: boolean;
    readonly status: {
      readonly overall: string | null;
      readonly temperature: string | null;
      readonly humidity: string | null;
      readonly weight: string | null;
      readonly gas: string | null;
    };
  };
  readonly metrics: {
    readonly observedAt: string | null;
    readonly stale: boolean;
    readonly metrics: Readonly<Record<string, MetricValueView | null>>;
  };
  readonly network: {
    readonly observedAt: string | null;
    readonly stale: boolean;
    readonly signalStrength: number | null;
    readonly networkType: string | null;
    readonly networkStatus: string | null;
  };
  readonly consumables: readonly {
    readonly consumableType: string;
    readonly remainingPercent: number | null;
    readonly stale: boolean;
    readonly observedAt: string | null;
  }[];
  readonly recentAlarms: readonly {
    readonly alarmId: string;
    readonly code: string;
    readonly severity: string;
    readonly status: string;
    readonly detectedTime: string;
  }[];
  readonly contract: {
    readonly contractId: string;
    readonly contractNumber: string;
    readonly name: string;
    readonly status: string;
    readonly endAt: string;
  } | null;
  readonly esgLast7Days: readonly {
    readonly summaryDate: string;
    readonly carbonReductionKg: number | null;
    readonly powerConsumptionKwh: number | null;
    readonly feedingWeightKg: number | null;
  }[];
  readonly latestMedia: {
    readonly mediaId: string;
    readonly mediaType: string;
    readonly captureTime: string;
  } | null;
}

// ---------- 指标单位固定映射 ----------

const METRIC_UNITS: Readonly<Record<string, string>> = {
  feedingWeightKg: 'kg',
  chamberWeightKg: 'kg',
  dischargeWeightKg: 'kg',
  humidityPct: '%',
  ambientTempC: '°C',
  heatTemperatureC: '°C',
  siloTemperatureC: '°C',
  powerConsumptionKw: 'kW',
  o2Pct: '%',
  co2Ppm: 'ppm',
  ch4Ppm: 'ppm',
  n2oPpm: 'ppm',
  currentAmp: 'A',
};

const SENSOR_KEYS = ['overall', 'temperature', 'humidity', 'weight', 'gas'] as const;

// ---------- 工具 ----------

function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return null;
}

function utcDateOnly(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
}

/** 加载设备并强制租户隔离（跨 Customer → 404 不泄露存在性）。 */
export async function loadScopedDevice(
  deps: DeviceConsoleDeps,
  actor: ActorContext,
  deviceId: string,
): Promise<DeviceRow> {
  const device = (await table(deps.client, 'device').findFirst({ where: { id: deviceId } })) as DeviceRow | null;
  if (!device) throw consoleNotFound();
  if (actor.actorType === 'customer' && device.customerId !== actor.customerId) throw consoleNotFound();
  return device;
}

// ---------- 组合查询 ----------

export async function getDeviceConsole(
  deps: DeviceConsoleDeps,
  actor: ActorContext,
  deviceId: string,
): Promise<DeviceConsoleView> {
  const device = await loadScopedDevice(deps, actor, deviceId);
  const now = deps.now?.() ?? new Date();
  const client = deps.client;

  const todayUtc = utcDateOnly(now);
  const sevenDaysAgoUtc = new Date(todayUtc.getTime() - 6 * 24 * 60 * 60 * 1000);

  const [state, telemetry, consumableRows, alarmRows, contractAssoc, esgRows, mediaRow] = await Promise.all([
    table(client, 'deviceLatestState').findFirst({ where: { deviceId } }) as unknown as Promise<LatestStateRow | null>,
    table(client, 'telemetryHourly').findFirst({
      where: { deviceId },
      orderBy: { bucketStart: 'desc' },
    }) as unknown as Promise<TelemetryHourlyRow | null>,
    table(client, 'consumableProjection').findMany({ where: { deviceId } }) as unknown as Promise<ConsumableRow[]>,
    table(client, 'alarm').findMany({
      where: { deviceId },
      orderBy: [{ detectedTime: 'desc' }, { id: 'desc' }],
      take: CONSOLE_RECENT_ALARM_LIMIT,
    }) as unknown as Promise<AlarmRow[]>,
    table(client, 'contractDevice').findFirst({
      where: { deviceId, status: 'ACTIVE' },
      include: { contract: { select: { id: true, contractNumber: true, name: true, status: true, endAt: true } } },
    }) as unknown as Promise<ContractAssocRow | null>,
    table(client, 'esgDailySummary').findMany({
      where: { deviceId, summaryDate: { gte: sevenDaysAgoUtc, lte: todayUtc } },
      orderBy: { summaryDate: 'asc' },
    }) as unknown as Promise<EsgDailyRow[]>,
    table(client, 'mediaObject').findFirst({
      where: { deviceId, status: { not: 'DELETED' } },
      orderBy: { captureTime: 'desc' },
    }) as unknown as Promise<MediaRow | null>,
  ]);

  // 心跳类块：observedAt = lastHeartbeatAt；stale = 超连接阈值（暂定值）
  const lastHeartbeatAt = state?.lastHeartbeatAt ?? null;
  const heartbeatStale = deriveConnectivity(lastHeartbeatAt, now, DEFAULT_CONNECTIVITY_THRESHOLD_MS) === 'OFFLINE';
  const heartbeatObservedAt = lastHeartbeatAt?.toISOString() ?? null;

  const sensorRaw = (state?.sensorStatus ?? null) as Record<string, unknown> | null;
  const sensorStatus = Object.fromEntries(
    SENSOR_KEYS.map((key) => {
      const value = sensorRaw?.[key];
      return [key, typeof value === 'string' ? value : null];
    }),
  ) as DeviceConsoleView['components']['status'];

  // 遥测块：最新整点桶（avg/min/max + 固定单位；未上报指标为 null）
  const metricRaw = (telemetry?.metrics ?? {}) as Record<string, { avg?: unknown; min?: unknown; max?: unknown }>;
  const metrics = Object.fromEntries(
    Object.entries(METRIC_UNITS).map(([key, unit]) => {
      const entry = metricRaw[key];
      const avg = decimalToNumber(entry?.avg);
      const min = decimalToNumber(entry?.min);
      const max = decimalToNumber(entry?.max);
      return [key, avg === null || min === null || max === null ? null : { avg, min, max, unit }];
    }),
  );
  const metricsStale = telemetry === null || now.getTime() - telemetry.bucketStart.getTime() > TELEMETRY_STALE_AFTER_MS;

  // 近 7 日 ESG 固定日槽（升序；无聚合行 → 指标 null）
  const esgByDate = new Map(esgRows.map((row) => [row.summaryDate.toISOString().slice(0, 10), row]));
  const esgLast7Days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(sevenDaysAgoUtc.getTime() + i * 24 * 60 * 60 * 1000);
    const key = day.toISOString().slice(0, 10);
    const row = esgByDate.get(key);
    return {
      summaryDate: key,
      carbonReductionKg: decimalToNumber(row?.carbonReductionKg),
      powerConsumptionKwh: decimalToNumber(row?.powerConsumptionKwh),
      feedingWeightKg: decimalToNumber(row?.feedingWeightKg),
    };
  });

  return {
    generatedAt: now.toISOString(),
    device: {
      deviceId: device.id,
      serialNumber: device.serialNumber,
      alias: device.alias,
      model: device.model,
      lifecycleStatus: device.lifecycleStatus,
      operationalStatus: state?.operationalStatus ?? null,
      connectivity: deriveConnectivity(lastHeartbeatAt, now, DEFAULT_CONNECTIVITY_THRESHOLD_MS),
      licenseStatus: state?.licenseStatus ?? null,
      firmwareVersion: state?.firmwareVersion ?? device.firmwareVersion,
    },
    components: { observedAt: heartbeatObservedAt, stale: heartbeatStale, status: sensorStatus },
    metrics: {
      observedAt: telemetry?.bucketStart.toISOString() ?? null,
      stale: metricsStale,
      metrics,
    },
    network: {
      observedAt: heartbeatObservedAt,
      stale: heartbeatStale,
      signalStrength: state?.signalStrength ?? null,
      networkType: state?.networkType ?? null,
      networkStatus: state?.networkStatus ?? null,
    },
    consumables: consumableRows.map((row) => ({
      consumableType: row.consumableType,
      remainingPercent: row.remainingPercent,
      stale: row.stale,
      observedAt: row.observedAt?.toISOString() ?? null,
    })),
    recentAlarms: alarmRows.map((row) => ({
      alarmId: row.id,
      code: row.code,
      severity: row.severity,
      status: row.status,
      detectedTime: row.detectedTime.toISOString(),
    })),
    contract: contractAssoc?.contract
      ? {
          contractId: contractAssoc.contract.id,
          contractNumber: contractAssoc.contract.contractNumber,
          name: contractAssoc.contract.name,
          status: contractAssoc.contract.status,
          endAt: contractAssoc.contract.endAt.toISOString(),
        }
      : null,
    esgLast7Days,
    latestMedia: mediaRow
      ? { mediaId: mediaRow.id, mediaType: mediaRow.mediaType, captureTime: mediaRow.captureTime.toISOString() }
      : null,
  };
}
