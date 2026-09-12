/**
 * FE-11 ESG 纯逻辑：日/周/月聚合、用户时区→UTC 转换、计算口径文案、权限门、CT-06 锚点。
 *
 * 口径纪律（任务清单 §2.5 / §13.2）：
 * - “碳排放”一律显示为“估算 CO2e（kg）”，并展示完整率与计算版本；
 * - 明确显示“非第三方核证”，不绘制无依据的碳认证结论；
 * - 周/月聚合：可加性指标（投料/出料/减量/能耗/估算CO2e）求和；气体均值与完整率
 *   取算术平均并标注“平均”；null（未补齐）不参与平均，全 null 显示“—”（DEC 不伪造）；
 * - 混合计算版本显示“多版本”。
 */
import { hasPermission } from '@fdp/auth/browser';
import type { Role } from '@fdp/auth/browser';
import type { EsgCalculationVersionView, EsgDailySummaryView, EsgReportView } from './types.js';

export type EsgPeriod = 'day' | 'week' | 'month';

export const ESG_PERIODS: readonly EsgPeriod[] = ['day', 'week', 'month'];

export const ESG_PERIOD_LABELS: Readonly<Record<EsgPeriod, string>> = {
  day: '日',
  week: '周',
  month: '月',
};

/** 核证免责声明（两页固定展示）。 */
export const ESG_DISCLAIMER = '估算值，非第三方核证';

/** 导出权限：export:create = SuperAdmin/Auditor/CustomerAdmin（AUTH-01）。 */
export function canExport(role: Role): boolean {
  return hasPermission(role, 'export:create');
}

// ---------- 时区：用户时区日历日 → UTC 查询区间（含首尾） ----------

function tzOffsetMs(timeZone: string, utcMillis: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMillis));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const hour = get('hour') === 24 ? 0 : get('hour');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - utcMillis;
}

export interface UtcRange {
  readonly from: string;
  readonly to: string;
}

/**
 * 用户时区日历日 [fromDate, toDate]（YYYY-MM-DD，含尾日）→ UTC 查询区间。
 * 非法输入返回 null（页面字段错误）。
 */
export function zonedDateRangeToUtc(fromDate: string, toDate: string, timeZone: string): UtcRange | null {
  const match = /^\d{4}-\d{2}-\d{2}$/;
  if (!match.test(fromDate) || !match.test(toDate)) return null;
  if (fromDate > toDate) return null;
  const [fy, fm, fd] = fromDate.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = toDate.split('-').map(Number) as [number, number, number];
  if (Number.isNaN(Date.UTC(fy, fm - 1, fd)) || Number.isNaN(Date.UTC(ty, tm - 1, td))) return null;
  const fromGuess = Date.UTC(fy, fm - 1, fd, 0, 0, 0);
  const fromUtc = fromGuess - tzOffsetMs(timeZone, fromGuess);
  const toGuess = Date.UTC(ty, tm - 1, td, 0, 0, 0);
  const toUtc = toGuess - tzOffsetMs(timeZone, toGuess) + 24 * 3600 * 1000 - 1;
  return { from: new Date(fromUtc).toISOString(), to: new Date(toUtc).toISOString() };
}

// ---------- 日/周/月聚合 ----------

/** ISO 8601 周键（YYYY-Www，UTC 基准）。 */
export function isoWeekKey(iso: string): string {
  const date = new Date(iso);
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function bucketKeyOf(iso: string, period: EsgPeriod): string {
  if (period === 'day') return iso.slice(0, 10);
  if (period === 'month') return iso.slice(0, 7);
  return isoWeekKey(iso);
}

export interface AggregatedSummaryRow {
  readonly bucket: string;
  readonly feedingWeightKg: number | null;
  readonly dischargeWeightKg: number | null;
  readonly reductionWeightKg: number | null;
  readonly powerConsumptionKwh: number | null;
  readonly carbonReductionKg: number | null;
  /** 完整率算术平均（全 null → null 显示“—”）。 */
  readonly avgCompletenessPct: number | null;
  readonly missingRecordCount: number | null;
  /** 去重计算版本 ID；多个 → 页面显示“多版本”。 */
  readonly versionIds: readonly string[];
}

function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

function avgNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length;
}

