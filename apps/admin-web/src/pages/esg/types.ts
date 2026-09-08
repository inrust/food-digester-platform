/**
 * FE-11 ESG 数据类型：镜像 admin-esg-api.json（BE-ESG-02）。
 */

export type EsgDataset = 'HOURLY' | 'DAILY' | 'REPORTS' | 'DAILY_SUMMARY';

export type EsgReportType = 'CYCLE' | 'HOURLY' | 'DAILY';

/** ESG 日汇总（含完整率/计算版本引用；时间列 summaryDate）。 */
export interface EsgDailySummaryView {
  readonly deviceId: string;
  readonly customerId: string;
  readonly summaryDate: string;
  readonly feedingWeightKg: number | null;
  readonly dischargeWeightKg: number | null;
  readonly reductionWeightKg: number | null;
  readonly powerConsumptionKwh: number | null;
  /** 估算碳减排（带计算版本；非第三方核证）。 */
  readonly carbonReductionKg: number | null;
  readonly dataCompletenessPct: number | null;
  readonly missingRecordCount: number | null;
  readonly calculationVersionId: string | null;
}

/** 设备提交 Report（含气体均值与投料/出料/减量全指标）。 */
export interface EsgReportView {
  readonly reportId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly reportType: EsgReportType;
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

export interface EsgCalculationVersionView {
  readonly versionId: string;
  readonly version: string;
  readonly description: string | null;
  /** 计算方法参数（原样展示为 JSON）。 */
  readonly formula: unknown;
  readonly effectiveFrom: string;
  readonly status: 'ACTIVE' | 'SUPERSEDED';
  readonly createdAt: string;
}

export type EsgExportStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface EsgExportJobView {
  readonly exportId: string;
  readonly dataset: EsgDataset;
  readonly status: EsgExportStatus;
  /** 创建时冻结的筛选快照。 */
  readonly filters: Record<string, unknown>;
  readonly rowCount: number | null;
  /** COMPLETED 且未过期时返回；过期/未完成为 null。 */
  readonly downloadUrl: string | null;
  readonly urlExpiresAt: string | null;
  readonly urlExpired: boolean;
  readonly error: string | null;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
}
