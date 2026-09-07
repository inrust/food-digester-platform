/** BE-ESG-01 event-time 聚合：历史归属、边界缺口与原子 upsert。 */
import type { DbClient } from '@fdp/database';

export const AGGREGATION_CALCULATION_VERSION = 'aggregator@2.0.0';
export const AGGREGATION_FORMULA = {
  hourlyRollup: 'incremental (BE-IOT-05); event-time completeness enriched by receipt-seq',
  dailyRollup: 'weighted-avg by sample count; min-of-min; max-of-max',
  completeness: 'event-time sequence epochs with first=1 and adjacent-window boundaries',
  esgDaily: 'sum weights/energy/carbon; avg report completeness; sum missing',
} as const;

export interface AggregationWorkerDeps {
  readonly client: DbClient;
  readonly calculationVersion?: string;
}
export interface AggregationWindow {
  readonly from: Date;
  readonly to: Date;
}
export interface AggregationRunResult {
  readonly hourlyEnriched: number;
  readonly dailyUpserted: number;
  readonly esgUpserted: number;
  readonly calculationVersionId: string;
}
interface ReceiptRow {
  readonly deviceId: string;
  readonly customerId: string | null;
  readonly siteId: string | null;
  readonly seq: number | null;
  readonly occurredAt: Date;
}
interface HourlyRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly siteId: string;
  readonly bucketStart: Date;
  readonly sampleCount: number;
  readonly metrics: unknown;
}
interface ReportRow {
  readonly deviceId: string;
  readonly customerId: string;
  readonly siteId: string;
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
function siteKey(siteId: string | null): string {
  return siteId ?? '__UNASSIGNED__';
}

/** 单一 sequence epoch；可显式传入相邻窗口推导出的边界。 */
export function completenessOf(seqs: readonly number[], expectedStart?: number, expectedEnd?: number) {
  if (seqs.length === 0) return { pct: null, missing: 0 };
  const start = expectedStart ?? Math.min(...seqs);
  const end = expectedEnd ?? Math.max(...seqs);
  const expected = Math.max(0, end - start + 1);
  const received = [...new Set(seqs)].filter((seq) => seq >= start && seq <= end).length;
  const missing = Math.max(0, expected - received);
  return { pct: expected === 0 ? null : round2((received / expected) * 100), missing };
}

/** event-time 顺序中的序号回退定义为新 epoch；每个设备序号流从 1 开始。 */
function completenessAcrossEpochs(rows: readonly ReceiptRow[]) {
  const ordered = rows.filter((r): r is ReceiptRow & { seq: number } => r.seq !== null);
  if (ordered.length === 0) return { pct: null, missing: 0 };
  const epochs: number[][] = [];
  for (const row of ordered) {
    const current = epochs.at(-1);
    // 乱序迟到不等于 reset；只有明确回到序号 1 才开启新 epoch。
    if (!current || (row.seq === 1 && (current.at(-1) as number) > 1)) epochs.push([row.seq]);
    else current.push(row.seq);
  }
  let expected = 0;
  let received = 0;
  for (const epoch of epochs) {
    expected += Math.max(...epoch);
    received += new Set(epoch).size;
  }
  const missing = Math.max(0, expected - received);
  return { pct: round2((received / expected) * 100), missing };
}

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
      const entry = acc.get(key) ?? { sum: 0, count: 0, min: Infinity, max: -Infinity };
      entry.sum += avg * count;
      entry.count += count;
      entry.min = Math.min(entry.min, min);
      entry.max = Math.max(entry.max, max);
      acc.set(key, entry);
    }
  }
  const out: Record<string, MetricAggregate> = {};
  for (const key of [...acc.keys()].sort()) {
    const e = acc.get(key)!;
    out[key] = { avg: e.sum / e.count, min: e.min, max: e.max, count: e.count };
  }
  return out;
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

