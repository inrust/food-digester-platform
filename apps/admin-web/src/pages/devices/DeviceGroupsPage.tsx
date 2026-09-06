/**
 * FE-06 设备群管理页（/devices/groups）：设备台账列表 + 新增设备请求（FE-04 面板嵌入）。
 *
 * 列与 CT-06 对齐：序号/设备区域/设备子区域/设备唯一ID/设备别名/关联合约名称/租期期限/软件版本/
 * 四轴状态徽标（DEC-010，替代被 Reject 的“是否启用/启用状态”）/操作（管理 → /devices/manage）。
 * 筛选：关键字 + Region/Subregion/Site（ScopeFilter）+ 四轴状态 + 授权状态；搜索/重置。
 */
import { useState } from 'react';
import { axisValueLabel, FourAxisBadges } from '../../components/FourAxisBadge.js';
import { CursorTable } from '../../components/CursorTable.js';
import { ScopeFilter } from '../../components/ScopeFilter.js';
import type { FilterOption } from '../../components/ScopeFilter.js';
import type { ScopeFilterValue } from '../../components/filter-state.js';
import type { OnboardingReviewPanelProps } from '../onboarding/OnboardingReviewPanel.js';
import { OnboardingReviewPanel } from '../onboarding/OnboardingReviewPanel.js';
import {
  CONNECTIVITY_FILTER_OPTIONS,
  LICENSE_FILTER_LABELS,
  LICENSE_FILTER_OPTIONS,
  LIFECYCLE_FILTER_OPTIONS,
  OPERATIONAL_FILTER_OPTIONS,
} from './device-state.js';
import type { DeviceView } from './types.js';

export interface DeviceListFilters {
  readonly keyword: string;
  readonly region: string | null;
  readonly subregion: string | null;
  readonly siteId: string | null;
  readonly lifecycleStatus: string | null;
  readonly operationalStatus: string | null;
  readonly connectivity: string | null;
  readonly licenseStatus: string | null;
}

export const EMPTY_DEVICE_FILTERS: DeviceListFilters = {
  keyword: '',
  region: null,
  subregion: null,
  siteId: null,
  lifecycleStatus: null,
  operationalStatus: null,
  connectivity: null,
  licenseStatus: null,
};

export interface DeviceGroupsPageProps {
  readonly list: {
    readonly rows: readonly DeviceView[] | null;
    readonly loading?: boolean;
    readonly error?: unknown;
    readonly nextCursor?: string | null;
  };
  /** 已应用的筛选（由集成层持有并用于请求）。 */
  readonly filters: DeviceListFilters;
  readonly onApplyFilters: (filters: DeviceListFilters) => void;
  readonly onLoadMore: (cursor: string) => void;
  readonly onRefresh: () => void;
  /** ScopeFilter 选项（由 sites/devices 列表注入）。 */
  readonly filterOptions: {
    readonly regions: readonly FilterOption[];
    readonly subregions: readonly (FilterOption & { region: string })[];
    readonly sites: readonly (FilterOption & { subregion: string })[];
  };
  readonly onNavigate: (path: string) => void;
  /** FE-04 审批面板（嵌入本页“新增设备请求”区域）。 */
  readonly onboarding: OnboardingReviewPanelProps;
}

function axisSelect(
  id: string,
  label: string,
  value: string | null,
  options: readonly string[],
  labels: (v: string) => string,
  onChange: (v: string | null) => void,
) {
  return (
    <span className="filter-field" key={id}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        data-testid={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      >
        <option value="">全部</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {labels(option)}
          </option>
        ))}
      </select>
    </span>
  );
}

