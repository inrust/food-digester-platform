/**
 * FE-02 联动 Region/Subregion/Site 筛选：选项按上游选择过滤，上游变更清空下游。
 * 每个下拉均有显式 <label htmlFor>；提供“重置”。
 */
import { applyScopeChange } from './filter-state.js';
import type { ScopeFilterValue } from './filter-state.js';

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface ScopeFilterProps {
  readonly regions: readonly FilterOption[];
  readonly subregions: readonly (FilterOption & { readonly region: string })[];
  readonly sites: readonly (FilterOption & { readonly subregion: string })[];
  readonly value: ScopeFilterValue;
  readonly onChange: (next: ScopeFilterValue) => void;
  readonly labels?: { region: string; subregion: string; site: string };
}

const DEFAULT_LABELS = { region: '设备区域', subregion: '设备子区域', site: '站点' } as const;

export function ScopeFilter({
  regions,
  subregions,
  sites,
  value,
  onChange,
  labels = DEFAULT_LABELS,
}: ScopeFilterProps) {
  const visibleSubregions = value.region === null ? [] : subregions.filter((s) => s.region === value.region);
  const visibleSites = value.subregion === null ? [] : sites.filter((s) => s.subregion === value.subregion);

  return (
    <div className="scope-filter" data-testid="scope-filter">
      <div className="filter-field">
        <label htmlFor="scope-region">{labels.region}</label>
        <select
          id="scope-region"
          value={value.region ?? ''}
          onChange={(event) => onChange(applyScopeChange(value, 'region', event.target.value || null))}
        >
          <option value="">全部</option>
          {regions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-field">
        <label htmlFor="scope-subregion">{labels.subregion}</label>
        <select
          id="scope-subregion"
          value={value.subregion ?? ''}
          disabled={value.region === null}
          onChange={(event) => onChange(applyScopeChange(value, 'subregion', event.target.value || null))}
        >
          <option value="">全部</option>
          {visibleSubregions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-field">
        <label htmlFor="scope-site">{labels.site}</label>
        <select
          id="scope-site"
          value={value.siteId ?? ''}
          disabled={value.subregion === null}
          onChange={(event) => onChange(applyScopeChange(value, 'siteId', event.target.value || null))}
        >
          <option value="">全部</option>
          {visibleSites.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <button type="button" onClick={() => onChange({ region: null, subregion: null, siteId: null })}>
        重置
      </button>
    </div>
  );
}
