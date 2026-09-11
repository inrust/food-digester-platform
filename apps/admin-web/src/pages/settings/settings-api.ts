/**
 * FE-16 业务设置 API 装配（BE-SET-01）。
 *
 * - 封闭 key 集四项（未知 key → 404）；更新乐观锁：请求体回传当前 version，不匹配 → 409；
 * - 不得经本 API 改写固定协议枚举、Topic、DEC-023 确认方式或 AWS 运维配置
 *   （前端 command.confirmation 只读，见 settings-state.ts）。
 */
import type { ApiClient } from '../../api/http-client.js';
import type { SettingKey, SettingView } from './types.js';

export async function listSettings(api: ApiClient): Promise<readonly SettingView[]> {
  const response = await api.request<{ data: SettingView[] }>('/admin/settings');
  return response.data;
}

export async function getSetting(api: ApiClient, key: SettingKey): Promise<SettingView> {
  const response = await api.request<{ data: SettingView }>(`/admin/settings/${encodeURIComponent(key)}`);
  return response.data;
}

export async function updateSetting(
  api: ApiClient,
  key: SettingKey,
  value: unknown,
  version: number,
): Promise<SettingView> {
  const response = await api.request<{ data: SettingView }>(`/admin/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: { value, version },
  });
  return response.data;
}
