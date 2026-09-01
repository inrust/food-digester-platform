/**
 * BE-ESG-02 ESG 查询 Service（框架无关，只读 RDS 聚合表）。
 *
 * 事实源与规则：
 * - 数据源为 BE-ESG-01 聚合结果：telemetry_hourly / telemetry_daily / esg_reports /
 *   esg_daily_summary / esg_calculation_versions；原始数据审计查询与 RDS 聚合查询分离——
 *   本模块只查 RDS 聚合表，原始报文归档查询属 BE-ARC 通道（不在此混入）；
 * - 筛选：customerId（平台角色）/siteId（经设备归属解析）/deviceId/日期范围（各表时间列：
 *   hourly=bucketStart、daily=bucketDate、reports=periodStartTime、dailySummary=summaryDate）；
 * - 租户隔离：Customer 角色强制所属 Customer scope（actor.customerId 覆盖请求参数）；
 * - 分页：键集游标（id ASC，DB-02）；导出路径复用同一 where 构建（行数一致由同源保证）；
 * - 功能边界：不提供第三方核证结论（聚合值原样返回，不做核证解释）。
 */
import type { DbClient } from '@fdp/database';
import { decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
import type { Page } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { decimalToNumber } from './csv.js';
import { esgValidationFailed } from './errors.js';

export interface EsgDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

// ---------- 筛选 ----------

export interface EsgFilter {
  readonly customerId?: string | undefined;
  readonly siteId?: string | undefined;
  readonly deviceId?: string | undefined;
  /** 日期范围（ISO；各数据集映射到各自时间列，含边界）。 */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly reportType?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

export const ESG_REPORT_TYPES = ['CYCLE', 'HOURLY', 'DAILY'] as const;

/** Customer 角色强制所属 Customer scope；平台角色可按 customerId 筛选。 */
function scopedCustomerId(actor: ActorContext, requested?: string): string | undefined {
  return actor.actorType === 'customer' ? (actor.customerId ?? '__none__') : requested;
}

function parseTime(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw esgValidationFailed(`${field} must be a valid ISO 8601 timestamp`);
  return new Date(time);
}

interface DeviceScopeDelegate {
  findMany(args: { where: Record<string, unknown>; select: Record<string, boolean> }): Promise<{ id: string }[]>;
}

function devices(client: DbClient): DeviceScopeDelegate {
  return (client as unknown as Record<string, unknown>).device as DeviceScopeDelegate;
}

/** 共享 where 构建（查询与导出同源 → 过滤结果与 CSV 行数一致）。 */
export async function buildEsgWhere(
  client: DbClient,
  scopeCustomerId: string | undefined,
  filter: EsgFilter,
  timeField: 'bucketStart' | 'bucketDate' | 'periodStartTime' | 'summaryDate',
): Promise<Record<string, unknown>> {
  const where: Record<string, unknown> = {};
  if (scopeCustomerId !== undefined) where.customerId = scopeCustomerId;
  if (filter.deviceId) where.deviceId = filter.deviceId;
  if (filter.siteId) {
    const rows = await devices(client).findMany({ where: { siteId: filter.siteId }, select: { id: true } });
    const ids = rows.map((r) => r.id);
    where.deviceId = ids.length > 0 ? { in: ids } : '__none__';
  }
  const from = parseTime(filter.from, 'from');
  const to = parseTime(filter.to, 'to');
  if (from || to) {
    where[timeField] = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  return where;
}

/** actor → 有效 customer scope（Customer 角色强制）。 */
export function effectiveCustomerScope(actor: ActorContext, filter: EsgFilter): string | undefined {
  return scopedCustomerId(actor, filter.customerId);
}

// ---------- 行类型与 DTO ----------

interface HourlyRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly bucketStart: Date;
  readonly sampleCount: number;
  readonly completenessPct: unknown;
  readonly metrics: unknown;
}

export interface DailyRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly bucketDate: Date;
  readonly sampleCount: number;
  readonly completenessPct: unknown;
  readonly metrics: unknown;
}

export interface ReportRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly reportType: string;
  readonly periodStartTime: Date;
  readonly periodEndTime: Date;
  readonly feedingWeightKg: unknown;
  readonly dischargeWeightKg: unknown;
  readonly reductionWeightKg: unknown;
  readonly cycleCount: number | null;
  readonly processingMinutes: number | null;
  readonly powerConsumptionKwh: unknown;
  readonly avgPowerKw: unknown;
  readonly avgO2Pct: unknown;
  readonly avgCo2Ppm: unknown;
  readonly avgCh4Ppm: unknown;
  readonly avgN2oPpm: unknown;
  readonly carbonReductionKg: unknown;
  readonly carbonReductionMethod: string | null;
  readonly dataCompletenessPct: unknown;
  readonly missingRecordCount: number | null;
  readonly calculationVersionId: string | null;
}

