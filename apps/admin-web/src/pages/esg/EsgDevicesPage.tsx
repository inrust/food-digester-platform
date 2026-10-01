import { translate } from '../../i18n/i18n.js';
/**
 * FE-11 设备 ESG 信息页（/esg/devices）：Region/Subregion/Site/Device 联动筛选（DEC-011）、
 * 日/周/月切换、投料/出料/减量/能耗/O2/CO2/CH4/N2O/估算 CO2e、完整率与计算版本、CSV 导出。
 *
 * - 数据源：设备提交 Report（REPORTS 数据集，reportType=DAILY）；region/subregion 为
 *   客户端级联收窄（契约无 region 参数），siteId/deviceId 入查询；
 * - 周/月聚合：可加指标求和，气体均值与完整率算术平均（列头标注“平均”）；
 * - 日期按用户时区转 UTC；导出筛选快照与页面一致（dataset=REPORTS）；
 * - 固定展示“非第三方核证”声明。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { PercentText } from '../../components/LocaleValue.js';
import { ScopeFilter } from '../../components/ScopeFilter.js';
import type { ScopeFilterProps } from '../../components/ScopeFilter.js';
import type { ScopeFilterValue } from '../../components/filter-state.js';
import { ExportPanel } from '../../components/ExportPanel.js';
import type { EsgQueryFilter } from './esg-api.js';
import {
  ESG_PERIODS,
  ESG_PERIOD_LABELS,
  aggregateDeviceReports,
  calculationVersionText,
  canExport,
  esgDisclaimer,
  formatKg,
  formatKwh,
  formatPct,
  formatPpm,
  zonedDateRangeToUtc,
} from './esg-state.js';
import type { EsgPeriod } from './esg-state.js';
import type { EsgCalculationVersionView, EsgExportJobView, EsgReportView } from './types.js';
import { useI18n } from '../../i18n/i18n.js';
export interface EsgDeviceAppliedQuery {
  readonly scope: ScopeFilterValue;
  readonly from: string | null;
  readonly to: string | null;
}
export interface EsgDevicesPageProps {
  readonly role: Role;
  readonly timeZone: string;
  readonly period: EsgPeriod;
  readonly onPeriodChange: (period: EsgPeriod) => void;
  readonly scopeOptions: {
    readonly regions: ScopeFilterProps['regions'];
    readonly subregions: ScopeFilterProps['subregions'];
    readonly sites: ScopeFilterProps['sites'];
    readonly devices: NonNullable<ScopeFilterProps['devices']>;
  };
  /** 设备 → 区域归属映射（region/subregion 客户端收窄行）。 */
  readonly deviceScope: Readonly<
    Record<
      string,
      {
        readonly region: string;
        readonly subregion: string;
      }
    >
  >;
  readonly applied: EsgDeviceAppliedQuery;
  readonly onApply: (next: EsgDeviceAppliedQuery) => void;
  readonly rows: readonly EsgReportView[] | null;
  readonly loading?: boolean;
  readonly listError?: unknown;
  readonly versions: readonly EsgCalculationVersionView[] | null;
  readonly exportJob: EsgExportJobView | null;
  readonly onExport: (
    snapshot: EsgQueryFilter & {
      dataset: 'REPORTS';
    },
  ) => Promise<unknown>;
  readonly onCheckExport: (exportId: string) => void;
  readonly onRefresh: () => void;
}
export function EsgDevicesPage({
  role,
  timeZone,
  period,
  onPeriodChange,
  scopeOptions,
  deviceScope,
  applied,
  onApply,
  rows,
  loading = false,
  listError,
  versions,
  exportJob,
  onExport,
  onCheckExport,
  onRefresh,
}: EsgDevicesPageProps) {
  const { language } = useI18n();
  const [draftScope, setDraftScope] = useState<ScopeFilterValue>(applied.scope);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<unknown>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const applyFilter = () => {
    setDateError(null);
    if (draftFrom === '' && draftTo === '') {
      onApply({ scope: draftScope, from: null, to: null });
      return;
    }
    if (draftFrom === '' || draftTo === '') {
      setDateError(translate('page.89b179c8814c'));
      return;
    }
    const range = zonedDateRangeToUtc(draftFrom, draftTo, timeZone);
    if (range === null) {
      setDateError(translate('page.97c433594a7b'));
      return;
    }
    onApply({ scope: draftScope, from: range.from, to: range.to });
  };
  const handleExport = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setExportError(null);
    try {
      await onExport({
        dataset: 'REPORTS',
        siteId: applied.scope.siteId,
        deviceId: applied.scope.deviceId ?? null,
        from: applied.from,
        to: applied.to,
      });
    } catch (err) {
      setExportError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  // region/subregion 客户端收窄（契约无 region 参数；siteId/deviceId 已由服务端过滤）
  const scopedRows =
    rows === null
      ? null
      : rows.filter((row) => {
          const scope = deviceScope[row.deviceId];
          if (scope === undefined) return applied.scope.region === null && applied.scope.subregion === null;
          if (applied.scope.region !== null && scope.region !== applied.scope.region) return false;
          if (applied.scope.subregion !== null && scope.subregion !== applied.scope.subregion) return false;
          return true;
        });
  const aggregated = scopedRows === null ? null : aggregateDeviceReports(scopedRows, period);
  return (
    <div className="esg-devices-page" data-testid="esg-devices-page">
      <p className="esg-disclaimer" data-testid="esg-disclaimer">
        {esgDisclaimer()}
        {translate('page.9ace0f4aaae7')}
      </p>

      <div className="filter-bar" data-testid="esg-device-filter">
        <ScopeFilter
          regions={scopeOptions.regions}
          subregions={scopeOptions.subregions}
          sites={scopeOptions.sites}
          devices={scopeOptions.devices}
          value={draftScope}
          onChange={setDraftScope}
          labels={{
            region: translate('page.17fc93c9cdbb'),
            subregion: translate('page.e1973949d60a'),
            site: translate('page.619bc67325a4'),
            device: translate('page.01f2c16cda65'),
          }}
        />
        <label htmlFor="esg-device-from">
          {translate('page.49f932b2f932')}
          {timeZone}）
        </label>
        <input
          id="esg-device-from"
          type="date"
          data-testid="esg-device-from-date"
          value={draftFrom}
          onChange={(event) => setDraftFrom(event.target.value)}
        />
        <label htmlFor="esg-device-to">{translate('page.9b3177f0b700')}</label>
        <input
          id="esg-device-to"
          type="date"
          data-testid="esg-device-to-date"
          value={draftTo}
          onChange={(event) => setDraftTo(event.target.value)}
        />
        <div
          className="period-toggle"
          role="group"
          aria-label={translate('page.bc3d16afc041')}
          data-testid="esg-device-period-toggle"
        >
          {ESG_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={period === p}
              className={period === p ? 'active' : ''}
              data-testid={`esg-device-period-${p}`}
              onClick={() => onPeriodChange(p)}
            >
              {ESG_PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
        <button type="button" className="primary-button" data-testid="esg-device-apply" onClick={applyFilter}>
          {translate('page.4562024ddec7')}
        </button>
        {dateError !== null ? (
          <p className="field-hint" data-testid="esg-device-date-error">
            {dateError}
          </p>
        ) : null}
      </div>

      {applied.from !== null && applied.to !== null ? (
        <p className="query-hint" data-testid="esg-device-query-hint">
          {translate('page.fb2ea9e2dfbf') + ' '}
          {timeZone}
          {' ' + translate('page.60d39b4be3b1')}
          {applied.from} ~ {applied.to}
        </p>
      ) : null}

      {exportError !== null ? <ErrorNotice error={exportError} onRefresh={onRefresh} /> : null}
      <ExportPanel
        testidPrefix="esg-device"
        canExport={canExport(role)}
        busy={busy}
        job={exportJob}
        onExport={() => void handleExport()}
        onCheckStatus={onCheckExport}
      />

      {listError !== undefined ? <ErrorNotice error={listError} onRefresh={onRefresh} /> : null}
      {aggregated === null || loading ? (
        <div role="status" data-testid="esg-device-loading">
          {translate('page.300ee3dee4dc')}
        </div>
      ) : aggregated.length === 0 ? (
        <p className="empty-state" data-testid="esg-device-empty">
          {translate('page.9af741292105')}
        </p>
      ) : (
        <div className="cursor-table">
          <table aria-label={translate('page.653b40d96d6e')} data-testid="esg-device-metrics">
            <thead>
              <tr>
                <th scope="col">{translate('page.01f2c16cda65')}</th>
                <th scope="col">
                  {ESG_PERIOD_LABELS[period]}
                  {translate('page.24cd18eefa93')}
                </th>
                <th scope="col">{translate('page.3da8cb889c76')}</th>
                <th scope="col">{translate('page.06e1915a18a1')}</th>
                <th scope="col">{translate('page.c466d61643c6')}</th>
                <th scope="col">{translate('page.d309c902a7bb')}</th>
                <th scope="col">O2{period === 'day' ? '' : translate('page.d1454ec0221e')} (%)</th>
                <th scope="col">CO2{period === 'day' ? '' : translate('page.d1454ec0221e')} (ppm)</th>
                <th scope="col">CH4{period === 'day' ? '' : translate('page.d1454ec0221e')} (ppm)</th>
                <th scope="col">N2O{period === 'day' ? '' : translate('page.d1454ec0221e')} (ppm)</th>
                <th scope="col">{translate('page.efd09f0f8785')}</th>
                <th scope="col">
                  {translate('page.8152ee3ec309')}
                  {period === 'day' ? '' : translate('page.c6546828511f')}
                </th>
                <th scope="col">{translate('page.9971a97635de')}</th>
              </tr>
            </thead>
            <tbody>
              {aggregated.map((row) => (
                <tr key={`${row.deviceId}-${row.bucket}`} data-testid={`esg-device-row-${row.deviceId}-${row.bucket}`}>
                  <td>{row.deviceId}</td>
                  <td>{row.bucket}</td>
                  <td>{formatKg(row.feedingWeightKg, language)}</td>
                  <td>{formatKg(row.dischargeWeightKg, language)}</td>
                  <td>{formatKg(row.reductionWeightKg, language)}</td>
                  <td>{formatKwh(row.powerConsumptionKwh, language)}</td>
                  <td>
                    {row.avgO2Pct === null ? (
                      '—'
                    ) : (
                      <PercentText
                        value={row.avgO2Pct}
                        digits={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }}
                      />
                    )}
                  </td>
                  <td>{formatPpm(row.avgCo2Ppm, language)}</td>
                  <td>{formatPpm(row.avgCh4Ppm, language)}</td>
                  <td>{formatPpm(row.avgN2oPpm, language)}</td>
                  <td>{formatKg(row.carbonReductionKg, language)}</td>
                  <td data-testid={`esg-device-completeness-${row.deviceId}-${row.bucket}`}>
                    {formatPct(row.avgCompletenessPct, language)}
                  </td>
                  <td>{calculationVersionText(row.versionIds, versions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
