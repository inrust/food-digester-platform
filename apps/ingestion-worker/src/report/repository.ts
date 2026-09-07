/**
 * BE-IOT-06 ESG Report Repository：报告行保存与期间校验（esg_reports，DB-01）。
 *
 * - 幂等：unique(deviceId, reportType, periodStartTime) + sourceMessageId 唯一兜底；
 *   相同报告（同期间起点）重放 → duplicate 跳过，不覆盖既有行；
 * - 期间重叠（同设备同类型、不同起点且区间相交）由 Handler 判定拒绝（本模块提供查询）；
 *   processWithReceipt 按 device+report 串行事务，关闭“先查后插”的并发窗口；
 * - processingDurationMinutes（number）→ processing_minutes（Int）：四舍五入落列（表示层转换，
 *   不改变设备端算法口径）。
 */
import type { DbClient } from '@fdp/database';

export const REPORT_TYPES = ['CYCLE', 'HOURLY', 'DAILY'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export interface ReportWrite {
  readonly deviceId: string;
  readonly customerId: string;
  readonly siteId: string;
  readonly reportType: ReportType;
  readonly periodStartTime: Date;
  readonly periodEndTime: Date;
  readonly sourceMessageId: string;
  readonly feedingWeightKg?: number | undefined;
  readonly dischargeWeightKg?: number | undefined;
  readonly reductionWeightKg?: number | undefined;
  readonly cycleCount?: number | undefined;
  readonly processingDurationMinutes?: number | undefined;
  readonly energyConsumptionKwh?: number | undefined;
  readonly averagePowerKw?: number | undefined;
  readonly averageO2Pct?: number | undefined;
  readonly averageCo2Ppm?: number | undefined;
  readonly averageCh4Ppm?: number | undefined;
  readonly averageN2oPpm?: number | undefined;
  readonly carbonReductionKg?: number | undefined;
  readonly carbonReductionMethod?: string | undefined;
  readonly dataCompletenessPct?: number | undefined;
  readonly missingRecordCount?: number | undefined;
}

export type InsertReportResult = { readonly status: 'created' } | { readonly status: 'duplicate' };

interface ReportRow {
  readonly id: string;
  readonly periodStartTime: Date;
  readonly periodEndTime: Date;
}

interface ReportDelegate {
  findFirst(args: { where: Record<string, unknown>; orderBy?: Record<string, unknown> }): Promise<ReportRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

function reports(client: DbClient): ReportDelegate {
  return (client as unknown as Record<string, unknown>).esgReport as ReportDelegate;
}

/** Payload data → EsgReport 列映射（仅落出现的可选列）。 */
export function buildReportRow(write: ReportWrite): Record<string, unknown> {
  const row: Record<string, unknown> = {
    deviceId: write.deviceId,
    customerId: write.customerId,
    siteId: write.siteId,
    reportType: write.reportType,
    periodStartTime: write.periodStartTime,
    periodEndTime: write.periodEndTime,
    sourceMessageId: write.sourceMessageId,
  };
  const optional: Record<string, unknown> = {
    feedingWeightKg: write.feedingWeightKg,
    dischargeWeightKg: write.dischargeWeightKg,
    reductionWeightKg: write.reductionWeightKg,
    cycleCount: write.cycleCount,
    processingMinutes:
      write.processingDurationMinutes !== undefined ? Math.round(write.processingDurationMinutes) : undefined,
    powerConsumptionKwh: write.energyConsumptionKwh,
    avgPowerKw: write.averagePowerKw,
    avgO2Pct: write.averageO2Pct,
    avgCo2Ppm: write.averageCo2Ppm,
    avgCh4Ppm: write.averageCh4Ppm,
    avgN2oPpm: write.averageN2oPpm,
    carbonReductionKg: write.carbonReductionKg,
    carbonReductionMethod: write.carbonReductionMethod,
    dataCompletenessPct: write.dataCompletenessPct,
    missingRecordCount: write.missingRecordCount,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) row[key] = value;
  }
  return row;
}

/** 查询同设备同类型与新期间 [start, end) 相交的既有报告（重叠判定输入）。 */
export async function findOverlappingReport(
  client: DbClient,
  params: {
    readonly deviceId: string;
    readonly customerId: string;
    readonly siteId: string;
    readonly reportType: ReportType;
    readonly start: Date;
    readonly end: Date;
  },
): Promise<ReportRow | null> {
  return reports(client).findFirst({
    where: {
      deviceId: params.deviceId,
      customerId: params.customerId,
      siteId: params.siteId,
      reportType: params.reportType,
      periodStartTime: { lt: params.end },
      periodEndTime: { gt: params.start },
    },
    orderBy: { periodStartTime: 'asc' },
  });
}

/**
 * 插入报告行。
 * 相同报告（同期间起点）由 Handler 预检跳过；此处不捕获 P2002——
 * PostgreSQL 事务内语句失败即中止（25P02），并发唯一冲突应让事务回滚，
 * 由上层 TRANSIENT 重试后走预检幂等路径。
 */
export async function insertReport(client: DbClient, write: ReportWrite): Promise<InsertReportResult> {
  await reports(client).create({ data: buildReportRow(write) });
  return { status: 'created' };
}
