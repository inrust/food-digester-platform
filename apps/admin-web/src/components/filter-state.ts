/**
 * FE-02 联动筛选状态（Region → Subregion → Site，纯逻辑便于无 DOM 测试）。
 * 上游变更清空下游选择（DEC-011：Region/Subregion 为 Site 属性）。
 */

export interface ScopeFilterValue {
  readonly region: string | null;
  readonly subregion: string | null;
  readonly siteId: string | null;
  /** FE-05：可选 Device 层级（Region→Subregion→Site→Device 联动）。 */
  readonly deviceId?: string | null;
}

export const EMPTY_SCOPE_FILTER: ScopeFilterValue = { region: null, subregion: null, siteId: null, deviceId: null };

export type ScopeFilterLevel = keyof ScopeFilterValue;

export function applyScopeChange(
  value: ScopeFilterValue,
  level: ScopeFilterLevel,
  next: string | null,
): ScopeFilterValue {
  switch (level) {
    case 'region':
      return { region: next, subregion: null, siteId: null, deviceId: null };
    case 'subregion':
      return { ...value, subregion: next, siteId: null, deviceId: null };
    case 'siteId':
      return { ...value, siteId: next, deviceId: null };
    case 'deviceId':
      return { ...value, deviceId: next };
  }
}
