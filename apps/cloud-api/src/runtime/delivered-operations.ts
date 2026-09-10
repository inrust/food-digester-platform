export type DeliveredRuntime = 'onboarding-api' | 'device-api' | 'admin-api';

export interface DeliveredOperation {
  readonly operationId: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
    operationId: 'redeemOtaDownloadGrant',
    method: 'GET',
    path: '/api/v1/device/ota/targets/{targetId}/download',
    runtime: 'device-api',
  },
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
  { operationId: 'listLicenses', method: 'GET', path: '/api/v1/admin/licenses', runtime: 'admin-api' },
  { operationId: 'createLicense', method: 'POST', path: '/api/v1/admin/licenses', runtime: 'admin-api' },
  { operationId: 'getLicense', method: 'GET', path: '/api/v1/admin/licenses/{licenseId}', runtime: 'admin-api' },
  {
    operationId: 'listLicenseHistory',
    method: 'GET',
    path: '/api/v1/admin/licenses/{licenseId}/history',
    runtime: 'admin-api',
  },
  {
    operationId: 'issueLicense',
    method: 'POST',
    path: '/api/v1/admin/licenses/{licenseId}/issue',
    runtime: 'admin-api',
  },
  {
    operationId: 'activateLicense',
    method: 'POST',
    path: '/api/v1/admin/licenses/{licenseId}/activate',
    runtime: 'admin-api',
  },
  {
    operationId: 'renewLicense',
    method: 'POST',
    path: '/api/v1/admin/licenses/{licenseId}/renew',
    runtime: 'admin-api',
  },
  {
    operationId: 'revokeLicense',
    method: 'POST',
    path: '/api/v1/admin/licenses/{licenseId}/revoke',
    runtime: 'admin-api',
  },
  {
    operationId: 'evaluateLicense',
    method: 'POST',
    path: '/api/v1/admin/licenses/{licenseId}/evaluate',
    runtime: 'admin-api',
  },
  { operationId: 'createContract', method: 'POST', path: '/api/v1/admin/contracts', runtime: 'admin-api' },
  { operationId: 'listContracts', method: 'GET', path: '/api/v1/admin/contracts', runtime: 'admin-api' },
  { operationId: 'getContract', method: 'GET', path: '/api/v1/admin/contracts/{contractId}', runtime: 'admin-api' },
  {
    operationId: 'updateContract',
    method: 'PATCH',
    path: '/api/v1/admin/contracts/{contractId}',
    runtime: 'admin-api',
  },
  {
    operationId: 'activateContract',
    method: 'POST',
    path: '/api/v1/admin/contracts/{contractId}/activate',
    runtime: 'admin-api',
  },
  {
    operationId: 'renewContract',
    method: 'POST',
    path: '/api/v1/admin/contracts/{contractId}/renew',
    runtime: 'admin-api',
  },
  {
    operationId: 'terminateContract',
    method: 'POST',
    path: '/api/v1/admin/contracts/{contractId}/terminate',
    runtime: 'admin-api',
  },
  {
    operationId: 'evaluateContract',
    method: 'POST',
    path: '/api/v1/admin/contracts/{contractId}/evaluate',
    runtime: 'admin-api',
  },
  {
    operationId: 'listContractDevices',
    method: 'GET',
    path: '/api/v1/admin/contracts/{contractId}/devices',
    runtime: 'admin-api',
  },
  {
    operationId: 'listAvailableDevices',
    method: 'GET',
    path: '/api/v1/admin/contracts/{contractId}/available-devices',
    runtime: 'admin-api',
  },
  {
    operationId: 'listContractAssociations',
    method: 'GET',
    path: '/api/v1/admin/contracts/{contractId}/associations',
    runtime: 'admin-api',
  },
  {
    operationId: 'bindContractDevices',
    method: 'POST',
    path: '/api/v1/admin/contracts/{contractId}/devices/bind',
    runtime: 'admin-api',
  },
  {
    operationId: 'unbindContractDevices',
    method: 'POST',
    path: '/api/v1/admin/contracts/{contractId}/devices/unbind',
    runtime: 'admin-api',
  },
  { operationId: 'createConfiguration', method: 'POST', path: '/api/v1/admin/configurations', runtime: 'admin-api' },
  { operationId: 'listConfigurations', method: 'GET', path: '/api/v1/admin/configurations', runtime: 'admin-api' },
  {
    operationId: 'getConfiguration',
    method: 'GET',
    path: '/api/v1/admin/configurations/{configurationId}',
    runtime: 'admin-api',
  },
  {
    operationId: 'createConfigurationVersion',
    method: 'POST',
    path: '/api/v1/admin/configurations/{configurationId}/versions',
    runtime: 'admin-api',
  },
  {
    operationId: 'publishConfigurationVersion',
    method: 'POST',
    path: '/api/v1/admin/configurations/{configurationId}/versions/{version}/publish',
    runtime: 'admin-api',
  },
  {
    operationId: 'getConfigurationVersion',
    method: 'GET',
    path: '/api/v1/admin/configurations/{configurationId}/versions/{version}',
    runtime: 'admin-api',
  },
  {
    operationId: 'getConfigurationVersionStatus',
    method: 'GET',
    path: '/api/v1/admin/configurations/{configurationId}/versions/{version}/status',
    runtime: 'admin-api',
  },
  { operationId: 'listConsumableStatus', method: 'GET', path: '/api/v1/admin/consumables', runtime: 'admin-api' },
  {
    operationId: 'createConsumableRequest',
    method: 'POST',
    path: '/api/v1/admin/consumable-requests',
    runtime: 'admin-api',
  },
  {
    operationId: 'listConsumableRequests',
    method: 'GET',
    path: '/api/v1/admin/consumable-requests',
    runtime: 'admin-api',
  },
  {
    operationId: 'getConsumableRequest',
    method: 'GET',
    path: '/api/v1/admin/consumable-requests/{requestId}',
    runtime: 'admin-api',
  },
  {
    operationId: 'processConsumableRequest',
    method: 'POST',
    path: '/api/v1/admin/consumable-requests/{requestId}/process',
    runtime: 'admin-api',
  },
  {
    operationId: 'completeConsumableRequest',
    method: 'POST',
    path: '/api/v1/admin/consumable-requests/{requestId}/complete',
    runtime: 'admin-api',
  },
  {
    operationId: 'cancelConsumableRequest',
    method: 'POST',
    path: '/api/v1/admin/consumable-requests/{requestId}/cancel',
    runtime: 'admin-api',
  },
  { operationId: 'createDeviceUser', method: 'POST', path: '/api/v1/admin/device-users', runtime: 'admin-api' },
  { operationId: 'listDeviceUsers', method: 'GET', path: '/api/v1/admin/device-users', runtime: 'admin-api' },
  {
    operationId: 'getDeviceUser',
    method: 'GET',
    path: '/api/v1/admin/device-users/{deviceUserId}',
    runtime: 'admin-api',
  },
  {
    operationId: 'updateDeviceUser',
    method: 'PATCH',
    path: '/api/v1/admin/device-users/{deviceUserId}',
    runtime: 'admin-api',
  },
  {
    operationId: 'disableDeviceUser',
    method: 'POST',
    path: '/api/v1/admin/device-users/{deviceUserId}/disable',
    runtime: 'admin-api',
  },
  {
    operationId: 'assignDeviceUser',
    method: 'POST',
    path: '/api/v1/admin/device-users/{deviceUserId}/assignments',
    runtime: 'admin-api',
  },
  {
    operationId: 'revokeDeviceUser',
    method: 'POST',
    path: '/api/v1/admin/device-users/{deviceUserId}/assignments/revoke',
    runtime: 'admin-api',
  },
  { operationId: 'listAlarms', method: 'GET', path: '/api/v1/admin/alarms', runtime: 'admin-api' },
  { operationId: 'getAlarm', method: 'GET', path: '/api/v1/admin/alarms/{alarmId}', runtime: 'admin-api' },
  {
    operationId: 'acknowledgeAlarm',
    method: 'POST',
    path: '/api/v1/admin/alarms/{alarmId}/acknowledge',
    runtime: 'admin-api',
  },
  { operationId: 'clearAlarm', method: 'POST', path: '/api/v1/admin/alarms/{alarmId}/clear', runtime: 'admin-api' },
  { operationId: 'listDeviceEvents', method: 'GET', path: '/api/v1/admin/events', runtime: 'admin-api' },
  { operationId: 'listTamperEvents', method: 'GET', path: '/api/v1/admin/tamper-events', runtime: 'admin-api' },
  { operationId: 'getEsgOverview', method: 'GET', path: '/api/v1/admin/esg/overview', runtime: 'admin-api' },
  { operationId: 'listEsgHourly', method: 'GET', path: '/api/v1/admin/esg/hourly', runtime: 'admin-api' },
  { operationId: 'listEsgDaily', method: 'GET', path: '/api/v1/admin/esg/daily', runtime: 'admin-api' },
  { operationId: 'listEsgReports', method: 'GET', path: '/api/v1/admin/esg/reports', runtime: 'admin-api' },
  { operationId: 'listEsgDailySummary', method: 'GET', path: '/api/v1/admin/esg/daily-summary', runtime: 'admin-api' },
  {
    operationId: 'listEsgCalculationVersions',
    method: 'GET',
    path: '/api/v1/admin/esg/calculation-versions',
    runtime: 'admin-api',
  },
  { operationId: 'createEsgExport', method: 'POST', path: '/api/v1/admin/esg/exports', runtime: 'admin-api' },
  { operationId: 'getEsgExport', method: 'GET', path: '/api/v1/admin/esg/exports/{exportId}', runtime: 'admin-api' },
  {
    operationId: 'createDeviceCommand',
    method: 'POST',
    path: '/api/v1/admin/devices/{deviceId}/commands',
    runtime: 'admin-api',
  },
  { operationId: 'listCommands', method: 'GET', path: '/api/v1/admin/commands', runtime: 'admin-api' },
  { operationId: 'getCommand', method: 'GET', path: '/api/v1/admin/commands/{commandId}', runtime: 'admin-api' },
  {
    operationId: 'createFirmwareUpload',
    method: 'POST',
    path: '/api/v1/admin/ota/packages/upload-sessions',
    runtime: 'admin-api',
  },
  {
    operationId: 'completeFirmwareUpload',
    method: 'POST',
    path: '/api/v1/admin/ota/packages/{packageId}/complete',
    runtime: 'admin-api',
  },
  { operationId: 'listFirmwarePackages', method: 'GET', path: '/api/v1/admin/ota/packages', runtime: 'admin-api' },
  {
    operationId: 'getFirmwarePackage',
    method: 'GET',
    path: '/api/v1/admin/ota/packages/{packageId}',
    runtime: 'admin-api',
  },
  { operationId: 'createOtaCampaign', method: 'POST', path: '/api/v1/admin/ota/campaigns', runtime: 'admin-api' },
  { operationId: 'listOtaCampaigns', method: 'GET', path: '/api/v1/admin/ota/campaigns', runtime: 'admin-api' },
  {
    operationId: 'getOtaCampaign',
    method: 'GET',
    path: '/api/v1/admin/ota/campaigns/{campaignId}',
    runtime: 'admin-api',
  },
  {
    operationId: 'listOtaTargets',
    method: 'GET',
    path: '/api/v1/admin/ota/campaigns/{campaignId}/targets',
    runtime: 'admin-api',
  },
  {
    operationId: 'expandOtaCampaignBatch',
    method: 'POST',
    path: '/api/v1/admin/ota/campaigns/{campaignId}/batches',
    runtime: 'admin-api',
  },
  {
    operationId: 'pauseOtaCampaign',
    method: 'POST',
    path: '/api/v1/admin/ota/campaigns/{campaignId}/pause',
    runtime: 'admin-api',
  },
  {
    operationId: 'resumeOtaCampaign',
    method: 'POST',
    path: '/api/v1/admin/ota/campaigns/{campaignId}/resume',
    runtime: 'admin-api',
  },
  {
    operationId: 'cancelOtaCampaign',
    method: 'POST',
    path: '/api/v1/admin/ota/campaigns/{campaignId}/cancel',
    runtime: 'admin-api',
  },
  {
    operationId: 'retryOtaCampaignFailures',
    method: 'POST',
    path: '/api/v1/admin/ota/campaigns/{campaignId}/retry',
    runtime: 'admin-api',
  },
  {
    operationId: 'createMediaUploadSession',
    method: 'POST',
    path: '/api/v1/device/media/upload-sessions',
    runtime: 'device-api',
  },
  { operationId: 'listMedia', method: 'GET', path: '/api/v1/admin/media', runtime: 'admin-api' },
  {
    operationId: 'createMediaDownloadUrl',
    method: 'GET',
    path: '/api/v1/admin/media/{mediaId}/download-url',
    runtime: 'admin-api',
  },
  { operationId: 'listUsers', method: 'GET', path: '/api/v1/admin/users', runtime: 'admin-api' },
  { operationId: 'inviteUser', method: 'POST', path: '/api/v1/admin/users', runtime: 'admin-api' },
  {
    operationId: 'assignUserRoles',
    method: 'PUT',
    path: '/api/v1/admin/users/{userId}/roles',
    runtime: 'admin-api',
  },
  {
    operationId: 'setUserScope',
    method: 'PUT',
    path: '/api/v1/admin/users/{userId}/scope',
    runtime: 'admin-api',
  },
  {
    operationId: 'disableUser',
    method: 'POST',
    path: '/api/v1/admin/users/{userId}/disable',
    runtime: 'admin-api',
  },
  {
    operationId: 'triggerUserPasswordReset',
    method: 'POST',
    path: '/api/v1/admin/users/{userId}/password-reset',
    runtime: 'admin-api',
  },
  { operationId: 'listAuditLogs', method: 'GET', path: '/api/v1/admin/audit-logs', runtime: 'admin-api' },
  {
    operationId: 'getAuditLogDetail',
    method: 'GET',
    path: '/api/v1/admin/audit-logs/{auditId}',
    runtime: 'admin-api',
  },
  {
    operationId: 'getDashboardOverview',
    method: 'GET',
    path: '/api/v1/admin/dashboard/overview',
    runtime: 'admin-api',
  },
  { operationId: 'listSettings', method: 'GET', path: '/api/v1/admin/settings', runtime: 'admin-api' },
  {
    operationId: 'getSetting',
    method: 'GET',
    path: '/api/v1/admin/settings/{key}',
    runtime: 'admin-api',
  },
  {
    operationId: 'updateSetting',
    method: 'PUT',
    path: '/api/v1/admin/settings/{key}',
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
