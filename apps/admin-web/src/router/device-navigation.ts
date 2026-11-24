import type { DeviceListFilters } from '../pages/devices/DeviceGroupsPage.js';

const GROUP_PATH = '/devices/groups';
const GROUP_FILTERS_PARAM = 'groupFilters';
const GROUP_FILTER_KEYS = [
  'keyword',
  'region',
  'subregion',
  'siteId',
  'lifecycleStatus',
  'operationalStatus',
  'connectivity',
  'licenseStatus',
] as const satisfies readonly (keyof DeviceListFilters)[];
type DeviceWorkbench = '/configurations' | '/media' | '/alarms' | '/device-users' | '/licenses';

export function readDeviceGroupFilters(search: string): DeviceListFilters {
  const params = new URLSearchParams(search);
  return {
    keyword: params.get('keyword') ?? '',
    region: params.get('region'),
    subregion: params.get('subregion'),
    siteId: params.get('siteId'),
    lifecycleStatus: params.get('lifecycleStatus'),
    operationalStatus: params.get('operationalStatus'),
    connectivity: params.get('connectivity'),
    licenseStatus: params.get('licenseStatus'),
  };
}

function groupFilterQuery(filters: DeviceListFilters): string {
  const params = new URLSearchParams();
  for (const key of GROUP_FILTER_KEYS) {
    const value = filters[key];
    if (value !== null && value !== '') params.set(key, value);
  }
  return params.toString();
}

export function deviceGroupsPath(filters: DeviceListFilters): string {
  const query = groupFilterQuery(filters);
  return query ? `${GROUP_PATH}?${query}` : GROUP_PATH;
}

export function groupFiltersFromContext(search: string): string {
  const source = new URLSearchParams(search).get(GROUP_FILTERS_PARAM) ?? '';
  return groupFilterQuery(readDeviceGroupFilters(source));
}

export function deviceGroupsReturnPath(search: string): string {
  return deviceGroupsPath(readDeviceGroupFilters(groupFiltersFromContext(search)));
}

export function withGroupFilters(href: string, groupSearch: string): string {
  const filters = groupFilterQuery(readDeviceGroupFilters(groupSearch));
  if (!filters) return href;
  const [path, search] = href.split('?');
  const params = new URLSearchParams(search);
  params.set(GROUP_FILTERS_PARAM, filters);
  return `${path}?${params}`;
}

export function deviceWorkbenchPath(path: DeviceWorkbench, deviceId: string): string {
  const params = new URLSearchParams({ [path === '/alarms' ? 'scopeDeviceId' : 'deviceId']: deviceId });
  return `${path}?${params}`;
}

/** Null means no device context. An explicitly invalid context fails closed. */
export function deviceWorkbenchId(path: string, search: string): string | null {
  const params = new URLSearchParams(search);
  const keys =
    path === '/configurations'
      ? ['deviceId', 'targetDeviceId']
      : path === '/alarms'
        ? ['scopeDeviceId', 'deviceId']
        : path === '/media' || path === '/device-users' || path === '/licenses'
          ? ['deviceId']
          : [];
  const values = keys.flatMap((key) => params.getAll(key));
  const id = values[0];
  if (id === undefined) return null;
  return id.trim() === '' || values.some((value) => value !== id) ? '' : id;
}

export function licenseWorkbenchPath(context: { contractId?: string; deviceId?: string; licenseId?: string }): string {
  const params = new URLSearchParams();
  if (context.contractId) params.set('contractId', context.contractId);
  if (context.deviceId) params.set('deviceId', context.deviceId);
  if (context.licenseId) params.set('licenseId', context.licenseId);
  const query = params.toString();
  return query ? `/licenses?${query}` : '/licenses';
}

export function uniqueQueryId(search: string, key: string): string | null {
  const values = new URLSearchParams(search).getAll(key);
  return values.length === 0 ? null : values.length === 1 ? values[0]!.trim() : '';
}

export function sitesWorkbenchPath(context: { deviceId?: string; siteId?: string; customerId?: string } = {}): string {
  const params = new URLSearchParams();
  if (context.deviceId) params.set('deviceId', context.deviceId);
  if (context.siteId) params.set('siteId', context.siteId);
  if (context.customerId) params.set('customerId', context.customerId);
  const query = params.toString();
  return query ? `/devices/sites?${query}` : '/devices/sites';
}
