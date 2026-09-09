/**
 * 管理 API 的可信 Lambda 组合根。
 *
 * API Gateway authorizer/context 中的 claims 只属于传输输入，不能直接成为 ActorContext；
 * 本适配器始终重新验证 Authorization Bearer JWT，再构造业务 Handler 唯一可信的 actor。
 */
import { AuthError, createCognitoAuthenticator } from '@fdp/auth';
import type { CognitoAuthenticatorConfig } from '@fdp/auth';
import type { AdminHttpRequest, AdminHttpResponse } from '../admin/onboarding/handler.js';
import type { AdminOnboardingHandlers } from '../admin/onboarding/handler.js';
import type { AdminReplayHandlers } from '../admin/replay/handler.js';
import type { AdminCustomerHandlers } from '../admin/customer/handler.js';
import type { AdminSiteHandlers } from '../admin/site/handler.js';
import type { AdminDeviceHandlers } from '../admin/device/handler.js';
import type { AdminDeviceAssignmentHandlers } from '../admin/device-assignment/handler.js';
import type { AdminDeviceStatusHandlers } from '../admin/device-status/handler.js';
import type { AdminDeviceRetirementHandlers } from '../admin/device-retirement/handler.js';
import type { AdminDeviceConsoleHandlers } from '../admin/device-console/handler.js';
import type { AdminLicenseHandlers } from '../admin/license/handler.js';
import type { AdminContractHandlers } from '../admin/contract/handler.js';
import type { AdminContractDeviceHandlers } from '../admin/contract-device/handler.js';
import type { AdminConfigurationHandlers } from '../admin/configuration/handler.js';
import type { AdminConsumableHandlers } from '../consumable/handler.js';
import type { AdminConsumableRequestHandlers } from '../consumable/request-handler.js';
import type { AdminDeviceUserHandlers } from '../admin/device-user/handler.js';
import type { AdminAlarmHandlers } from '../admin/alarm/handler.js';
import type { AdminEsgHandlers } from '../admin/esg/handler.js';
import type { AdminCommandHandlers } from '../admin/command/handler.js';
import type { AdminOtaPackageHandlers } from '../admin/ota-package/handler.js';
import type { AdminOtaCampaignHandlers } from '../admin/ota-campaign/handler.js';
import { matchDeliveredOperation } from './delivered-operations.js';

export interface ApiGatewayAdminEvent {
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly pathParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly httpMethod?: string;
  readonly path?: string;
  readonly rawPath?: string;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly identity?: { readonly sourceIp?: string };
    readonly http?: { readonly sourceIp?: string; readonly method?: string; readonly path?: string };
    /** 不可信输入：特意不读取 authorizer/claims。 */
    readonly authorizer?: unknown;
  };
  /** 防止调用者把伪造 actor 混进事件后被宽松 spread。 */
  readonly actor?: unknown;
}

export interface ApiGatewayAdminResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type AdminRoute = (request: AdminHttpRequest) => Promise<AdminHttpResponse>;
export type AdminRouteResolver = (event: ApiGatewayAdminEvent) => AdminRoute;

export interface AdminOnboardingRouteSet {
  readonly onboarding: AdminOnboardingHandlers;
  readonly certificateRotation: AdminRoute;
  readonly replay: AdminReplayHandlers;
  readonly customers: AdminCustomerHandlers;
  readonly sites: AdminSiteHandlers;
  readonly devices: AdminDeviceHandlers;
  readonly assignments: AdminDeviceAssignmentHandlers;
  readonly statuses: AdminDeviceStatusHandlers;
  readonly retirements: AdminDeviceRetirementHandlers;
  readonly console: AdminDeviceConsoleHandlers;
  readonly licenses: AdminLicenseHandlers;
  readonly contracts: AdminContractHandlers;
  readonly contractDevices: AdminContractDeviceHandlers;
  readonly configurations: AdminConfigurationHandlers;
  readonly consumables: AdminConsumableHandlers;
  readonly consumableRequests: AdminConsumableRequestHandlers;
  readonly deviceUsers: AdminDeviceUserHandlers;
  readonly alarms: AdminAlarmHandlers;
  readonly esg: AdminEsgHandlers;
  readonly commands: AdminCommandHandlers;
  readonly otaPackages: AdminOtaPackageHandlers;
  readonly otaCampaigns: AdminOtaCampaignHandlers;
}