export function DeviceGroupsPage({
  list,
  filters,
  onApplyFilters,
  onLoadMore,
  onRefresh,
  filterOptions,
  onNavigate,
  onboarding,
}: DeviceGroupsPageProps) {
  // 草稿筛选：应用后才生效（device-group.button.search 语义）
  const [draft, setDraft] = useState<DeviceListFilters>(filters);

  const scopeValue: ScopeFilterValue = {
    region: draft.region,
    subregion: draft.subregion,
    siteId: draft.siteId,
    deviceId: null,
  };

  return (
    <div className="device-groups-page" data-testid="device-groups-page">
      <div className="filter-bar" data-testid="device-filter-bar">
        <span className="filter-field">
          <label htmlFor="device-keyword">关键字</label>
          <input
            id="device-keyword"
            data-testid="device-keyword"
            value={draft.keyword}
            placeholder="序列号 / 别名"
            onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
          />
        </span>
        <ScopeFilter
          regions={filterOptions.regions}
          subregions={filterOptions.subregions}
          sites={filterOptions.sites}
          value={scopeValue}
          onChange={(next) =>
            setDraft({ ...draft, region: next.region, subregion: next.subregion, siteId: next.siteId })
          }
        />
        {axisSelect(
          'filter-lifecycle',
          '生命周期',
          draft.lifecycleStatus,
          LIFECYCLE_FILTER_OPTIONS,
          (v) => axisValueLabel('lifecycle', v),
          (v) => setDraft({ ...draft, lifecycleStatus: v }),
        )}
        {axisSelect(
          'filter-operational',
          '运行状态',
          draft.operationalStatus,
          OPERATIONAL_FILTER_OPTIONS,
          (v) => axisValueLabel('operational', v),
          (v) => setDraft({ ...draft, operationalStatus: v }),
        )}
        {axisSelect(
          'filter-connectivity',
          '连接状态',
          draft.connectivity,
          CONNECTIVITY_FILTER_OPTIONS,
          (v) => axisValueLabel('connectivity', v),
          (v) => setDraft({ ...draft, connectivity: v }),
        )}
        {axisSelect(
          'filter-license',
          '授权状态',
          draft.licenseStatus,
          LICENSE_FILTER_OPTIONS,
          (v) => LICENSE_FILTER_LABELS[v] ?? v,
          (v) => setDraft({ ...draft, licenseStatus: v }),
        )}
        <button
          type="button"
          className="primary-button"
          data-testid="device-search"
          onClick={() => onApplyFilters(draft)}
        >
          搜索
        </button>
        <button
          type="button"
          data-testid="device-reset"
          onClick={() => {
            setDraft(EMPTY_DEVICE_FILTERS);
            onApplyFilters(EMPTY_DEVICE_FILTERS);
          }}
        >
          重置
        </button>
      </div>

      <CursorTable
        ariaLabel="设备群列表"
        columns={[
          {
            key: 'seq',
            header: '序号',
            render: (d) => <span data-testid={`seq-${d.id}`}>{(list.rows?.indexOf(d) ?? 0) + 1}</span>,
          },
          { key: 'region', header: '设备区域', render: (d) => d.site?.region ?? '—' },
          { key: 'subregion', header: '设备子区域', render: (d) => d.site?.subregion ?? '—' },
          { key: 'deviceId', header: '设备唯一ID', render: (d) => d.serialNumber },
          { key: 'alias', header: '设备别名', render: (d) => d.alias ?? '—' },
          { key: 'contractName', header: '关联合约名称', render: (d) => d.contract?.name ?? '—' },
          {
            key: 'leaseTerm',
            header: '租期期限',
            render: (d) => (d.contract !== null ? `至 ${d.contract.endAt.slice(0, 10)}` : '—'),
          },
          { key: 'firmware', header: '软件版本', render: (d) => d.firmwareVersion ?? '—' },
          {
            key: 'fourAxis',
            header: '状态',
            render: (d) => (
              <FourAxisBadges
                status={{
                  connectivity: d.connectivity,
                  lifecycle: d.lifecycleStatus,
                  operational: d.operationalStatus,
                  license: d.license?.status ?? null,
                }}
              />
            ),
          },
          {
            key: 'actions',
            header: '操作',
            render: (d) => (
              <button
                type="button"
                data-testid={`manage-${d.id}`}
                onClick={() => onNavigate(`/devices/manage?deviceId=${encodeURIComponent(d.id)}`)}
              >
                管理
              </button>
            ),
          },
        ]}
        rows={list.rows === null ? null : [...list.rows]}
        rowKey={(d) => d.id}
        {...(list.loading !== undefined ? { loading: list.loading } : {})}
        {...(list.error !== undefined ? { error: list.error } : {})}
        {...(list.nextCursor !== undefined ? { nextCursor: list.nextCursor } : {})}
        onNextPage={onLoadMore}
        onRefresh={onRefresh}
        emptyText="暂无设备"
      />

      <h4>新增设备请求</h4>
      <OnboardingReviewPanel {...onboarding} />
    </div>
  );
}
