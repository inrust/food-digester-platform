import { Button, Input } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
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
import { NumberText } from '../../components/LocaleValue.js';
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
    readonly stale?: boolean;
    readonly dataUpdatedAt?: string;
    readonly hasPrevPage?: boolean;
  };
  /** 已应用的筛选（由集成层持有并用于请求）。 */
  readonly filters: DeviceListFilters;
  readonly onApplyFilters: (filters: DeviceListFilters) => void;
  readonly onLoadMore: (cursor: string) => void;
  readonly onLoadPrevious?: () => void;
  readonly onRefresh: () => void;
  /** ScopeFilter 选项（由 sites/devices 列表注入）。 */
  readonly filterOptions: {
    readonly regions: readonly FilterOption[];
    readonly subregions: readonly (FilterOption & {
      region: string;
    })[];
    readonly sites: readonly (FilterOption & {
      subregion: string;
    })[];
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
        <option value="">{translate('page.778fc8f99453')}</option>
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
  onLoadPrevious,
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
      <header className="page-header">
        <h1>{translate('design.page.device-group')}</h1>
      </header>
      <div className="filter-bar" data-testid="device-filter-bar">
        <span className="filter-field">
          <label htmlFor="device-keyword">{translate('page.621219ff9885')}</label>
          <Input
            id="device-keyword"
            data-testid="device-keyword"
            value={draft.keyword}
            placeholder={translate('page.766542953317')}
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
          translate('page.009200773b02'),
          draft.lifecycleStatus,
          LIFECYCLE_FILTER_OPTIONS,
          (v) => axisValueLabel('lifecycle', v),
          (v) => setDraft({ ...draft, lifecycleStatus: v }),
        )}
        {axisSelect(
          'filter-operational',
          translate('page.2a4080ad9f60'),
          draft.operationalStatus,
          OPERATIONAL_FILTER_OPTIONS,
          (v) => axisValueLabel('operational', v),
          (v) => setDraft({ ...draft, operationalStatus: v }),
        )}
        {axisSelect(
          'filter-connectivity',
          translate('page.b639d60c4140'),
          draft.connectivity,
          CONNECTIVITY_FILTER_OPTIONS,
          (v) => axisValueLabel('connectivity', v),
          (v) => setDraft({ ...draft, connectivity: v }),
        )}
        {axisSelect(
          'filter-license',
          translate('page.ac3cc79f9199'),
          draft.licenseStatus,
          LICENSE_FILTER_OPTIONS,
          (v) => LICENSE_FILTER_LABELS[v] ?? v,
          (v) => setDraft({ ...draft, licenseStatus: v }),
        )}
        <Button
          type="button"
          className="primary-button"
          data-testid="device-search"
          onClick={() => onApplyFilters(draft)}
        >
          {translate('page.f04090805c6e')}
        </Button>
        <Button
          type="button"
          data-testid="device-reset"
          onClick={() => {
            setDraft(EMPTY_DEVICE_FILTERS);
            onApplyFilters(EMPTY_DEVICE_FILTERS);
          }}
        >
          {translate('page.3d81345303ab')}
        </Button>
      </div>

      <CursorTable
        ariaLabel={translate('page.5a1abe45b505')}
        columns={[
          {
            key: 'seq',
            header: translate('page.6cd7c92cbd69'),
            render: (d) => (
              <span data-testid={`seq-${d.id}`}>
                <NumberText value={(list.rows?.indexOf(d) ?? 0) + 1} />
              </span>
            ),
          },
          { key: 'region', header: translate('page.406e0f8c6852'), render: (d) => d.site?.region ?? '—' },
          { key: 'subregion', header: translate('page.ff0beacd69e2'), render: (d) => d.site?.subregion ?? '—' },
          { key: 'deviceId', header: translate('page.d79416b3896a'), render: (d) => d.serialNumber },
          { key: 'alias', header: translate('page.270ec5a97320'), render: (d) => d.alias ?? '—' },
          { key: 'contractName', header: translate('page.0bb94d970554'), render: (d) => d.contract?.name ?? '—' },
          {
            key: 'leaseTerm',
            header: translate('page.b40bd0ccd7cd'),
            render: (d) =>
              d.contract !== null ? translate('page.43401e739ef4') + ' ' + d.contract.endAt.slice(0, 10) : '—',
          },
          { key: 'firmware', header: translate('page.d6ee5acd60f7'), render: (d) => d.firmwareVersion ?? '—' },
          {
            key: 'fourAxis',
            header: translate('page.62e951a692ff'),
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
            header: translate('page.f3ea6d345e2a'),
            render: (d) => (
              <Button
                type="button"
                data-testid={`manage-${d.id}`}
                onClick={() => onNavigate(`/devices/manage?deviceId=${encodeURIComponent(d.id)}`)}
              >
                {translate('page.4989b5cf9483')}
              </Button>
            ),
          },
        ]}
        rows={list.rows === null ? null : [...list.rows]}
        rowKey={(d) => d.id}
        {...(list.loading !== undefined ? { loading: list.loading } : {})}
        {...(list.error !== undefined ? { error: list.error } : {})}
        {...(list.nextCursor !== undefined ? { nextCursor: list.nextCursor } : {})}
        {...(list.stale !== undefined ? { stale: list.stale } : {})}
        {...(list.dataUpdatedAt !== undefined ? { dataUpdatedAt: list.dataUpdatedAt } : {})}
        {...(list.hasPrevPage !== undefined ? { hasPrevPage: list.hasPrevPage } : {})}
        onNextPage={onLoadMore}
        {...(onLoadPrevious !== undefined ? { onPrevPage: onLoadPrevious } : {})}
        onRefresh={onRefresh}
        emptyText={translate('page.2b9379b8f7b5')}
      />

      <h4>{translate('page.ac8962435f91')}</h4>
      <OnboardingReviewPanel {...onboarding} />
    </div>
  );
}
