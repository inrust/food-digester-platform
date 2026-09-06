/**
 * FE-07 设备生命周期操作 API 装配。
 *
 * - assign（BE-DEV-02）：POST /devices/{id}/assignment，siteId 必须属于 customerId；
 * - suspend/reactivate（BE-DEV-03）：强制原因，reactivate 携 issueResolved=true；无 If-Match；
 * - retire/forceCompleteRetirement（BE-DEV-04）：retire 携 confirm=true（不可恢复）；
 * - updateDeviceAlias（BE-DEV-06）：If-Match 头携带设备当前 updatedAt（ISO8601 乐观锁）；
 * - requestCertificateRotation（BE-CERT-03）：仅创建轮换请求，响应不含 PEM/私钥。
 */
import type { ApiClient } from '../../api/http-client.js';
import type {
  DeviceAssignmentView,
  DeviceMetadataView,
  DeviceStatusResultView,
  RetirementResultView,
  RotationRequestView,
} from './types.js';

function devicePath(deviceId: string): string {
  return `/admin/devices/${encodeURIComponent(deviceId)}`;
}

export async function assignDevice(
  api: ApiClient,
  deviceId: string,
  input: { customerId: string; siteId: string; reason?: string },
): Promise<DeviceAssignmentView> {
  const body: Record<string, string> = { customerId: input.customerId, siteId: input.siteId };
  if (input.reason !== undefined && input.reason !== '') body['reason'] = input.reason;
  const response = await api.request<{ data: DeviceAssignmentView }>(`${devicePath(deviceId)}/assignment`, {
    method: 'POST',
    body,
  });
  return response.data;
}

export async function fetchDeviceAssignments(
  api: ApiClient,
  deviceId: string,
): Promise<readonly DeviceAssignmentView[]> {
  const response = await api.request<{ data: DeviceAssignmentView[] }>(`${devicePath(deviceId)}/assignments`);
  return response.data;
}

export async function suspendDevice(
  api: ApiClient,
  deviceId: string,
  reason: string,
): Promise<DeviceStatusResultView> {
  const response = await api.request<{ data: DeviceStatusResultView }>(`${devicePath(deviceId)}/suspend`, {
    method: 'POST',
    body: { reason },
  });
  return response.data;
}

export async function reactivateDevice(
  api: ApiClient,
  deviceId: string,
  reason: string,
): Promise<DeviceStatusResultView> {
  const response = await api.request<{ data: DeviceStatusResultView }>(`${devicePath(deviceId)}/reactivate`, {
    method: 'POST',
    // issueResolved 契约 enum [true]：问题已解决标志必须由管理员确认
    body: { reason, issueResolved: true },
  });
  return response.data;
}

export async function retireDevice(
  api: ApiClient,
  deviceId: string,
  reason: string,
): Promise<RetirementResultView> {
  const response = await api.request<{ data: RetirementResultView }>(`${devicePath(deviceId)}/retire`, {
    method: 'POST',
    // confirm 契约 enum [true]：退役不可恢复，仅确认对话框可触发本调用
    body: { reason, confirm: true },
  });
  return response.data;
}

export async function forceCompleteRetirement(
  api: ApiClient,
  deviceId: string,
  reason: string,
): Promise<RetirementResultView> {
  const response = await api.request<{ data: RetirementResultView }>(`${devicePath(deviceId)}/retire/complete`, {
    method: 'POST',
    body: { reason },
  });
  return response.data;
}

/**
 * 别名修改：If-Match 为设备当前 updatedAt（ISO8601 字符串，非数值版本号），
 * 故不走 ApiClient 的 ifMatch 数值选项，直接置 header。
 */
export async function updateDeviceAlias(
  api: ApiClient,
  deviceId: string,
  alias: string | null,
  ifMatch: string,
): Promise<DeviceMetadataView> {
  const response = await api.request<{ data: DeviceMetadataView }>(`${devicePath(deviceId)}/metadata`, {
    method: 'PATCH',
    headers: { 'If-Match': ifMatch },
    body: { alias },
  });
  return response.data;
}

export async function requestCertificateRotation(
  api: ApiClient,
  deviceId: string,
): Promise<RotationRequestView> {
  const response = await api.request<{ data: RotationRequestView }>(
    `${devicePath(deviceId)}/certificate-rotation-requests`,
    { method: 'POST' },
  );
  return response.data;
}
