import { translate } from '../../i18n/i18n.js';
/**
 * FE-12 Remote Command API 装配（BE-CMD-01/03、BE-DEV-05）。
 *
 * - createDeviceCommand：meta.id 幂等键由装配层生成/透传（commandId 可选）；高风险命令
 *   的 confirmation.confirmText 必须等于命令名；近期认证时间由服务端从 JWT auth_time 取得；
 * - requestedBy 不信任客户端声明（请求体不含该字段）；
 * - 活动日志导出为异步任务（冻结筛选快照；过期链接 urlExpired=true 且 downloadUrl=null）。
 */
import type { ApiClient } from '../../api/http-client.js';
import type {
  ActivityExportView,
  ActivityItemView,
  ActivityKind,
  ActivityLevel,
  CommandDetailView,
  CommandListItemView,
  CommandName,
  CommandStatus,
  CommandView,
} from './types.js';
import { isSubmittableCommand } from './command-state.js';
export interface CommandCreateInput {
  readonly command: CommandName;
  readonly timeoutSec: number;
  readonly remarks?: string;
  /** DEC-006 幂等键（缺省由服务器生成）。 */
  readonly commandId?: string;
  /** DEC-023 高风险命令显式确认（近期重新认证由服务端可信 JWT 判定）。 */
  readonly confirmation?: {
    confirmText: string;
  };
}
export async function createDeviceCommand(
  api: ApiClient,
  deviceId: string,
  input: CommandCreateInput,
): Promise<CommandView> {
  if (!isSubmittableCommand(input.command)) {
    throw new Error(translate('ui.2db03f533ab1'));
  }
  const body: Record<string, unknown> = { command: input.command, timeoutSec: input.timeoutSec };
  if (input.remarks !== undefined && input.remarks !== '') body['remarks'] = input.remarks;
  if (input.commandId !== undefined) body['commandId'] = input.commandId;
  if (input.confirmation !== undefined) body['confirmation'] = input.confirmation;
  const response = await api.request<{
    data: CommandView;
  }>(`/admin/devices/${encodeURIComponent(deviceId)}/commands`, {
    method: 'POST',
    body,
  });
  return response.data;
}
export interface CommandListFilter {
  readonly customerId?: string | null;
  readonly deviceId?: string | null;
  readonly status?: CommandStatus | null;
  readonly command?: CommandName | null;
  readonly from?: string | null;
  readonly to?: string | null;
}
export interface Page<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
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
export async function fetchCommands(
  api: ApiClient,
  filter: CommandListFilter,
  cursor?: string,
): Promise<Page<CommandListItemView>> {
  const response = await api.request<{
    data: CommandListItemView[];
    meta: {
      nextCursor: string | null;
    };
  }>(`/admin/commands${buildQuery({ ...filter }, cursor)}`);
  return { rows: response.data, nextCursor: response.meta.nextCursor };
}
export async function fetchCommand(api: ApiClient, commandId: string): Promise<CommandDetailView> {
  const response = await api.request<{
    data: CommandDetailView;
  }>(`/admin/commands/${encodeURIComponent(commandId)}`);
  return response.data;
}
// ---------- 活动日志（BE-DEV-05） ----------
export interface ActivityListFilter {
  readonly level?: ActivityLevel | null;
  readonly kind?: ActivityKind | null;
  readonly from?: string | null;
  readonly to?: string | null;
}
export async function fetchDeviceActivities(
  api: ApiClient,
  deviceId: string,
  filter: ActivityListFilter,
  cursor?: string,
): Promise<Page<ActivityItemView>> {
  const response = await api.request<{
    data: ActivityItemView[];
    meta: {
      nextCursor: string | null;
    };
  }>(`/admin/devices/${encodeURIComponent(deviceId)}/activities${buildQuery({ ...filter }, cursor)}`);
  return { rows: response.data, nextCursor: response.meta.nextCursor };
}
export async function createActivityExport(
  api: ApiClient,
  deviceId: string,
  filter: ActivityListFilter = {},
): Promise<ActivityExportView> {
  const body: Record<string, string> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null && value !== '') body[key] = value;
  }
  const response = await api.request<{
    data: ActivityExportView;
  }>(`/admin/devices/${encodeURIComponent(deviceId)}/activities/export`, { method: 'POST', body });
  return response.data;
}
export async function fetchActivityExport(api: ApiClient, exportId: string): Promise<ActivityExportView> {
  const response = await api.request<{
    data: ActivityExportView;
  }>(`/admin/activity-exports/${encodeURIComponent(exportId)}`);
  return response.data;
}
