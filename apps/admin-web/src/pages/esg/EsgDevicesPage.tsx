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
import type { Role } from '@fdp/auth';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { ScopeFilter } from '../../components/ScopeFilter.js';
import type { FilterOption, ScopeFilterProps } from '../../components/ScopeFilter.js';
import type { ScopeFilterValue } from '../../components/filter-state.js';
import { ExportPanel } from '../../components/ExportPanel.js';
import type { EsgQueryFilter } from './esg-api.js';
import {
  ESG_DISCLAIMER,
  ESG_PERIODS,
  ESG_PERIOD_LABELS,
  aggregateDeviceReports,
  calculationVersionText,
  canExport,
  formatKg,
  formatKwh,
  formatPct,
  formatPpm,
  zonedDateRangeToUtc,
} from './esg-state.js';
import type { EsgPeriod } from './esg-state.js';
import type { EsgCalculationVersionView, EsgExportJobView, EsgReportView } from './types.js';

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
  readonly deviceScope: Readonly<Record<string, { readonly region: string; readonly subregion: string }>>;
  readonly applied: EsgDeviceAppliedQuery;
  readonly onApply: (next: EsgDeviceAppliedQuery) => void;
  readonly rows: readonly EsgReportView[] | null;
  readonly loading?: boolean;
  readonly listError?: unknown;
  readonly versions: readonly EsgCalculationVersionView[] | null;
  readonly exportJob: EsgExportJobView | null;
  readonly onExport: (snapshot: EsgQueryFilter & { dataset: 'REPORTS' }) => Promise<unknown>;
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
      setDateError('起止日期须同时填写');
      return;
    }
    const range = zonedDateRangeToUtc(draftFrom, draftTo, timeZone);
    if (range === null) {
      setDateError('日期格式非法或起始晚于截止');
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
        {ESG_DISCLAIMER}：气体与碳减排为带计算版本的估算值，不构成任何认证结论。
      </p>

      <div className="filter-bar" data-testid="esg-device-filter">
        <ScopeFilter
          regions={scopeOptions.regions}
          subregions={scopeOptions.subregions}
          sites={scopeOptions.sites}
          devices={scopeOptions.devices}
          value={draftScope}
          onChange={setDraftScope}
          labels={{ region: '区域', subregion: '子区域', site: '站点', device: '设备' }}
        />
        <label htmlFor="esg-device-from">起始日期（{timeZone}）</label>
        <input
          id="esg-device-from"
          type="date"
          data-testid="esg-device-from-date"
          value={draftFrom}
          onChange={(event) => setDraftFrom(event.target.value)}
        />
        <label htmlFor="esg-device-to">截止日期</label>
        <input
          id="esg-device-to"
          type="date"
          data-testid="esg-device-to-date"
          value={draftTo}
          onChange={(event) => setDraftTo(event.target.value)}
        />
        <div className="period-toggle" role="group" aria-label="日/周/月切换" data-testid="esg-device-period-toggle">
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
          应用
        </button>
        {dateError !== null ? (
          <p className="field-hint" data-testid="esg-device-date-error">
            {dateError}
          </p>
        ) : null}
      </div>

      {applied.from !== null && applied.to !== null ? (
        <p className="query-hint" data-testid="esg-device-query-hint">
          按 {timeZone} 日历日转 UTC 查询：{applied.from} ~ {applied.to}
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
          加载中…
        </div>
      ) : aggregated.length === 0 ? (
        <p className="empty-state" data-testid="esg-device-empty">
          暂无设备 ESG 数据
        </p>
      ) : (
        <table aria-label="设备 ESG 指标" data-testid="esg-device-metrics">
          <thead>
            <tr>
              <th scope="col">设备</th>
              <th scope="col">{ESG_PERIOD_LABELS[period]}期间</th>
              <th scope="col">投料 (kg)</th>
              <th scope="col">出料 (kg)</th>
              <th scope="col">减量 (kg)</th>
              <th scope="col">能耗 (kWh)</th>
              <th scope="col">O2{period === 'day' ? '' : '平均'} (%)</th>
              <th scope="col">CO2{period === 'day' ? '' : '平均'} (ppm)</th>
              <th scope="col">CH4{period === 'day' ? '' : '平均'} (ppm)</th>
              <th scope="col">N2O{period === 'day' ? '' : '平均'} (ppm)</th>
              <th scope="col">估算 CO2e (kg)</th>
              <th scope="col">完整率{period === 'day' ? '' : '（平均）'}</th>
              <th scope="col">计算版本</th>
            </tr>
          </thead>
          <tbody>
            {aggregated.map((row) => (
              <tr key={`${row.deviceId}-${row.bucket}`} data-testid={`esg-device-row-${row.deviceId}-${row.bucket}`}>
                <td>{row.deviceId}</td>
                <td>{row.bucket}</td>
                <td>{formatKg(row.feedingWeightKg)}</td>
                <td>{formatKg(row.dischargeWeightKg)}</td>
                <td>{formatKg(row.reductionWeightKg)}</td>
                <td>{formatKwh(row.powerConsumptionKwh)}</td>
                <td>{row.avgO2Pct === null ? '—' : `${row.avgO2Pct.toFixed(1)}%`}</td>
                <td>{formatPpm(row.avgCo2Ppm)}</td>
                <td>{formatPpm(row.avgCh4Ppm)}</td>
                <td>{formatPpm(row.avgN2oPpm)}</td>
                <td>{formatKg(row.carbonReductionKg)}</td>
                <td data-testid={`esg-device-completeness-${row.deviceId}-${row.bucket}`}>{formatPct(row.avgCompletenessPct)}</td>
                <td>{calculationVersionText(row.versionIds, versions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
