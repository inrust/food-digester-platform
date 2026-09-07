export type DeliveredRuntime = 'onboarding-api' | 'device-api' | 'admin-api';

export interface DeliveredOperation {
  readonly operationId: string;
  readonly method: 'GET' | 'POST';
  /** OpenAPI 原始路径模板；参数使用 {name}。 */
  readonly path: string;
  readonly runtime: DeliveredRuntime;
}

/**
 * BE-ONB-01～BE-SYNC-02 已交付 REST operation 的生产路由事实表。
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
