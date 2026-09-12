/**
 * FE-11 ESG 概览页（/esg/overview）：日/周/月切换、估算 CO2e（含计算版本与完整率）、
 * 投料/出料/减量/能耗、CSV 导出。
 *
 * - “碳排放”显示为“估算 CO2e（kg）”，固定展示“非第三方核证”声明（口径纪律）；
 * - 日期按用户时区日历日转 UTC 查询（zonedDateRangeToUtc），页面展示换算结果；
 * - 周/月为日汇总客户端聚合：可加指标求和，完整率算术平均（标注），混合版本显示“多版本”；
 * - 导出筛选快照 = 页面当前已应用筛选（dataset=DAILY_SUMMARY）；过期链接明确提示。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import type { FilterOption } from '../../components/ScopeFilter.js';
import { ExportPanel } from '../../components/ExportPanel.js';
import type { EsgQueryFilter } from './esg-api.js';
import {
  ESG_DISCLAIMER,
  ESG_PERIODS,
  ESG_PERIOD_LABELS,
  aggregateDailySummaries,
  calculationVersionText,
  canExport,
  formatKg,
  formatKwh,
  formatPct,
  zonedDateRangeToUtc,
} from './esg-state.js';
import type { EsgPeriod } from './esg-state.js';
import type { EsgCalculationVersionView, EsgDailySummaryView, EsgExportJobView } from './types.js';

export interface EsgOverviewFilter {
  readonly customerId: string | null;
  /** 用户时区日历日（YYYY-MM-DD）；空 = 不限。 */
  readonly fromDate: string;
  readonly toDate: string;
}

export const EMPTY_ESG_OVERVIEW_FILTER: EsgOverviewFilter = { customerId: null, fromDate: '', toDate: '' };

/** 已应用查询（UTC ISO；由页面按用户时区换算）。 */
export interface EsgAppliedQuery {
  readonly customerId: string | null;
  readonly from: string | null;
  readonly to: string | null;
}

export interface EsgOverviewPageProps {
  readonly role: Role;
  /** 用户时区（会话 profile；用于日历日 → UTC 换算）。 */
  readonly timeZone: string;
  readonly isCustomerRole: boolean;
  readonly customerOptions: readonly FilterOption[];
  readonly period: EsgPeriod;
  readonly onPeriodChange: (period: EsgPeriod) => void;
  readonly appliedQuery: EsgAppliedQuery;
  readonly onApply: (query: EsgAppliedQuery) => void;
  readonly rows: readonly EsgDailySummaryView[] | null;
  readonly loading?: boolean;
  readonly listError?: unknown;
  readonly versions: readonly EsgCalculationVersionView[] | null;
  readonly exportJob: EsgExportJobView | null;
  /** 导出筛选快照与页面一致：dataset=DAILY_SUMMARY + 已应用筛选。 */
  readonly onExport: (snapshot: EsgQueryFilter & { dataset: 'DAILY_SUMMARY' }) => Promise<unknown>;
  readonly onCheckExport: (exportId: string) => void;
  readonly onRefresh: () => void;
}

