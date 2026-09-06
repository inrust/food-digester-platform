/**
 * FE-03 总览页 API 装配：getDashboardOverview 与 createDeviceCommand 提交器。
 *
 * 走 FE-01 createApiClient（Bearer/401 清会话/403 无权）；写操作携 CT-05 Idempotency-Key。
 * 命令创建不携带 confirmation（START/STOP/REBOOT 均非高风险，CT-04 目录）。
 */
import type { ApiClient } from '../../api/http-client.js';
import type { CommandSubmitResult } from '../../components/DeviceCommandActions.js';
import type { DashboardOverviewView } from './types.js';

export const DASHBOARD_COMMAND_TIMEOUT_SEC = 300;

export async function fetchDashboardOverview(api: ApiClient): Promise<DashboardOverviewView> {
  const response = await api.request<{ data: DashboardOverviewView }>('/admin/dashboard/overview');
  return response.data;
}

export function createDashboardCommandSubmitter(
  api: ApiClient,
  options?: { timeoutSec?: number; newIdempotencyKey?: () => string },
): (deviceId: string, command: string) => Promise<CommandSubmitResult> {
  const timeoutSec = options?.timeoutSec ?? DASHBOARD_COMMAND_TIMEOUT_SEC;
  const newKey = options?.newIdempotencyKey ?? (() => crypto.randomUUID());
  return async (deviceId, command) => {
    const response = await api.request<{ data: { commandId: string; status: string } }>(
      `/admin/devices/${encodeURIComponent(deviceId)}/commands`,
      {
        method: 'POST',
        body: { command, timeoutSec },
        idempotencyKey: newKey(),
      },
    );
    return { commandId: response.data.commandId, status: response.data.status };
  };
}
