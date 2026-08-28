/**
 * BE-ESG-01 小时/日聚合 Worker：确定性重算（给定相同输入必产生相同输出，upsert 幂等）。
 *
 * - telemetry_hourly：BE-IOT-05 已在 Ingestion 路径增量维护 metrics/sampleCount；
 *   本 Worker 在重算窗口内补齐 completenessPct（完整率）：
 *   完整率 = 窗口内已处理 receipt 数 / 期望数（max(seq)-min(seq)+1），缺失数 = 期望-已收（钳制 ≥0）；
 *   注：receipt 按 receivedAt 归入小时桶（receipts 表无 event time 列，近似已文档化）；
 * - telemetry_daily：当日 hourly 行的确定性 rollup（metrics 按 count 加权 avg、min/max 合并、
 *   sampleCount 求和；行按 bucketStart 排序保证求和顺序稳定）+ 当日 receipt 完整率；
 * - esg_daily_summary：当日 esg_reports rollup（吞吐/能耗/碳减排求和、完整率均值、缺失数求和）
 *   + 计算方法版本（calculationVersionId，ensure -get-or-create ACTIVE 版本行）；
 * - 乱序记录可在允许窗口内重算：迟到 receipt/report/hourly 行在下次重算同一窗口时收敛（upsert 覆盖）；
 * - 功能边界：不承担正式碳核证，不定义设备侧原始指标；Site 维度未建模（表结构仅 device/customer）。
 */
import type { DbClient } from '@fdp/database';

/** 聚合计算方法版本（交付物"计算版本"；ensure 到 esg_calculation_versions）。 */
export const AGGREGATION_CALCULATION_VERSION = 'aggregator@1.0.0';

export const AGGREGATION_FORMULA = {
  hourlyRollup: 'incremental (BE-IOT-05); completeness enriched by receipt-seq',
  dailyRollup: 'weighted-avg by sample count; min-of-min; max-of-max',
  completeness: 'received / (max(seq) - min(seq) + 1), missing clamped >= 0',
  esgDaily: 'sum weights/energy/carbon; avg report completeness; sum missing',
} as const;

export interface AggregationWorkerDeps {
  readonly client: DbClient;
  readonly calculationVersion?: string | undefined;
}

export interface AggregationWindow {
  readonly from: Date;
  readonly to: Date;
}

export interface AggregationRunResult {
  /** 补齐完整率的 hourly 行数。 */
  readonly hourlyEnriched: number;
  /** upsert 的 telemetry_daily 行数。 */
  readonly dailyUpserted: number;
  /** upsert 的 esg_daily_summary 行数。 */
  readonly esgUpserted: number;
  readonly calculationVersionId: string;
}

interface ReceiptRow {
  readonly deviceId: string;
  readonly seq: number | null;
  readonly receivedAt: Date;
}

interface HourlyRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly bucketStart: Date;
  readonly sampleCount: number;
  readonly metrics: unknown;
}

interface ReportRow {
  readonly deviceId: string;
  readonly customerId: string;
  readonly periodStartTime: Date;
  readonly feedingWeightKg: unknown;
  readonly dischargeWeightKg: unknown;
  readonly reductionWeightKg: unknown;
  readonly powerConsumptionKwh: unknown;
  readonly carbonReductionKg: unknown;
  readonly dataCompletenessPct: unknown;
  readonly missingRecordCount: number | null;
}

interface MetricAggregate {
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

/** Prisma Decimal 列返回 Decimal 对象（非 number），统一经 toNumber 归一。 */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return null;
}

