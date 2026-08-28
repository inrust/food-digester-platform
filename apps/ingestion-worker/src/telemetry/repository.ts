/**
 * BE-IOT-05 Telemetry Repository：聚合窗口最小状态（telemetry_hourly，DB-01）增量合并。
 *
 * - 聚合窗口：整点 UTC bucket（每设备每窗口一行，unique(deviceId, bucketStart)）；
 * - 最小状态：metrics JSON 每字段 {avg, min, max, count}（键名与 Payload 一致）+ sampleCount，
 *   增量合并即可重算 avg，无需保存原始明细（原始 Telemetry 不长期写 RDS）；
 * - completenessPct 口径未定（上报频率未冻结），本任务不落该列；
 * - 已知限制：同设备同窗口的并发合并为读-改-写，极端竞争下可能丢失增量；
 *   原始 Payload 已进 S3 归档链路（outbox），可由 Replay 重建窗口（V1 接受）。
 */
import type { DbClient } from '@fdp/database';

/** CT-03 Telemetry Schema 的 13 项指标字段（键名与 Payload/聚合 JSON 一致）。 */
export const TELEMETRY_METRIC_KEYS = [
  'feedingWeightKg',
  'chamberWeightKg',
  'dischargeWeightKg',
  'humidityPct',
  'ambientTempC',
  'heatTemperatureC',
  'siloTemperatureC',
  'powerConsumptionKw',
  'o2Pct',
  'co2Ppm',
  'ch4Ppm',
  'n2oPpm',
  'currentAmp',
] as const;

export type TelemetryMetricKey = (typeof TELEMETRY_METRIC_KEYS)[number];

export interface MetricAggregate {
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

export type MetricsMap = Record<string, MetricAggregate>;

interface HourlyRow {
  readonly id: string;
  readonly sampleCount: number;
  readonly metrics: unknown;
}

interface HourlyDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<HourlyRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function hourly(client: DbClient): HourlyDelegate {
  return (client as unknown as Record<string, unknown>).telemetryHourly as HourlyDelegate;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** 从 Payload data 提取本消息出现的指标样本（仅 13 项固定键、数值类型）。 */
export function extractSamples(data: Record<string, unknown>): Partial<Record<TelemetryMetricKey, number>> {
  const samples: Partial<Record<TelemetryMetricKey, number>> = {};
  for (const key of TELEMETRY_METRIC_KEYS) {
    const value = data[key];
    if (typeof value === 'number') samples[key] = value;
  }
  return samples;
}

function mergeMetrics(existing: MetricsMap, samples: Partial<Record<TelemetryMetricKey, number>>): MetricsMap {
  const merged: Record<string, MetricAggregate> = { ...existing };
  for (const [key, value] of Object.entries(samples)) {
    if (value === undefined) continue;
    const prev = merged[key];
    if (!prev) {
      merged[key] = { avg: value, min: value, max: value, count: 1 };
    } else {
      const count = prev.count + 1;
      merged[key] = {
        avg: (prev.avg * prev.count + value) / count,
        min: Math.min(prev.min, value),
        max: Math.max(prev.max, value),
        count,
      };
    }
  }
  return merged;
}

/**
 * 增量合并一条 Telemetry 样本到整点窗口；返回合并后 sampleCount。
 * 并发首创建败方（P2002）回读胜方行后按更新路径合并一次。
 */
export async function mergeHourlyAggregate(
  client: DbClient,
  params: {
    readonly deviceId: string;
    readonly customerId: string | null;
    readonly bucketStart: Date;
    readonly samples: Partial<Record<TelemetryMetricKey, number>>;
  },
): Promise<{ readonly sampleCount: number }> {
  const existing = await hourly(client).findFirst({
    where: { deviceId: params.deviceId, bucketStart: params.bucketStart },
  });
  if (existing) {
    const metrics = mergeMetrics((existing.metrics ?? {}) as MetricsMap, params.samples);
    await hourly(client).updateMany({
      where: { id: existing.id },
      data: { sampleCount: existing.sampleCount + 1, metrics },
    });
    return { sampleCount: existing.sampleCount + 1 };
  }
  try {
    await hourly(client).create({
      data: {
        deviceId: params.deviceId,
        customerId: params.customerId,
        bucketStart: params.bucketStart,
        sampleCount: 1,
        metrics: mergeMetrics({}, params.samples),
      },
    });
    return { sampleCount: 1 };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // 并发首创建败方：胜方行已存在，按更新路径合并
    const winner = await hourly(client).findFirst({
      where: { deviceId: params.deviceId, bucketStart: params.bucketStart },
    });
    if (!winner) throw err;
    const metrics = mergeMetrics((winner.metrics ?? {}) as MetricsMap, params.samples);
    await hourly(client).updateMany({
      where: { id: winner.id },
      data: { sampleCount: winner.sampleCount + 1, metrics },
    });
    return { sampleCount: winner.sampleCount + 1 };
  }
}