export interface SummaryRow {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly summaryDate: Date;
  readonly feedingWeightKg: unknown;
  readonly dischargeWeightKg: unknown;
  readonly reductionWeightKg: unknown;
  readonly powerConsumptionKwh: unknown;
  readonly carbonReductionKg: unknown;
  readonly dataCompletenessPct: unknown;
  readonly missingRecordCount: number | null;
  readonly calculationVersionId: string | null;
}

interface VersionRow {
  readonly id: string;
  readonly version: string;
  readonly description: string | null;
  readonly formula: unknown;
  readonly effectiveFrom: Date;
  readonly status: string;
  readonly createdAt: Date;
}

export interface EsgHourlyView {
  readonly deviceId: string;
  readonly customerId: string;
  readonly bucketStart: string;
  readonly sampleCount: number;
  readonly completenessPct: number | null;
  readonly metrics: unknown;
}

export interface EsgDailyView {
  readonly deviceId: string;
  readonly customerId: string;
  readonly bucketDate: string;
  readonly sampleCount: number;
  readonly completenessPct: number | null;
  readonly metrics: unknown;
}

export interface EsgReportView {
  readonly reportId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly reportType: string;
  readonly periodStartTime: string;
  readonly periodEndTime: string;
  readonly feedingWeightKg: number | null;
  readonly dischargeWeightKg: number | null;
  readonly reductionWeightKg: number | null;
  readonly cycleCount: number | null;
  readonly processingMinutes: number | null;
  readonly powerConsumptionKwh: number | null;
  readonly avgPowerKw: number | null;
  readonly avgO2Pct: number | null;
  readonly avgCo2Ppm: number | null;
  readonly avgCh4Ppm: number | null;
  readonly avgN2oPpm: number | null;
  readonly carbonReductionKg: number | null;
  readonly carbonReductionMethod: string | null;
  readonly dataCompletenessPct: number | null;
  readonly missingRecordCount: number | null;
  readonly calculationVersionId: string | null;
}

export interface EsgDailySummaryView {
  readonly deviceId: string;
  readonly customerId: string;
  readonly summaryDate: string;
  readonly feedingWeightKg: number | null;
  readonly dischargeWeightKg: number | null;
  readonly reductionWeightKg: number | null;
  readonly powerConsumptionKwh: number | null;
  readonly carbonReductionKg: number | null;
  readonly dataCompletenessPct: number | null;
  readonly missingRecordCount: number | null;
  readonly calculationVersionId: string | null;
}

export interface EsgCalculationVersionView {
  readonly versionId: string;
  readonly version: string;
  readonly description: string | null;
  readonly formula: unknown;
  readonly effectiveFrom: string;
  readonly status: string;
  readonly createdAt: string;
}

/** 最近聚合窗口（各聚合表最新 bucket + ACTIVE 计算版本）。 */
export interface EsgOverviewView {
  readonly latestHourlyBucketStart: string | null;
  readonly latestDailyBucketDate: string | null;
  readonly latestEsgSummaryDate: string | null;
  readonly activeCalculationVersion: EsgCalculationVersionView | null;
}

export function toHourlyView(row: HourlyRow): EsgHourlyView {
  return {
    deviceId: row.deviceId,
    customerId: row.customerId,
    bucketStart: row.bucketStart.toISOString(),
    sampleCount: row.sampleCount,
    completenessPct: decimalToNumber(row.completenessPct),
    metrics: row.metrics,
  };
}