function hourFloor(date: Date): Date {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 完整率：已收/期望（max-min+1）；缺失钳制 ≥0（重复键不会产生负缺失）。 */
export function completenessOf(seqs: readonly number[]): { pct: number | null; missing: number } {
  if (seqs.length === 0) return { pct: null, missing: 0 };
  const expected = Math.max(...seqs) - Math.min(...seqs) + 1;
  const received = new Set(seqs).size;
  const missing = Math.max(0, expected - received);
  return { pct: round2((received / expected) * 100), missing };
}

/** hourly metrics 按 count 加权合并（键排序 + 行排序保证确定性）。 */
export function rollupMetrics(rows: readonly HourlyRow[]): Record<string, MetricAggregate> {
  const acc = new Map<string, { sum: number; count: number; min: number; max: number }>();
  for (const row of rows) {
    const metrics = (row.metrics ?? {}) as Record<
      string,
      { avg?: unknown; min?: unknown; max?: unknown; count?: unknown }
    >;
    for (const key of Object.keys(metrics).sort()) {
      const m = metrics[key];
      const avg = asNumber(m?.avg);
      const min = asNumber(m?.min);
      const max = asNumber(m?.max);
      const count = asNumber(m?.count);
      if (avg === null || min === null || max === null || count === null) continue;
      const entry = acc.get(key) ?? { sum: 0, count: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
      entry.sum += avg * count;
      entry.count += count;
      entry.min = Math.min(entry.min, min);
      entry.max = Math.max(entry.max, max);
      acc.set(key, entry);
    }
  }
  const out: Record<string, MetricAggregate> = {};
  for (const key of [...acc.keys()].sort()) {
    const entry = acc.get(key) as { sum: number; count: number; min: number; max: number };
    out[key] = { avg: entry.sum / entry.count, min: entry.min, max: entry.max, count: entry.count };
  }
  return out;
}

export function createAggregationWorker(deps: AggregationWorkerDeps): {
  recomputeWindow(window: AggregationWindow): Promise<AggregationRunResult>;
} {
  const version = deps.calculationVersion ?? AGGREGATION_CALCULATION_VERSION;
  const receipts = (deps.client as unknown as Record<string, unknown>).ingestionReceipt as {
    findMany(args: Record<string, unknown>): Promise<ReceiptRow[]>;
  };
  const hourly = (deps.client as unknown as Record<string, unknown>).telemetryHourly as {
    findMany(args: Record<string, unknown>): Promise<HourlyRow[]>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
  const daily = (deps.client as unknown as Record<string, unknown>).telemetryDaily as {
    findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
  const reports = (deps.client as unknown as Record<string, unknown>).esgReport as {
    findMany(args: Record<string, unknown>): Promise<ReportRow[]>;
  };
  const esgDaily = (deps.client as unknown as Record<string, unknown>).esgDailySummary as {
    findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
  const versions = (deps.client as unknown as Record<string, unknown>).esgCalculationVersion as {
    findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };

  async function ensureCalculationVersion(): Promise<string> {
    const existing = await versions.findFirst({ where: { version } });
    if (existing) return existing.id;
    try {
      const created = await versions.create({
        data: {
          version,
          description: 'BE-ESG-01 小时/日聚合计算方法（receipt 序号完整率 + 加权 rollup）',
          formula: AGGREGATION_FORMULA,
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          status: 'ACTIVE',
        },
      });
      return created.id;
    } catch {
      // 并发创建败方：回读胜方行
      const winner = await versions.findFirst({ where: { version } });
      if (winner) return winner.id;
      throw new Error(`calculation version ensure failed: ${version}`);
    }
  }

  function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const row of rows) {
      const key = keyOf(row);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    return groups;
  }

  return {
    async recomputeWindow(window) {
      const calculationVersionId = await ensureCalculationVersion();

      // ---- 1) telemetry_hourly 完整率补齐（窗口内 receipt 按 receivedAt 小时分组） ----
      const windowReceipts = await receipts.findMany({
        where: { topicType: 'telemetry', receivedAt: { gte: window.from, lte: window.to } },
        orderBy: [{ deviceId: 'asc' }, { receivedAt: 'asc' }],
      });
      let hourlyEnriched = 0;
      const hourlyGroups = groupBy(windowReceipts, (r) => `${r.deviceId}|${hourFloor(r.receivedAt).toISOString()}`);
      for (const [key, rows] of [...hourlyGroups.entries()].sort()) {
        const [deviceId, hourIso] = key.split('|') as [string, string];
        const { pct } = completenessOf(rows.map((r) => r.seq).filter((s): s is number => s !== null));
        const { count } = await hourly.updateMany({
          where: { deviceId, bucketStart: new Date(hourIso) },
          data: { completenessPct: pct },
        });
        hourlyEnriched += count;
      }

      // ---- 2) telemetry_daily：当日 hourly rollup + 当日 receipt 完整率（upsert 幂等） ----
      const hourlyRows = await hourly.findMany({
        where: { bucketStart: { gte: window.from, lte: window.to } },
        orderBy: [{ deviceId: 'asc' }, { bucketStart: 'asc' }],
      });
      let dailyUpserted = 0;
      const dailyGroups = groupBy(hourlyRows, (r) => `${r.deviceId}|${utcDay(r.bucketStart).toISOString()}`);
      for (const [key, rows] of [...dailyGroups.entries()].sort()) {
        const [deviceId, dayIso] = key.split('|') as [string, string];
        const day = new Date(dayIso);
        const dayReceipts = windowReceipts.filter(
          (r) => r.deviceId === deviceId && utcDay(r.receivedAt).getTime() === day.getTime(),
        );
        const { pct } = completenessOf(dayReceipts.map((r) => r.seq).filter((s): s is number => s !== null));
        const data = {
          sampleCount: rows.reduce((sum, r) => sum + r.sampleCount, 0),
          completenessPct: pct,
          metrics: rollupMetrics(rows),
        };
        const existing = await daily.findFirst({ where: { deviceId, bucketDate: day } });
        if (existing) {
          await daily.updateMany({ where: { id: existing.id }, data });
        } else {
          await daily.create({ data: { deviceId, customerId: rows[0]?.customerId ?? '', bucketDate: day, ...data } });
        }
        dailyUpserted += 1;
      }

      // ---- 3) esg_daily_summary：当日报告 rollup + 计算方法版本（upsert 幂等） ----
      const windowReports = await reports.findMany({
        where: { periodStartTime: { gte: window.from, lte: window.to } },
        orderBy: [{ deviceId: 'asc' }, { periodStartTime: 'asc' }],
      });
      let esgUpserted = 0;
      const esgGroups = groupBy(windowReports, (r) => `${r.deviceId}|${utcDay(r.periodStartTime).toISOString()}`);
      for (const [key, rows] of [...esgGroups.entries()].sort()) {
        const [deviceId, dayIso] = key.split('|') as [string, string];
        const day = new Date(dayIso);
        const sum = (pick: (r: ReportRow) => unknown): number | null => {
          const values = rows.map((r) => asNumber(pick(r))).filter((v): v is number => v !== null);
          return values.length > 0 ? values.reduce((a, b) => a + b, 0) : null;
        };
        const completenessValues = rows
          .map((r) => asNumber(r.dataCompletenessPct))
          .filter((v): v is number => v !== null);
        const data = {
          feedingWeightKg: sum((r) => r.feedingWeightKg),
          dischargeWeightKg: sum((r) => r.dischargeWeightKg),
          reductionWeightKg: sum((r) => r.reductionWeightKg),
          powerConsumptionKwh: sum((r) => r.powerConsumptionKwh),
          carbonReductionKg: sum((r) => r.carbonReductionKg),
          dataCompletenessPct:
            completenessValues.length > 0
              ? round2(completenessValues.reduce((a, b) => a + b, 0) / completenessValues.length)
              : null,
          missingRecordCount: rows.reduce((sum2, r) => sum2 + (r.missingRecordCount ?? 0), 0),
          calculationVersionId,
        };
        const existing = await esgDaily.findFirst({ where: { deviceId, summaryDate: day } });
        if (existing) {
          await esgDaily.updateMany({ where: { id: existing.id }, data });
        } else {
          await esgDaily.create({
            data: { deviceId, customerId: rows[0]?.customerId ?? '', summaryDate: day, ...data },
          });
        }
        esgUpserted += 1;
      }

      return { hourlyEnriched, dailyUpserted, esgUpserted, calculationVersionId };
    },
  };
}