/** 日汇总按日/周/月聚合（加法指标求和；完整率算术平均；版本去重）。 */
export function aggregateDailySummaries(
  rows: readonly EsgDailySummaryView[],
  period: EsgPeriod,
): readonly AggregatedSummaryRow[] {
  const buckets = new Map<string, EsgDailySummaryView[]>();
  for (const row of rows) {
    const key = bucketKeyOf(row.summaryDate, period);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([bucket, group]) => ({
      bucket,
      feedingWeightKg: sumNullable(group.map((r) => r.feedingWeightKg)),
      dischargeWeightKg: sumNullable(group.map((r) => r.dischargeWeightKg)),
      reductionWeightKg: sumNullable(group.map((r) => r.reductionWeightKg)),
      powerConsumptionKwh: sumNullable(group.map((r) => r.powerConsumptionKwh)),
      carbonReductionKg: sumNullable(group.map((r) => r.carbonReductionKg)),
      avgCompletenessPct: avgNullable(group.map((r) => r.dataCompletenessPct)),
      missingRecordCount: sumNullable(group.map((r) => r.missingRecordCount)),
      versionIds: [...new Set(group.map((r) => r.calculationVersionId).filter((v): v is string => v !== null))],
    }));
}

export interface AggregatedDeviceReportRow {
  readonly deviceId: string;
  readonly bucket: string;
  readonly feedingWeightKg: number | null;
  readonly dischargeWeightKg: number | null;
  readonly reductionWeightKg: number | null;
  readonly powerConsumptionKwh: number | null;
  /** 气体均值算术平均（标注“平均”）。 */
  readonly avgO2Pct: number | null;
  readonly avgCo2Ppm: number | null;
  readonly avgCh4Ppm: number | null;
  readonly avgN2oPpm: number | null;
  readonly carbonReductionKg: number | null;
  readonly avgCompletenessPct: number | null;
  readonly versionIds: readonly string[];
}

/** 设备 Report 按设备 × 日/周/月聚合。 */
export function aggregateDeviceReports(
  rows: readonly EsgReportView[],
  period: EsgPeriod,
): readonly AggregatedDeviceReportRow[] {
  const buckets = new Map<string, EsgReportView[]>();
  for (const row of rows) {
    const key = `${row.deviceId}|${bucketKeyOf(row.periodStartTime, period)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, group]) => {
      const [deviceId = '', bucket = ''] = key.split('|');
      return {
        deviceId,
        bucket,
        feedingWeightKg: sumNullable(group.map((r) => r.feedingWeightKg)),
        dischargeWeightKg: sumNullable(group.map((r) => r.dischargeWeightKg)),
        reductionWeightKg: sumNullable(group.map((r) => r.reductionWeightKg)),
        powerConsumptionKwh: sumNullable(group.map((r) => r.powerConsumptionKwh)),
        avgO2Pct: avgNullable(group.map((r) => r.avgO2Pct)),
        avgCo2Ppm: avgNullable(group.map((r) => r.avgCo2Ppm)),
        avgCh4Ppm: avgNullable(group.map((r) => r.avgCh4Ppm)),
        avgN2oPpm: avgNullable(group.map((r) => r.avgN2oPpm)),
        carbonReductionKg: sumNullable(group.map((r) => r.carbonReductionKg)),
        avgCompletenessPct: avgNullable(group.map((r) => r.dataCompletenessPct)),
        versionIds: [...new Set(group.map((r) => r.calculationVersionId).filter((v): v is string => v !== null))],
      };
    });
}

// ---------- 展示格式化 ----------

export function formatKg(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)} kg`;
}

export function formatKwh(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)} kWh`;
}

export function formatPct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

export function formatPpm(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(0)} ppm`;
}

/** 计算版本显示：versionId → 版本号；混合 → “多版本”；未知 → 原 ID。 */
export function calculationVersionText(
  versionIds: readonly string[],
  versions: readonly EsgCalculationVersionView[] | null,
): string {
  if (versionIds.length === 0) return '—';
  if (versionIds.length > 1) return '多版本';
  const id = versionIds[0];
  const found = versions?.find((v) => v.versionId === id);
  return found !== undefined ? found.version : (id ?? '—');
}

// ---------- CT-06 锚点（esg-overview / esg-device 全量 Adopt/Adapt 元素） ----------

export const ESG_OVERVIEW_COVERAGE: Readonly<Record<string, string>> = {
  'esg-overview.toggle.period': 'esg-period-toggle',
  'esg-overview.button.exportCsv': 'esg-export-csv',
  'esg-overview.column.date': 'esg-col-date',
  'esg-overview.column.carbon': 'esg-col-carbon',
  'esg-overview.column.throughput': 'esg-col-throughput',
  'esg-overview.column.energy': 'esg-col-energy',
};

export const ESG_DEVICE_COVERAGE: Readonly<Record<string, string>> = {
  'esg-device.filter.region': 'scope-region',
  'esg-device.filter.subregion': 'scope-subregion',
  'esg-device.filter.device': 'scope-device',
  'esg-device.button.apply': 'esg-device-apply',
  'esg-device.toggle.period': 'esg-device-period-toggle',
  'esg-device.button.exportCsv': 'esg-device-export-csv',
  'esg-device.field.metrics': 'esg-device-metrics',
};