const header = (headers: Readonly<Record<string, string | undefined>>, wanted: string): string | undefined => {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === wanted.toLowerCase());
  return entry?.[1];
};

function result(status: number, body: unknown): ApiGatewayAdminResult {
  return { statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** AUTH-01 的首个生产路由表；不匹配的接口失败关闭为 404，不回退到未鉴权 Handler。 */
export function createAdminRoute(event: ApiGatewayAdminEvent, routes: AdminOnboardingRouteSet): AdminRoute {
  const method = (event.requestContext?.http?.method ?? event.httpMethod ?? '').toUpperCase();
  const path = event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? '';
  const matched = matchDeliveredOperation('admin-api', method, path);

  return async (request) => {
    if (matched?.operation.operationId === 'listOnboardingRequests') return routes.onboarding.list(request);
    if (
      matched?.operation.operationId === 'getOnboardingRequest' ||
      matched?.operation.operationId === 'approveOnboardingRequest' ||
      matched?.operation.operationId === 'rejectOnboardingRequest'
    ) {
      const routedRequest: AdminHttpRequest = {
        ...request,
        params: { ...(request.params ?? {}), requestId: decodeURIComponent(matched.params.requestId as string) },
      };
      if (matched.operation.operationId === 'getOnboardingRequest') return routes.onboarding.detail(routedRequest);
      if (matched.operation.operationId === 'approveOnboardingRequest') return routes.onboarding.approve(routedRequest);
      return routes.onboarding.reject(routedRequest);
    }
    if (matched?.operation.operationId === 'createCertificateRotationRequest') {
      return routes.certificateRotation({
        ...request,
        params: {
          ...(request.params ?? {}),
          deviceId: decodeURIComponent(matched.params.deviceId as string),
        },
      });
    }
    if (matched?.operation.operationId === 'createReplayJob' || matched?.operation.operationId === 'listReplayJobs') {
      return matched.operation.operationId === 'createReplayJob'
        ? routes.replay.create(request)
        : routes.replay.list(request);
    }
    if (matched?.operation.operationId === 'getReplayJob') {
      return routes.replay.detail({
        ...request,
        params: { ...(request.params ?? {}), jobId: decodeURIComponent(matched.params.jobId as string) },
      });
    }
    if (!matched) {
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'The requested resource was not found', requestId: request.requestId },
        },
      };
    }
    const operationId = matched.operation.operationId;
    const routedRequest: AdminHttpRequest = {
      ...request,
      params: {
        ...(request.params ?? {}),
        ...Object.fromEntries(Object.entries(matched.params).map(([name, value]) => [name, decodeURIComponent(value)])),
      },
    };
    const targetOperations: Readonly<Record<string, (req: AdminHttpRequest) => Promise<AdminHttpResponse>>> = {
      createLicense: routes.licenses.create,
      getLicense: routes.licenses.detail,
      listLicenseHistory: routes.licenses.history,
      issueLicense: routes.licenses.issue,
      activateLicense: routes.licenses.activate,
      renewLicense: routes.licenses.renew,
      revokeLicense: routes.licenses.revoke,
      evaluateLicense: routes.licenses.evaluate,
      createContract: routes.contracts.create,
      listContracts: routes.contracts.list,
      getContract: routes.contracts.detail,
      updateContract: routes.contracts.update,
      activateContract: routes.contracts.activate,
      renewContract: routes.contracts.renew,
      terminateContract: routes.contracts.terminate,
      evaluateContract: routes.contracts.evaluate,
      listContractDevices: routes.contractDevices.listDevices,
      listAvailableDevices: routes.contractDevices.listAvailable,
      listContractAssociations: routes.contractDevices.listAssociations,
      bindContractDevices: routes.contractDevices.bind,
      unbindContractDevices: routes.contractDevices.unbind,
      createConfiguration: routes.configurations.create,
      listConfigurations: routes.configurations.list,
      getConfiguration: routes.configurations.detail,
      createConfigurationVersion: routes.configurations.createVersion,
      publishConfigurationVersion: routes.configurations.publishVersion,
      getConfigurationVersion: routes.configurations.getVersion,
      getConfigurationVersionStatus: routes.configurations.versionStatus,
      listConsumableStatus: routes.consumables.list,
      createConsumableRequest: routes.consumableRequests.create,
      listConsumableRequests: routes.consumableRequests.list,
      getConsumableRequest: routes.consumableRequests.detail,
      processConsumableRequest: routes.consumableRequests.process,
      completeConsumableRequest: routes.consumableRequests.complete,
      cancelConsumableRequest: routes.consumableRequests.cancel,
      createDeviceUser: routes.deviceUsers.create,
      listDeviceUsers: routes.deviceUsers.list,
      getDeviceUser: routes.deviceUsers.detail,
      updateDeviceUser: routes.deviceUsers.update,
      disableDeviceUser: routes.deviceUsers.disable,
      assignDeviceUser: routes.deviceUsers.assign,
      revokeDeviceUser: routes.deviceUsers.revoke,
      listAlarms: routes.alarms.listAlarms,
      getAlarm: routes.alarms.alarmDetail,
      acknowledgeAlarm: routes.alarms.acknowledge,
      clearAlarm: routes.alarms.clear,
      listDeviceEvents: routes.alarms.listEvents,
      listTamperEvents: routes.alarms.listTamperEvents,
      getEsgOverview: routes.esg.overview,
      listEsgHourly: routes.esg.listHourly,
      listEsgDaily: routes.esg.listDaily,
      listEsgReports: routes.esg.listReports,
      listEsgDailySummary: routes.esg.listDailySummary,
      listEsgCalculationVersions: routes.esg.listCalculationVersions,
      createEsgExport: routes.esg.createExport,
      getEsgExport: routes.esg.exportDetail,
      createDeviceCommand: routes.commands.createCommand,
      listCommands: routes.commands.listCommands,
      getCommand: routes.commands.getCommand,
      createFirmwareUpload: routes.otaPackages.createUploadSession,
      completeFirmwareUpload: routes.otaPackages.completeUpload,
      listFirmwarePackages: routes.otaPackages.listPackages,
      getFirmwarePackage: routes.otaPackages.getPackage,
      createOtaCampaign: routes.otaCampaigns.createCampaign,
      listOtaCampaigns: routes.otaCampaigns.listCampaigns,
      getOtaCampaign: routes.otaCampaigns.getCampaign,
      listOtaTargets: routes.otaCampaigns.listTargets,
      expandOtaCampaignBatch: routes.otaCampaigns.expandBatch,
      pauseOtaCampaign: routes.otaCampaigns.pauseCampaign,
      resumeOtaCampaign: routes.otaCampaigns.resumeCampaign,
      cancelOtaCampaign: routes.otaCampaigns.cancelCampaign,
      retryOtaCampaignFailures: routes.otaCampaigns.retryCampaign,
    };
    const target = targetOperations[operationId];
    if (target) return target(routedRequest);
    if (operationId === 'listCustomers') return routes.customers.list(request);
    if (operationId === 'createCustomer') return routes.customers.create(request);
    if (
      operationId === 'getCustomer' ||
      operationId === 'updateCustomer' ||
      operationId === 'deleteCustomer' ||
      operationId === 'deactivateCustomer'
    ) {
      const routedRequest: AdminHttpRequest = {
        ...request,
        params: { ...(request.params ?? {}), customerId: decodeURIComponent(matched.params.customerId as string) },
      };
      if (operationId === 'getCustomer') return routes.customers.detail(routedRequest);
      if (operationId === 'updateCustomer') return routes.customers.update(routedRequest);
      if (operationId === 'deleteCustomer') return routes.customers.remove(routedRequest);
      return routes.customers.deactivate(routedRequest);
    }
    if (operationId === 'listSites') return routes.sites.list(request);
    if (operationId === 'createSite') return routes.sites.create(request);
    if (
      operationId === 'getSite' ||
      operationId === 'updateSite' ||
      operationId === 'deleteSite' ||
      operationId === 'deactivateSite'
    ) {
      const routedRequest: AdminHttpRequest = {
        ...request,
        params: { ...(request.params ?? {}), siteId: decodeURIComponent(matched.params.siteId as string) },
      };
      if (operationId === 'getSite') return routes.sites.detail(routedRequest);
      if (operationId === 'updateSite') return routes.sites.update(routedRequest);
      if (operationId === 'deleteSite') return routes.sites.remove(routedRequest);
      return routes.sites.deactivate(routedRequest);
    }
    if (operationId === 'listDevices') return routes.devices.list(request);
    if (operationId === 'getActivityExport') {
      return routes.console.getActivityExport({
        ...request,
        params: { ...(request.params ?? {}), exportId: decodeURIComponent(matched.params.exportId as string) },
      });
    }
    if (matched.params.deviceId !== undefined) {
      const routedRequest: AdminHttpRequest = {
        ...request,
        params: { ...(request.params ?? {}), deviceId: decodeURIComponent(matched.params.deviceId) },
      };
      if (operationId === 'getDevice') return routes.devices.detail(routedRequest);
      if (operationId === 'updateDeviceMetadata') return routes.devices.updateMetadata(routedRequest);
      if (operationId === 'assignDevice') return routes.assignments.assign(routedRequest);
      if (operationId === 'listDeviceAssignments') return routes.assignments.history(routedRequest);
      if (operationId === 'suspendDevice') return routes.statuses.suspend(routedRequest);
      if (operationId === 'reactivateDevice') return routes.statuses.reactivate(routedRequest);
      if (operationId === 'retireDevice') return routes.retirements.retire(routedRequest);
      if (operationId === 'forceCompleteRetirement') return routes.retirements.forceComplete(routedRequest);
      if (operationId === 'getDeviceConsole') return routes.console.getDeviceConsole(routedRequest);
      if (operationId === 'listDeviceActivities') return routes.console.listDeviceActivities(routedRequest);
      if (operationId === 'createActivityExport') return routes.console.createActivityExport(routedRequest);
    }
    return {
      status: 404,
      body: {
        error: { code: 'NOT_FOUND', message: 'The requested resource was not found', requestId: request.requestId },
      },
    };
  };
}

