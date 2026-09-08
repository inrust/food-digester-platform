/**
 * FE-10 Alarm/Event/Tamper API 装配（BE-ALM-01）。
 * 列表均为键集游标分页（id ASC，PageMeta.nextCursor）；确认/清除强制原因（AlarmReasonBody）。
 */
import type { ApiClient } from '../../api/http-client.js';
import type { AlarmHandleResultView, AlarmView, DeviceEventView, TamperEventView } from './types.js';
import type { AlarmSeverity, AlarmStatus } from './types.js';

export interface Page<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
}

export interface AlarmListFilter {
  readonly customerId?: string | null;
  readonly siteId?: string | null;
  readonly deviceId?: string | null;
  readonly severity?: AlarmSeverity | null;
  readonly status?: AlarmStatus | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

export interface EventListFilter {
  readonly customerId?: string | null;
  readonly siteId?: string | null;
  readonly deviceId?: string | null;
  readonly eventType?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

export interface TamperListFilter {
  readonly customerId?: string | null;
  readonly siteId?: string | null;
  readonly deviceId?: string | null;
  readonly eventType?: string | null;
  readonly severity?: AlarmSeverity | null;
  readonly from?: string | null;
  readonly to?: string | null;
}

function buildQuery(filter: Record<string, string | null | undefined>, cursor?: string): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, value);
  }
  if (cursor !== undefined && cursor !== '') params.set('cursor', cursor);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

async function fetchPage<T>(api: ApiClient, path: string): Promise<Page<T>> {
  const response = await api.request<{ data: T[]; meta: { nextCursor: string | null } }>(path);
  return { rows: response.data, nextCursor: response.meta.nextCursor };
}

export async function fetchAlarms(api: ApiClient, filter: AlarmListFilter, cursor?: string): Promise<Page<AlarmView>> {
  return fetchPage<AlarmView>(api, `/admin/alarms${buildQuery({ ...filter }, cursor)}`);
}

export async function fetchAlarm(api: ApiClient, alarmId: string): Promise<AlarmView> {
  const response = await api.request<{ data: AlarmView }>(`/admin/alarms/${encodeURIComponent(alarmId)}`);
  return response.data;
}

export async function acknowledgeAlarm(
  api: ApiClient,
  alarmId: string,
  reason: string,
): Promise<AlarmHandleResultView> {
  const response = await api.request<{ data: AlarmHandleResultView }>(
    `/admin/alarms/${encodeURIComponent(alarmId)}/acknowledge`,
    { method: 'POST', body: { reason } },
  );
  return response.data;
}

export async function clearAlarm(api: ApiClient, alarmId: string, reason: string): Promise<AlarmHandleResultView> {
  const response = await api.request<{ data: AlarmHandleResultView }>(
    `/admin/alarms/${encodeURIComponent(alarmId)}/clear`,
    { method: 'POST', body: { reason } },
  );
  return response.data;
}

export async function fetchDeviceEvents(
  api: ApiClient,
  filter: EventListFilter,
  cursor?: string,
): Promise<Page<DeviceEventView>> {
  return fetchPage<DeviceEventView>(api, `/admin/events${buildQuery({ ...filter }, cursor)}`);
}

export async function fetchTamperEvents(
  api: ApiClient,
  filter: TamperListFilter,
  cursor?: string,
): Promise<Page<TamperEventView>> {
  return fetchPage<TamperEventView>(api, `/admin/tamper-events${buildQuery({ ...filter }, cursor)}`);
}