export function EsgOverviewPage({
  role,
  timeZone,
  isCustomerRole,
  customerOptions,
  period,
  onPeriodChange,
  appliedQuery,
  onApply,
  rows,
  loading = false,
  listError,
  versions,
  exportJob,
  onExport,
  onCheckExport,
  onRefresh,
}: EsgOverviewPageProps) {
  const [draft, setDraft] = useState<EsgOverviewFilter>({
    customerId: appliedQuery.customerId,
    fromDate: '',
    toDate: '',
  });
  const [dateError, setDateError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<unknown>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const aggregated = rows === null ? null : aggregateDailySummaries(rows, period);

  const applyFilter = () => {
    setDateError(null);
    if (draft.fromDate === '' && draft.toDate === '') {
      onApply({ customerId: draft.customerId, from: null, to: null });
      return;
    }
    if (draft.fromDate === '' || draft.toDate === '') {
      setDateError('起止日期须同时填写');
      return;
    }
    const range = zonedDateRangeToUtc(draft.fromDate, draft.toDate, timeZone);
    if (range === null) {
      setDateError('日期格式非法或起始晚于截止');
      return;
    }
    onApply({ customerId: draft.customerId, from: range.from, to: range.to });
  };

  const handleExport = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setExportError(null);
    try {
      await onExport({
        dataset: 'DAILY_SUMMARY',
        customerId: appliedQuery.customerId,
        from: appliedQuery.from,
        to: appliedQuery.to,
      });
    } catch (err) {
      setExportError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="esg-overview-page" data-testid="esg-overview-page">
      <p className="esg-disclaimer" data-testid="esg-disclaimer">
        {ESG_DISCLAIMER}：碳减排为带计算版本的估算 CO2e，不构成任何认证结论。
      </p>

      <div className="filter-bar" data-testid="esg-overview-filter">
        <div className="period-toggle" role="group" aria-label="日/周/月切换" data-testid="esg-period-toggle">
          {ESG_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={period === p}
              className={period === p ? 'active' : ''}
              data-testid={`period-${p}`}
              onClick={() => onPeriodChange(p)}
            >
              {ESG_PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        {!isCustomerRole ? (
          <>
            <label htmlFor="esg-customer">所属客户</label>
            <select
              id="esg-customer"
              data-testid="esg-customer-filter"
              value={draft.customerId ?? ''}
              onChange={(event) =>
                setDraft({ ...draft, customerId: event.target.value === '' ? null : event.target.value })
              }
            >
              <option value="">全部</option>
              {customerOptions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <label htmlFor="esg-from">起始日期（{timeZone}）</label>
        <input
          id="esg-from"
          type="date"
          data-testid="esg-from-date"
          value={draft.fromDate}
          onChange={(event) => setDraft({ ...draft, fromDate: event.target.value })}
        />
        <label htmlFor="esg-to">截止日期</label>
        <input
          id="esg-to"
          type="date"
          data-testid="esg-to-date"
          value={draft.toDate}
          onChange={(event) => setDraft({ ...draft, toDate: event.target.value })}
        />
        <button type="button" className="primary-button" data-testid="esg-apply" onClick={applyFilter}>
          应用
        </button>
        {dateError !== null ? (
          <p className="field-hint" data-testid="esg-date-error">
            {dateError}
          </p>
        ) : null}
      </div>

      {appliedQuery.from !== null && appliedQuery.to !== null ? (
        <p className="query-hint" data-testid="esg-query-hint">
          按 {timeZone} 日历日转 UTC 查询：{appliedQuery.from} ~ {appliedQuery.to}
        </p>
      ) : null}

      {exportError !== null ? <ErrorNotice error={exportError} onRefresh={onRefresh} /> : null}
      <ExportPanel
        testidPrefix="esg"
        canExport={canExport(role)}
        busy={busy}
        job={exportJob}
        onExport={() => void handleExport()}
        onCheckStatus={onCheckExport}
      />

      {listError !== undefined ? <ErrorNotice error={listError} onRefresh={onRefresh} /> : null}
      {aggregated === null || loading ? (
        <div role="status" data-testid="esg-loading">
          加载中…
        </div>
      ) : aggregated.length === 0 ? (
        <p className="empty-state" data-testid="esg-empty">
          暂无 ESG 汇总数据
        </p>
      ) : (
        <table aria-label="ESG 汇总" data-testid="esg-summary-table">
          <thead>
            <tr>
              <th scope="col" data-testid="esg-col-date">
                {ESG_PERIOD_LABELS[period]}期间
              </th>
              <th scope="col" data-testid="esg-col-throughput">
                投料量 (kg)
              </th>
              <th scope="col">出料量 (kg)</th>
              <th scope="col">减量 (kg)</th>
              <th scope="col" data-testid="esg-col-energy">
                能耗 (kWh)
              </th>
              <th scope="col" data-testid="esg-col-carbon">
                估算 CO2e (kg)
              </th>
              <th scope="col">完整率{period === 'day' ? '' : '（平均）'}</th>
              <th scope="col">缺失记录</th>
              <th scope="col">计算版本</th>
            </tr>
          </thead>
          <tbody>
            {aggregated.map((row) => (
              <tr key={row.bucket} data-testid={`esg-row-${row.bucket}`}>
                <td>{row.bucket}</td>
                <td>{formatKg(row.feedingWeightKg)}</td>
                <td>{formatKg(row.dischargeWeightKg)}</td>
                <td>{formatKg(row.reductionWeightKg)}</td>
                <td>{formatKwh(row.powerConsumptionKwh)}</td>
                <td>{formatKg(row.carbonReductionKg)}</td>
                <td data-testid={`esg-completeness-${row.bucket}`}>{formatPct(row.avgCompletenessPct)}</td>
                <td>{row.missingRecordCount ?? '—'}</td>
                <td data-testid={`esg-version-${row.bucket}`}>{calculationVersionText(row.versionIds, versions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