export function createAggregationWorker(deps: AggregationWorkerDeps) {
  const version = deps.calculationVersion ?? AGGREGATION_CALCULATION_VERSION;
  const db = deps.client as unknown as Record<string, any>;
  async function ensureCalculationVersion(): Promise<string> {
    const row = await db.esgCalculationVersion.upsert({
      where: { version },
      update: {},
      create: {
        version,
        description: 'BE-ESG-01 event-time + historical dimension rollup',
        formula: AGGREGATION_FORMULA,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        status: 'ACTIVE',
      },
    });
    return row.id as string;
  }
  return {
    async recomputeWindow(window: AggregationWindow): Promise<AggregationRunResult> {
      const calculationVersionId = await ensureCalculationVersion();
      const windowReceipts = (await db.ingestionReceipt.findMany({
        where: { topicType: 'telemetry', occurredAt: { gte: window.from, lte: window.to } },
        orderBy: [{ deviceId: 'asc' }, { occurredAt: 'asc' }],
      })) as ReceiptRow[];
      const attributionKey = (r: ReceiptRow) => `${r.deviceId}|${r.customerId ?? ''}|${siteKey(r.siteId)}`;
      const hourlyGroups = groupBy(
        windowReceipts,
        (r) => `${attributionKey(r)}|${hourFloor(r.occurredAt).toISOString()}`,
      );
      let hourlyEnriched = 0;
      for (const [key, rows] of [...hourlyGroups.entries()].sort()) {
        const [deviceId, customerId, siteId, hourIso] = key.split('|') as [string, string, string, string];
        if (!customerId) continue;
        const attributed = windowReceipts.filter((r) => attributionKey(r) === `${deviceId}|${customerId}|${siteId}`);
        const firstIndex = attributed.indexOf(rows[0]!);
        const lastIndex = attributed.indexOf(rows.at(-1)!);
        const seqs = rows.map((r) => r.seq).filter((s): s is number => s !== null);
        const previous = firstIndex > 0 ? attributed[firstIndex - 1]?.seq : null;
        const next = lastIndex >= 0 ? attributed[lastIndex + 1]?.seq : null;
        const min = seqs.length ? Math.min(...seqs) : 1;
        const max = seqs.length ? Math.max(...seqs) : 0;
        const expectedStart =
          previous !== null && previous !== undefined && previous < min ? previous + 1 : firstIndex === 0 ? 1 : min;
        const expectedEnd = next !== null && next !== undefined && next > max ? next - 1 : max;
        const complete = completenessOf(seqs, expectedStart, expectedEnd);
        const updated = await db.telemetryHourly.updateMany({
          where: { deviceId, customerId, siteId, bucketStart: new Date(hourIso) },
          data: { completenessPct: complete.pct, missingRecordCount: complete.missing },
        });
        hourlyEnriched += updated.count;
      }

      const hourlyRows = (await db.telemetryHourly.findMany({
        where: { bucketStart: { gte: window.from, lte: window.to } },
        orderBy: [{ deviceId: 'asc' }, { bucketStart: 'asc' }],
      })) as HourlyRow[];
      let dailyUpserted = 0;
      const dailyGroups = groupBy(
        hourlyRows,
        (r) => `${r.deviceId}|${r.customerId}|${r.siteId}|${utcDay(r.bucketStart).toISOString()}`,
      );
      for (const [key, rows] of [...dailyGroups.entries()].sort()) {
        const [deviceId, customerId, siteId, dayIso] = key.split('|') as [string, string, string, string];
        const bucketDate = new Date(dayIso);
        const complete = completenessAcrossEpochs(
          windowReceipts.filter(
            (r) =>
              r.deviceId === deviceId &&
              r.customerId === customerId &&
              siteKey(r.siteId) === siteId &&
              utcDay(r.occurredAt).getTime() === bucketDate.getTime(),
          ),
        );
        const data = {
          sampleCount: rows.reduce((sum, r) => sum + r.sampleCount, 0),
          completenessPct: complete.pct,
          missingRecordCount: complete.missing,
          metrics: rollupMetrics(rows),
        };
        await db.telemetryDaily.upsert({
          where: { deviceId_customerId_siteId_bucketDate: { deviceId, customerId, siteId, bucketDate } },
          update: data,
          create: { deviceId, customerId, siteId, bucketDate, ...data },
        });
        dailyUpserted += 1;
      }

      const windowReports = (await db.esgReport.findMany({
        where: { periodStartTime: { gte: window.from, lte: window.to } },
        orderBy: [{ deviceId: 'asc' }, { periodStartTime: 'asc' }],
      })) as ReportRow[];
      let esgUpserted = 0;
      const esgGroups = groupBy(
        windowReports,
        (r) => `${r.deviceId}|${r.customerId}|${r.siteId}|${utcDay(r.periodStartTime).toISOString()}`,
      );
      for (const [key, rows] of [...esgGroups.entries()].sort()) {
        const [deviceId, customerId, siteId, dayIso] = key.split('|') as [string, string, string, string];
        const summaryDate = new Date(dayIso);
        const sum = (pick: (r: ReportRow) => unknown): number | null => {
          const values = rows
            .map(pick)
            .map(asNumber)
            .filter((v): v is number => v !== null);
          return values.length ? values.reduce((a, b) => a + b, 0) : null;
        };
        const values = rows.map((r) => asNumber(r.dataCompletenessPct)).filter((v): v is number => v !== null);
        const data = {
          feedingWeightKg: sum((r) => r.feedingWeightKg),
          dischargeWeightKg: sum((r) => r.dischargeWeightKg),
          reductionWeightKg: sum((r) => r.reductionWeightKg),
          powerConsumptionKwh: sum((r) => r.powerConsumptionKwh),
          carbonReductionKg: sum((r) => r.carbonReductionKg),
          dataCompletenessPct: values.length ? round2(values.reduce((a, b) => a + b, 0) / values.length) : null,
          missingRecordCount: rows.reduce((total, r) => total + (r.missingRecordCount ?? 0), 0),
          calculationVersionId,
        };
        await db.esgDailySummary.upsert({
          where: { deviceId_customerId_siteId_summaryDate: { deviceId, customerId, siteId, summaryDate } },
          update: data,
          create: { deviceId, customerId, siteId, summaryDate, ...data },
        });
        esgUpserted += 1;
      }
      return { hourlyEnriched, dailyUpserted, esgUpserted, calculationVersionId };
    },
  };
}
