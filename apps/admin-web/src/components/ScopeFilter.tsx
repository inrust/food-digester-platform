import { Button } from './ui.js';
import { translate } from '../i18n/i18n.js';
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
  readonly subregions: readonly (FilterOption & {
    readonly region: string;
  })[];
  readonly sites: readonly (FilterOption & {
    readonly subregion: string;
  })[];
  /** FE-05：可选 Device 层级（按 siteId 过滤）。 */
  readonly devices?: readonly (FilterOption & {
    readonly siteId: string;
  })[];
  readonly value: ScopeFilterValue;
  readonly onChange: (next: ScopeFilterValue) => void;
  readonly labels?: {
    region: string;
    subregion: string;
    site: string;
    device: string;
  };
}
const DEFAULT_LABELS = {
  get region() {
    return translate('page.406e0f8c6852');
  },
  get subregion() {
    return translate('page.ff0beacd69e2');
  },
  get site() {
    return translate('page.619bc67325a4');
  },
  get device() {
    return translate('page.01f2c16cda65');
  },
} as const;
export function ScopeFilter({
  regions,
  subregions,
  sites,
  devices,
  value,
  onChange,
  labels = DEFAULT_LABELS,
}: ScopeFilterProps) {
  const visibleSubregions = value.region === null ? [] : subregions.filter((s) => s.region === value.region);
  const visibleSites = value.subregion === null ? [] : sites.filter((s) => s.subregion === value.subregion);
  const visibleDevices = value.siteId === null ? [] : (devices ?? []).filter((d) => d.siteId === value.siteId);
  return (
    <div className="scope-filter" data-testid="scope-filter">
      <div className="filter-field">
        <label htmlFor="scope-region">{labels.region}</label>
        <select
          id="scope-region"
          value={value.region ?? ''}
          onChange={(event) => onChange(applyScopeChange(value, 'region', event.target.value || null))}
        >
          <option value="">{translate('page.778fc8f99453')}</option>
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
          <option value="">{translate('page.778fc8f99453')}</option>
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
          <option value="">{translate('page.778fc8f99453')}</option>
          {visibleSites.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {devices !== undefined ? (
        <div className="filter-field">
          <label htmlFor="scope-device">{labels.device}</label>
          <select
            id="scope-device"
            value={value.deviceId ?? ''}
            disabled={value.siteId === null}
            onChange={(event) => onChange(applyScopeChange(value, 'deviceId', event.target.value || null))}
          >
            <option value="">{translate('page.778fc8f99453')}</option>
            {visibleDevices.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <Button type="button" onClick={() => onChange({ region: null, subregion: null, siteId: null, deviceId: null })}>
        {translate('page.3d81345303ab')}
      </Button>
    </div>
  );
}
