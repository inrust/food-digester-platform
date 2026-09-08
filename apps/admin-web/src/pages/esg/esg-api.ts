/**
 * FE-11 ESG API 装配（BE-ESG-02）。
 * 列表均为键集游标分页；导出为异步任务（202 入队，筛选快照冻结，COMPLETED 且未过期返回短期 URL）。
 */
import type { ApiClient } from '../../api/http-client.js';
import type {
  EsgCalculationVersionView,
  EsgDailySummaryView,
  EsgDataset,
  EsgExportJobView,
  EsgReportType,
  EsgReportView,
} from './types.js';

export interface Page<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
}

export interface EsgQueryFilter {
  readonly customerId?: string | null;
  readonly siteId?: string | null;
  readonly deviceId?: string | null;
  /** UTC ISO（由页面按用户时区日历日转换）。 */
  readonly from?: string | null;
  readonly to?: string | null;
}

function buildQuery(filter: Record<string, string | null | undefined>, cursor?: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  }
  if (cursor !== undefined && cursor !== '') params.set('cursor', cursor);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

async function fetchPage<T>(api: ApiClient, path: string): Promise<Page<T>> {
  const response = await api.request<{ data: T[]; meta: { nextCursor: string | null } }>(path);
  return { rows: response.data, nextCursor: response.meta.nextCursor };
}

export async function fetchEsgDailySummary(
  api: ApiClient,
  filter: EsgQueryFilter,
  cursor?: string,
): Promise<Page<EsgDailySummaryView>> {
  return fetchPage<EsgDailySummaryView>(api, `/admin/esg/daily-summary${buildQuery({ ...filter }, cursor)}`);
}

export async function fetchEsgReports(
  api: ApiClient,
  filter: EsgQueryFilter & { reportType?: EsgReportType | null },
  cursor?: string,
): Promise<Page<EsgReportView>> {
  const { reportType, ...rest } = filter;
  return fetchPage<EsgReportView>(
    api,
    `/admin/esg/reports${buildQuery({ ...rest, reportType: reportType ?? null }, cursor)}`,
  );
}

export async function fetchEsgCalculationVersions(api: ApiClient): Promise<readonly EsgCalculationVersionView[]> {
  const response = await api.request<{ data: EsgCalculationVersionView[] }>('/admin/esg/calculation-versions');
  return response.data;
}

/** 创建异步导出：筛选快照为页面当前已应用筛选（导出筛选与页面一致）。 */
export async function createEsgExport(
  api: ApiClient,
  input: EsgQueryFilter & { dataset: EsgDataset },
): Promise<EsgExportJobView> {
  const { dataset, ...rest } = input;
  const body: Record<string, string> = { dataset };
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined && value !== null && value !== '') body[key] = value;
  }
  const response = await api.request<{ data: EsgExportJobView }>('/admin/esg/exports', { method: 'POST', body });
  return response.data;
}

export async function fetchEsgExport(api: ApiClient, exportId: string): Promise<EsgExportJobView> {
  const response = await api.request<{ data: EsgExportJobView }>(`/admin/esg/exports/${encodeURIComponent(exportId)}`);
  return response.data;
}