export function toDailyView(row: DailyRow): EsgDailyView {
  return {
    deviceId: row.deviceId,
    customerId: row.customerId,
    bucketDate: row.bucketDate.toISOString(),
    sampleCount: row.sampleCount,
    completenessPct: decimalToNumber(row.completenessPct),
    metrics: row.metrics,
  };
}

export function toReportView(row: ReportRow): EsgReportView {
  return {
    reportId: row.id,
    deviceId: row.deviceId,
    customerId: row.customerId,
    reportType: row.reportType,
    periodStartTime: row.periodStartTime.toISOString(),
    periodEndTime: row.periodEndTime.toISOString(),
    feedingWeightKg: decimalToNumber(row.feedingWeightKg),
    dischargeWeightKg: decimalToNumber(row.dischargeWeightKg),
    reductionWeightKg: decimalToNumber(row.reductionWeightKg),
    cycleCount: row.cycleCount,
    processingMinutes: row.processingMinutes,
    powerConsumptionKwh: decimalToNumber(row.powerConsumptionKwh),
    avgPowerKw: decimalToNumber(row.avgPowerKw),
    avgO2Pct: decimalToNumber(row.avgO2Pct),
    avgCo2Ppm: decimalToNumber(row.avgCo2Ppm),
    avgCh4Ppm: decimalToNumber(row.avgCh4Ppm),
    avgN2oPpm: decimalToNumber(row.avgN2oPpm),
    carbonReductionKg: decimalToNumber(row.carbonReductionKg),
    carbonReductionMethod: row.carbonReductionMethod,
    dataCompletenessPct: decimalToNumber(row.dataCompletenessPct),
    missingRecordCount: row.missingRecordCount,
    calculationVersionId: row.calculationVersionId,
  };
}

export function toSummaryView(row: SummaryRow): EsgDailySummaryView {
  return {
    deviceId: row.deviceId,
    customerId: row.customerId,
    summaryDate: row.summaryDate.toISOString(),
    feedingWeightKg: decimalToNumber(row.feedingWeightKg),
    dischargeWeightKg: decimalToNumber(row.dischargeWeightKg),
    reductionWeightKg: decimalToNumber(row.reductionWeightKg),
    powerConsumptionKwh: decimalToNumber(row.powerConsumptionKwh),
    carbonReductionKg: decimalToNumber(row.carbonReductionKg),
    dataCompletenessPct: decimalToNumber(row.dataCompletenessPct),
    missingRecordCount: row.missingRecordCount,
    calculationVersionId: row.calculationVersionId,
  };
}

function toVersionView(row: VersionRow): EsgCalculationVersionView {
  return {
    versionId: row.id,
    version: row.version,
    description: row.description,
    formula: row.formula,
    effectiveFrom: row.effectiveFrom.toISOString(),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------- 数据访问 ----------

function hourlyTable(client: DbClient): {
  findMany(args: Record<string, unknown>): Promise<HourlyRow[]>;
  findFirst(args: Record<string, unknown>): Promise<HourlyRow | null>;
} {
  return (client as unknown as Record<string, unknown>).telemetryHourly as never;
}

function dailyTable(client: DbClient): {
  findMany(args: Record<string, unknown>): Promise<DailyRow[]>;
  findFirst(args: Record<string, unknown>): Promise<DailyRow | null>;
} {
  return (client as unknown as Record<string, unknown>).telemetryDaily as never;
}

function reportsTable(client: DbClient): {
  findMany(args: Record<string, unknown>): Promise<ReportRow[]>;
} {
  return (client as unknown as Record<string, unknown>).esgReport as never;
}

function summaryTable(client: DbClient): {
  findMany(args: Record<string, unknown>): Promise<SummaryRow[]>;
  findFirst(args: Record<string, unknown>): Promise<SummaryRow | null>;
} {
  return (client as unknown as Record<string, unknown>).esgDailySummary as never;
}

function versionsTable(client: DbClient): {
  findMany(args: Record<string, unknown>): Promise<VersionRow[]>;
  findFirst(args: Record<string, unknown>): Promise<VersionRow | null>;
} {
  return (client as unknown as Record<string, unknown>).esgCalculationVersion as never;
}

function paginate<TRow extends { id: string }, TView>(
  rows: TRow[],
  limit: number,
  toView: (row: TRow) => TView,
): Page<TView> {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toView),
    nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null,
  };
}

