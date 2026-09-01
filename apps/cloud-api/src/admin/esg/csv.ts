/**
 * BE-ESG-02 CSV Schema 与序列化（纯函数，无 IO）。
 *
 * 列集合封闭（CSV Schema 交付物）：列名与查询 DTO 字段一致；序列化确定性
 * （列序固定、行序由查询保证 id/bucket 升序）。转义规则 RFC 4180：含 , " \r \n
 * 的单元格加双引号且内嵌 " 双写；null → 空串；Decimal 经 toNumber 归一；Json 列
 * （metrics）序列化为 JSON 字符串。
 */

export const ESG_EXPORT_DATASETS = ['HOURLY', 'DAILY', 'REPORTS', 'DAILY_SUMMARY'] as const;
export type EsgExportDataset = (typeof ESG_EXPORT_DATASETS)[number];

/** CSV Schema：数据集 → 固定列头（与查询 DTO 字段一致）。 */
export const ESG_CSV_SCHEMAS: Readonly<Record<EsgExportDataset, readonly string[]>> = {
  HOURLY: ['deviceId', 'customerId', 'bucketStart', 'sampleCount', 'completenessPct', 'metrics'],
  DAILY: ['deviceId', 'customerId', 'bucketDate', 'sampleCount', 'completenessPct', 'metrics'],
  REPORTS: [
    'reportId',
    'deviceId',
    'customerId',
    'reportType',
    'periodStartTime',
    'periodEndTime',
    'feedingWeightKg',
    'dischargeWeightKg',
    'reductionWeightKg',
    'cycleCount',
    'processingMinutes',
    'powerConsumptionKwh',
    'avgPowerKw',
    'avgO2Pct',
    'avgCo2Ppm',
    'avgCh4Ppm',
    'avgN2oPpm',
    'carbonReductionKg',
    'carbonReductionMethod',
    'dataCompletenessPct',
    'missingRecordCount',
    'calculationVersionId',
  ],
  DAILY_SUMMARY: [
    'deviceId',
    'customerId',
    'summaryDate',
    'feedingWeightKg',
    'dischargeWeightKg',
    'reductionWeightKg',
    'powerConsumptionKwh',
    'carbonReductionKg',
    'dataCompletenessPct',
    'missingRecordCount',
    'calculationVersionId',
  ],
} as const;

/** Prisma Decimal 归一（Decimal 对象 → number；null 保持）。 */
export function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return null;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 行 → CSV 文本（含表头；\r\n 行尾，RFC 4180）。rows 为字段名 → 值的记录。 */
export function toCsv(dataset: EsgExportDataset, rows: readonly Record<string, unknown>[]): string {
  const headers = ESG_CSV_SCHEMAS[dataset];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