export function createAdminLambdaHandler(config: CognitoAuthenticatorConfig, route: AdminRoute) {
  return createAdminLambdaRouter(config, () => route);
}

/** 生产路由变体：认证器/JWKS 缓存按 Lambda 容器复用，路由按当前 API Gateway 事件解析。 */
export function createAdminLambdaRouter(config: CognitoAuthenticatorConfig, resolveRoute: AdminRouteResolver) {
  const authenticator = createCognitoAuthenticator(config);

  return async (event: ApiGatewayAdminEvent): Promise<ApiGatewayAdminResult> => {
    const headers = event.headers ?? {};
    const requestId = event.requestContext?.requestId ?? 'unknown';
    let actor;
    try {
      actor = await authenticator.authenticate(header(headers, 'authorization'));
    } catch (error) {
      if (error instanceof AuthError) {
        return result(error.httpStatus, {
          error: { code: error.code, message: error.message, requestId },
        });
      }
      return result(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication required', requestId } });
    }

    let body: unknown;
    try {
      const encodedBody = event.body;
      const rawBody =
        encodedBody && event.isBase64Encoded ? Buffer.from(encodedBody, 'base64').toString('utf8') : encodedBody;
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      return result(400, {
        error: { code: 'VALIDATION_FAILED', message: 'Request body must be valid JSON', requestId },
      });
    }

    try {
      const sourceIp = event.requestContext?.http?.sourceIp ?? event.requestContext?.identity?.sourceIp;
      const userAgent = header(headers, 'user-agent');
      const response = await resolveRoute(event)({
        actor,
        headers,
        ...(event.pathParameters ? { params: event.pathParameters } : {}),
        ...(event.queryStringParameters ? { query: event.queryStringParameters } : {}),
        ...(body !== undefined ? { body } : {}),
        requestId,
        ...(sourceIp !== undefined ? { sourceIp } : {}),
        ...(userAgent !== undefined ? { userAgent } : {}),
      });
      return result(response.status, response.body);
    } catch (error) {
      if (error instanceof AuthError) {
        return result(error.httpStatus, { error: { code: error.code, message: error.message, requestId } });
      }
      return result(500, { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } });
    }
  };
}
