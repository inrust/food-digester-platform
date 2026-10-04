import { Button, Input } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
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
import { NumberText } from '../../components/LocaleValue.js';
import type { FilterOption } from '../../components/ScopeFilter.js';
import { ExportPanel } from '../../components/ExportPanel.js';
import type { EsgQueryFilter } from './esg-api.js';
import {
  ESG_PERIODS,
  ESG_PERIOD_LABELS,
  aggregateDailySummaries,
  calculationVersionText,
  canExport,
  esgDisclaimer,
  formatKg,
  formatKwh,
  formatPct,
  zonedDateRangeToUtc,
} from './esg-state.js';
import type { EsgPeriod } from './esg-state.js';
import type { EsgCalculationVersionView, EsgDailySummaryView, EsgExportJobView } from './types.js';
import { useI18n } from '../../i18n/i18n.js';
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
  readonly onExport: (
    snapshot: EsgQueryFilter & {
      dataset: 'DAILY_SUMMARY';
    },
  ) => Promise<unknown>;
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
  const { language } = useI18n();
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
      setDateError(translate('page.89b179c8814c'));
      return;
    }
    const range = zonedDateRangeToUtc(draft.fromDate, draft.toDate, timeZone);
    if (range === null) {
      setDateError(translate('page.97c433594a7b'));
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
      <header className="page-header">
        <h1>{translate('design.page.esg-overview')}</h1>
      </header>
      <p className="esg-disclaimer" data-testid="esg-disclaimer">
        {esgDisclaimer()}
        {translate('page.504a12fd9000')}
      </p>

      <div className="filter-bar" data-testid="esg-overview-filter">
        <div
          className="period-toggle"
          role="group"
          aria-label={translate('page.bc3d16afc041')}
          data-testid="esg-period-toggle"
        >
          {ESG_PERIODS.map((p) => (
            <Button
              key={p}
              type="button"
              aria-pressed={period === p}
              className={period === p ? 'active' : ''}
              data-testid={`period-${p}`}
              onClick={() => onPeriodChange(p)}
            >
              {ESG_PERIOD_LABELS[p]}
            </Button>
          ))}
        </div>
        {!isCustomerRole ? (
          <>
            <label htmlFor="esg-customer">{translate('page.467c1137f479')}</label>
            <select
              id="esg-customer"
              data-testid="esg-customer-filter"
              value={draft.customerId ?? ''}
              onChange={(event) =>
                setDraft({ ...draft, customerId: event.target.value === '' ? null : event.target.value })
              }
            >
              <option value="">{translate('page.778fc8f99453')}</option>
              {customerOptions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <div className="filter-field">
          <label htmlFor="esg-from">
            {translate('page.49f932b2f932')}
            {timeZone}）
          </label>
          <Input
            id="esg-from"
            type="date"
            data-testid="esg-from-date"
            value={draft.fromDate}
            onChange={(event) => setDraft({ ...draft, fromDate: event.target.value })}
          />
        </div>
        <div className="filter-field">
          <label htmlFor="esg-to">{translate('page.9b3177f0b700')}</label>
          <Input
            id="esg-to"
            type="date"
            data-testid="esg-to-date"
            value={draft.toDate}
            onChange={(event) => setDraft({ ...draft, toDate: event.target.value })}
          />
        </div>
        <Button type="button" className="primary-button" data-testid="esg-apply" onClick={applyFilter}>
          {translate('page.4562024ddec7')}
        </Button>
        {dateError !== null ? (
          <p className="field-hint" data-testid="esg-date-error">
            {dateError}
          </p>
        ) : null}
      </div>

      {appliedQuery.from !== null && appliedQuery.to !== null ? (
        <p className="query-hint" data-testid="esg-query-hint">
          {translate('page.fb2ea9e2dfbf') + ' '}
          {timeZone}
          {' ' + translate('page.60d39b4be3b1')}
          {appliedQuery.from} ~ {appliedQuery.to}
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
          {translate('page.300ee3dee4dc')}
        </div>
      ) : aggregated.length === 0 ? (
        <p className="empty-state" data-testid="esg-empty">
          {translate('page.b240ae6fc532')}
        </p>
      ) : (
        <div className="cursor-table">
          <table aria-label={translate('page.df73354a1658')} data-testid="esg-summary-table">
            <thead>
              <tr>
                <th scope="col" data-testid="esg-col-date">
                  {ESG_PERIOD_LABELS[period]}
                  {translate('page.24cd18eefa93')}
                </th>
                <th scope="col" data-testid="esg-col-throughput">
                  {translate('page.019d8bd79329')}
                </th>
                <th scope="col">{translate('page.baa2a8962417')}</th>
                <th scope="col">{translate('page.c466d61643c6')}</th>
                <th scope="col" data-testid="esg-col-energy">
                  {translate('page.d309c902a7bb')}
                </th>
                <th scope="col" data-testid="esg-col-carbon">
                  {translate('page.efd09f0f8785')}
                </th>
                <th scope="col">
                  {translate('page.8152ee3ec309')}
                  {period === 'day' ? '' : translate('page.c6546828511f')}
                </th>
                <th scope="col">{translate('page.b36abcaf4f48')}</th>
                <th scope="col">{translate('page.9971a97635de')}</th>
              </tr>
            </thead>
            <tbody>
              {aggregated.map((row) => (
                <tr key={row.bucket} data-testid={`esg-row-${row.bucket}`}>
                  <td>{row.bucket}</td>
                  <td>{formatKg(row.feedingWeightKg, language)}</td>
                  <td>{formatKg(row.dischargeWeightKg, language)}</td>
                  <td>{formatKg(row.reductionWeightKg, language)}</td>
                  <td>{formatKwh(row.powerConsumptionKwh, language)}</td>
                  <td>{formatKg(row.carbonReductionKg, language)}</td>
                  <td data-testid={`esg-completeness-${row.bucket}`}>{formatPct(row.avgCompletenessPct, language)}</td>
                  <td>{row.missingRecordCount === null ? '—' : <NumberText value={row.missingRecordCount} />}</td>
                  <td data-testid={`esg-version-${row.bucket}`}>{calculationVersionText(row.versionIds, versions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