// ---------- 查询 ----------

export async function listEsgHourly(
  deps: EsgDeps,
  actor: ActorContext,
  filter: EsgFilter = {},
): Promise<Page<EsgHourlyView>> {
  const limit = normalizeLimit(filter.limit ?? null);
  const where = await buildEsgWhere(deps.client, effectiveCustomerScope(actor, filter), filter, 'bucketStart');
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = await hourlyTable(deps.client).findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
  return paginate(rows, limit, toHourlyView);
}

export async function listEsgDaily(
  deps: EsgDeps,
  actor: ActorContext,
  filter: EsgFilter = {},
): Promise<Page<EsgDailyView>> {
  const limit = normalizeLimit(filter.limit ?? null);
  const where = await buildEsgWhere(deps.client, effectiveCustomerScope(actor, filter), filter, 'bucketDate');
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = await dailyTable(deps.client).findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
  return paginate(rows, limit, toDailyView);
}

export async function listEsgReports(
  deps: EsgDeps,
  actor: ActorContext,
  filter: EsgFilter = {},
): Promise<Page<EsgReportView>> {
  if (filter.reportType !== undefined && !(ESG_REPORT_TYPES as readonly string[]).includes(filter.reportType)) {
    throw esgValidationFailed(`reportType must be one of: ${ESG_REPORT_TYPES.join(', ')}`);
  }
  const limit = normalizeLimit(filter.limit ?? null);
  const where = await buildEsgWhere(deps.client, effectiveCustomerScope(actor, filter), filter, 'periodStartTime');
  if (filter.reportType) where.reportType = filter.reportType;
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = await reportsTable(deps.client).findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
  return paginate(rows, limit, toReportView);
}

/** ESG 日汇总（含完整率与计算版本引用）。 */
export async function listEsgDailySummary(
  deps: EsgDeps,
  actor: ActorContext,
  filter: EsgFilter = {},
): Promise<Page<EsgDailySummaryView>> {
  const limit = normalizeLimit(filter.limit ?? null);
  const where = await buildEsgWhere(deps.client, effectiveCustomerScope(actor, filter), filter, 'summaryDate');
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = await summaryTable(deps.client).findMany({ where, orderBy: { id: 'asc' }, take: limit + 1 });
  return paginate(rows, limit, toSummaryView);
}

/** 计算版本查询（全角色只读；版本为全局元数据，无租户维度）。 */
export async function listEsgCalculationVersions(deps: EsgDeps): Promise<EsgCalculationVersionView[]> {
  const rows = await versionsTable(deps.client).findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toVersionView);
}

/** 最近聚合窗口（各聚合表在 scope 内最新 bucket + ACTIVE 计算版本）。 */
export async function getEsgOverview(
  deps: EsgDeps,
  actor: ActorContext,
  filter: EsgFilter = {},
): Promise<EsgOverviewView> {
  const scope = effectiveCustomerScope(actor, filter);
  const scopedWhere = scope !== undefined ? { customerId: scope } : {};
  const [hourly, daily, summary, version] = await Promise.all([
    hourlyTable(deps.client).findFirst({ where: scopedWhere, orderBy: { bucketStart: 'desc' } }),
    dailyTable(deps.client).findFirst({ where: scopedWhere, orderBy: { bucketDate: 'desc' } }),
    summaryTable(deps.client).findFirst({ where: scopedWhere, orderBy: { summaryDate: 'desc' } }),
    versionsTable(deps.client).findFirst({ where: { status: 'ACTIVE' }, orderBy: { effectiveFrom: 'desc' } }),
  ]);
  return {
    latestHourlyBucketStart: hourly?.bucketStart.toISOString() ?? null,
    latestDailyBucketDate: daily?.bucketDate.toISOString() ?? null,
    latestEsgSummaryDate: summary?.summaryDate.toISOString() ?? null,
    activeCalculationVersion: version ? toVersionView(version) : null,
  };
}
