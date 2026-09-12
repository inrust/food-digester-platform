/**
 * FE-09 Device User API 装配（BE-DUSR-01/02）。
 *
 * - DEC-004：password 只在 create/update 请求体出现一次（受控提交），类型层不回读；
 *   绝不提交预计算 Hash（契约 400 明文密码字段/Hash 提交校验由服务端兜底）；
 * - update/disable/assign/revoke 均 If-Match=version（数值乐观锁）+ 强制原因；
 * - assign/revoke 为批量全成或全败；停用用户不进入新 Sync。
 */
import type { ApiClient } from '../../api/http-client.js';
import type {
  AssignResultView,
  DeviceUserDetailView,
  DeviceUserListItemView,
  DeviceUserView,
  RevokeResultView,
} from './types.js';

export interface DeviceUserListFilter {
  readonly customerId?: string;
  readonly region?: string;
  readonly subregion?: string;
  readonly deviceId?: string;
  readonly status?: 'ACTIVE' | 'DISABLED';
  readonly keyword?: string;
}

export async function fetchDeviceUsers(
  api: ApiClient,
  filter: DeviceUserListFilter = {},
): Promise<readonly DeviceUserListItemView[]> {
  const params = new URLSearchParams();
  if (filter.customerId !== undefined && filter.customerId !== '') params.set('customerId', filter.customerId);
  if (filter.region !== undefined && filter.region !== '') params.set('region', filter.region);
  if (filter.subregion !== undefined && filter.subregion !== '') params.set('subregion', filter.subregion);
  if (filter.deviceId !== undefined && filter.deviceId !== '') params.set('deviceId', filter.deviceId);
  if (filter.status !== undefined) params.set('status', filter.status);
  if (filter.keyword !== undefined && filter.keyword !== '') params.set('keyword', filter.keyword);
  const query = params.toString();
  const response = await api.request<{ data: DeviceUserListItemView[] }>(
    `/admin/device-users${query === '' ? '' : `?${query}`}`,
  );
  return response.data;
}

export async function createDeviceUser(
  api: ApiClient,
  input: { customerId?: string; username: string; displayName?: string; password: string; reason?: string },
): Promise<DeviceUserView> {
  const body: Record<string, string> = { username: input.username, password: input.password };
  if (input.customerId !== undefined && input.customerId !== '') body['customerId'] = input.customerId;
  if (input.displayName !== undefined && input.displayName !== '') body['displayName'] = input.displayName;
  if (input.reason !== undefined && input.reason !== '') body['reason'] = input.reason;
  const response = await api.request<{ data: DeviceUserView }>('/admin/device-users', { method: 'POST', body });
  return response.data;
}

export async function fetchDeviceUser(api: ApiClient, deviceUserId: string): Promise<DeviceUserDetailView> {
  const response = await api.request<{ data: DeviceUserDetailView }>(
    `/admin/device-users/${encodeURIComponent(deviceUserId)}`,
  );
  return response.data;
}

/** 修改资料或轮换设备本地密码（If-Match=version；displayName/password 至少一项由页面保证）。 */
export async function updateDeviceUser(
  api: ApiClient,
  deviceUserId: string,
  version: number,
  input: { displayName?: string | null; password?: string; reason: string },
): Promise<DeviceUserView> {
  const body: Record<string, unknown> = { reason: input.reason };
  if (input.displayName !== undefined) body['displayName'] = input.displayName;
  if (input.password !== undefined && input.password !== '') body['password'] = input.password;
  const response = await api.request<{ data: DeviceUserView }>(
    `/admin/device-users/${encodeURIComponent(deviceUserId)}`,
    { method: 'PATCH', ifMatch: version, body },
  );
  return response.data;
}

export async function disableDeviceUser(
  api: ApiClient,
  deviceUserId: string,
  version: number,
  reason: string,
): Promise<DeviceUserView> {
  const response = await api.request<{ data: DeviceUserView }>(
    `/admin/device-users/${encodeURIComponent(deviceUserId)}/disable`,
    { method: 'POST', ifMatch: version, body: { reason } },
  );
  return response.data;
}

export async function assignDeviceUser(
  api: ApiClient,
  deviceUserId: string,
  version: number,
  deviceIds: readonly string[],
  reason: string,
): Promise<AssignResultView> {
  const response = await api.request<{ data: AssignResultView }>(
    `/admin/device-users/${encodeURIComponent(deviceUserId)}/assignments`,
    { method: 'POST', ifMatch: version, body: { deviceIds: [...deviceIds], reason } },
  );
  return response.data;
}

export async function revokeDeviceUser(
  api: ApiClient,
  deviceUserId: string,
  version: number,
  deviceIds: readonly string[],
  reason: string,
): Promise<RevokeResultView> {
  const response = await api.request<{ data: RevokeResultView }>(
    `/admin/device-users/${encodeURIComponent(deviceUserId)}/assignments/revoke`,
    { method: 'POST', ifMatch: version, body: { deviceIds: [...deviceIds], reason } },
  );
  return response.data;
}
