export type DeliveredRuntime = 'onboarding-api' | 'device-api' | 'admin-api';

export interface DeliveredOperation {
  readonly operationId: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** OpenAPI 原始路径模板；参数使用 {name}。 */
  readonly path: string;
  readonly runtime: DeliveredRuntime;
}

/**
 * 已交付 REST operation 的生产路由事实表。
 * 生产适配器直接使用本表匹配请求，严格 Gate 再与 OpenAPI 双向比较。
 */
export const DELIVERED_OPERATIONS = [
  {
    operationId: 'submitOnboardingRequest',
    method: 'POST',
    path: '/api/v1/device/onboarding/request',
    runtime: 'onboarding-api',
  },
  {
    operationId: 'getOnboardingStatus',
    method: 'GET',
    path: '/api/v1/device/onboarding/status',
    runtime: 'onboarding-api',
  },
  {
    operationId: 'getCertificateStatus',
    method: 'GET',
    path: '/api/v1/device/certificate/status',
    runtime: 'device-api',
  },
  {
    operationId: 'rotateCertificate',
    method: 'POST',
    path: '/api/v1/device/certificate/rotate',
    runtime: 'device-api',
  },
  { operationId: 'syncDevice', method: 'POST', path: '/api/v1/device/sync', runtime: 'device-api' },
  { operationId: 'confirmDeactivation', method: 'POST', path: '/api/v1/device/deactivate', runtime: 'device-api' },
  {
    operationId: 'listOnboardingRequests',
    method: 'GET',
    path: '/api/v1/admin/onboarding/requests',
    runtime: 'admin-api',
  },
  {
    operationId: 'getOnboardingRequest',
    method: 'GET',
    path: '/api/v1/admin/onboarding/requests/{requestId}',
    runtime: 'admin-api',
  },
  {
    operationId: 'approveOnboardingRequest',
    method: 'POST',
    path: '/api/v1/admin/onboarding/requests/{requestId}/approve',
    runtime: 'admin-api',
  },
  {
    operationId: 'rejectOnboardingRequest',
    method: 'POST',
    path: '/api/v1/admin/onboarding/requests/{requestId}/reject',
    runtime: 'admin-api',
  },
  {
    operationId: 'createCertificateRotationRequest',
    method: 'POST',
    path: '/api/v1/admin/devices/{deviceId}/certificate-rotation-requests',
    runtime: 'admin-api',
  },
  {
    operationId: 'createReplayJob',
    method: 'POST',
    path: '/api/v1/admin/replay/jobs',
    runtime: 'admin-api',
  },
  {
    operationId: 'listReplayJobs',
    method: 'GET',
    path: '/api/v1/admin/replay/jobs',
    runtime: 'admin-api',
  },
  {
    operationId: 'getReplayJob',
    method: 'GET',
    path: '/api/v1/admin/replay/jobs/{jobId}',
    runtime: 'admin-api',
  },
  { operationId: 'listCustomers', method: 'GET', path: '/api/v1/admin/customers', runtime: 'admin-api' },
  { operationId: 'createCustomer', method: 'POST', path: '/api/v1/admin/customers', runtime: 'admin-api' },
  {
    operationId: 'getCustomer',
    method: 'GET',
    path: '/api/v1/admin/customers/{customerId}',
    runtime: 'admin-api',
  },
  {
    operationId: 'updateCustomer',
    method: 'PATCH',
    path: '/api/v1/admin/customers/{customerId}',
    runtime: 'admin-api',
  },
  {
    operationId: 'deleteCustomer',
    method: 'DELETE',
    path: '/api/v1/admin/customers/{customerId}',
    runtime: 'admin-api',
  },
  {
    operationId: 'deactivateCustomer',
    method: 'POST',
    path: '/api/v1/admin/customers/{customerId}/deactivate',
    runtime: 'admin-api',
  },
  { operationId: 'listSites', method: 'GET', path: '/api/v1/admin/sites', runtime: 'admin-api' },
  { operationId: 'createSite', method: 'POST', path: '/api/v1/admin/sites', runtime: 'admin-api' },
  { operationId: 'getSite', method: 'GET', path: '/api/v1/admin/sites/{siteId}', runtime: 'admin-api' },
  { operationId: 'updateSite', method: 'PATCH', path: '/api/v1/admin/sites/{siteId}', runtime: 'admin-api' },
  { operationId: 'deleteSite', method: 'DELETE', path: '/api/v1/admin/sites/{siteId}', runtime: 'admin-api' },
  {
    operationId: 'deactivateSite',
    method: 'POST',
    path: '/api/v1/admin/sites/{siteId}/deactivate',
    runtime: 'admin-api',
  },
  { operationId: 'listDevices', method: 'GET', path: '/api/v1/admin/devices', runtime: 'admin-api' },
  {
    operationId: 'getDevice',
    method: 'GET',
    path: '/api/v1/admin/devices/{deviceId}',
    runtime: 'admin-api',
  },
  {
    operationId: 'updateDeviceMetadata',
    method: 'PATCH',
    path: '/api/v1/admin/devices/{deviceId}/metadata',
    runtime: 'admin-api',
  },
  {
    operationId: 'assignDevice',
    method: 'POST',
    path: '/api/v1/admin/devices/{deviceId}/assignment',
    runtime: 'admin-api',
  },
  {
    operationId: 'listDeviceAssignments',
    method: 'GET',
    path: '/api/v1/admin/devices/{deviceId}/assignments',
    runtime: 'admin-api',
  },
  {
    operationId: 'suspendDevice',
    method: 'POST',
    path: '/api/v1/admin/devices/{deviceId}/suspend',
    runtime: 'admin-api',
  },
  {
    operationId: 'reactivateDevice',
    method: 'POST',
    path: '/api/v1/admin/devices/{deviceId}/reactivate',
    runtime: 'admin-api',
  },
  {
    operationId: 'retireDevice',
    method: 'POST',
    path: '/api/v1/admin/devices/{deviceId}/retire',
    runtime: 'admin-api',
  },
  {
    operationId: 'forceCompleteRetirement',
    method: 'POST',
    path: '/api/v1/admin/devices/{deviceId}/retire/complete',
    runtime: 'admin-api',
  },
  {
    operationId: 'getDeviceConsole',
    method: 'GET',
    path: '/api/v1/admin/devices/{deviceId}/console',
    runtime: 'admin-api',
  },
  {
    operationId: 'listDeviceActivities',
    method: 'GET',
    path: '/api/v1/admin/devices/{deviceId}/activities',
    runtime: 'admin-api',
  },
  {
    operationId: 'createActivityExport',
    method: 'POST',
    path: '/api/v1/admin/devices/{deviceId}/activities/export',
    runtime: 'admin-api',
  },
  {
    operationId: 'getActivityExport',
    method: 'GET',
    path: '/api/v1/admin/activity-exports/{exportId}',
    runtime: 'admin-api',
  },
] as const satisfies readonly DeliveredOperation[];

export type DeliveredOperationId = (typeof DELIVERED_OPERATIONS)[number]['operationId'];

function pathPattern(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\\{([^}]+)\\\}/gu, '(?<$1>[^/]+)');
  return new RegExp(`^${escaped}/?$`, 'u');
}

export interface MatchedDeliveredOperation {
  readonly operation: (typeof DELIVERED_OPERATIONS)[number];
  readonly params: Readonly<Record<string, string>>;
}

export function matchDeliveredOperation(
  runtime: DeliveredRuntime,
  method: string,
  path: string,
): MatchedDeliveredOperation | undefined {
  for (const operation of DELIVERED_OPERATIONS) {
    if (operation.runtime !== runtime || operation.method !== method.toUpperCase()) continue;
    const match = pathPattern(operation.path).exec(path);
    if (!match) continue;
    return { operation, params: { ...(match.groups ?? {}) } };
  }
  return undefined;
}
