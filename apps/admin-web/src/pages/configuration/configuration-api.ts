/**
 * FE-09 Configuration API 装配（BE-CFG-01）。
 *
 * - payload 为 DEC-018@1.0.0 四字段完整快照；前端仅提交四字段（派生字段/候选扩展/网络字段
 *   不进入表单，提交即 400 由服务端兜底）；
 * - 发布：DRAFT→PUBLISHED，历史版本不可覆盖（重复发布 → 409 由页面呈现）；
 * - 同步状态：CONFIG_CHANGED Outbox 投递状态（设备确认回执由 BE-SYNC-01 lastSyncTime 补齐）。
 */
import type { ApiClient } from '../../api/http-client.js';
import type {
  ConfigurationDetailView,
  ConfigurationPublishResultView,
  ConfigurationSummaryView,
  ConfigurationSyncStatusView,
  ConfigurationVersionView,
  ConfigurationPayloadView,
} from './types.js';

export interface ConfigurationListFilter {
  readonly targetModel?: string;
  readonly targetDeviceId?: string;
}

export async function fetchConfigurations(
  api: ApiClient,
  filter: ConfigurationListFilter = {},
): Promise<readonly ConfigurationSummaryView[]> {
  const params = new URLSearchParams();
  if (filter.targetModel !== undefined && filter.targetModel !== '') params.set('targetModel', filter.targetModel);
  if (filter.targetDeviceId !== undefined && filter.targetDeviceId !== '') params.set('targetDeviceId', filter.targetDeviceId);
  const query = params.toString();
  const response = await api.request<{ data: ConfigurationSummaryView[] }>(
    `/admin/configurations${query === '' ? '' : `?${query}`}`,
  );
  return response.data;
}

export async function createConfiguration(
  api: ApiClient,
  input: { name: string; targetModel?: string; targetDeviceId?: string; reason?: string },
): Promise<ConfigurationSummaryView> {
  const body: Record<string, string> = { name: input.name };
  if (input.targetModel !== undefined && input.targetModel !== '') body['targetModel'] = input.targetModel;
  if (input.targetDeviceId !== undefined && input.targetDeviceId !== '') body['targetDeviceId'] = input.targetDeviceId;
  if (input.reason !== undefined && input.reason !== '') body['reason'] = input.reason;
  const response = await api.request<{ data: ConfigurationSummaryView }>('/admin/configurations', {
    method: 'POST',
    body,
  });
  return response.data;
}

function configurationPath(configurationId: string): string {
  return `/admin/configurations/${encodeURIComponent(configurationId)}`;
}

export async function fetchConfiguration(api: ApiClient, configurationId: string): Promise<ConfigurationDetailView> {
  const response = await api.request<{ data: ConfigurationDetailView }>(configurationPath(configurationId));
  return response.data;
}

export async function createConfigurationVersion(
  api: ApiClient,
  configurationId: string,
  input: { payload: ConfigurationPayloadView; changeNote?: string; reason?: string },
): Promise<ConfigurationVersionView> {
  const body: Record<string, unknown> = { payload: input.payload };
  if (input.changeNote !== undefined && input.changeNote !== '') body['changeNote'] = input.changeNote;
  if (input.reason !== undefined && input.reason !== '') body['reason'] = input.reason;
  const response = await api.request<{ data: ConfigurationVersionView }>(
    `${configurationPath(configurationId)}/versions`,
    { method: 'POST', body },
  );
  return response.data;
}

export async function publishConfigurationVersion(
  api: ApiClient,
  configurationId: string,
  version: number,
  input: { effectiveAt?: string; reason?: string } = {},
): Promise<ConfigurationPublishResultView> {
  const body: Record<string, string> = {};
  if (input.effectiveAt !== undefined && input.effectiveAt !== '') body['effectiveAt'] = input.effectiveAt;
  if (input.reason !== undefined && input.reason !== '') body['reason'] = input.reason;
  const response = await api.request<{ data: ConfigurationPublishResultView }>(
    `${configurationPath(configurationId)}/versions/${version}/publish`,
    { method: 'POST', body },
  );
  return response.data;
}

export async function fetchConfigurationVersionStatus(
  api: ApiClient,
  configurationId: string,
  version: number,
): Promise<ConfigurationSyncStatusView> {
  const response = await api.request<{ data: ConfigurationSyncStatusView }>(
    `${configurationPath(configurationId)}/versions/${version}/status`,
  );
  return response.data;
}
