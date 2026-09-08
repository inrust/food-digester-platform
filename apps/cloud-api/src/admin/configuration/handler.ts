/**
 * BE-CFG-01 Configuration 版本管理 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（Cognito actor 由适配层注入；config:publish =
 * PlatformSuperAdmin/PlatformOperator，config:read 另含 Auditor）→ Service。
 * 路由：
 * - POST /api/v1/admin/configurations                                  创建配置（按设备/型号二选一）
 * - GET  /api/v1/admin/configurations                                  列表（targetModel/targetDeviceId 过滤）
 * - GET  /api/v1/admin/configurations/{configurationId}                详情（版本 + 派生只读上下文）
 * - POST /api/v1/admin/configurations/{configurationId}/versions       创建不可变版本（DRAFT）
 * - POST /api/v1/admin/configurations/{configurationId}/versions/{version}/publish  发布（CONFIG_CHANGED）
 * - GET  /api/v1/admin/configurations/{configurationId}/versions/{version}          版本详情（旧版本审计读取）
 * - GET  /api/v1/admin/configurations/{configurationId}/versions/{version}/status   发布同步状态
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { ConfigurationError } from '@fdp/domain';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminConfigurationError, configurationValidationFailed } from './errors.js';
import {
  createConfiguration,
  createConfigurationVersion,
  getConfigurationDetail,
  getConfigurationVersion,
  getConfigurationVersionStatus,
  listConfigurations,
  publishConfigurationVersion,
} from './service.js';
import type { ConfigurationDeps } from './service.js';
import { assertOptionalStringFields, parseStrictObject } from '../shared/strict-object.js';

export type AdminConfigurationHandlerDeps = ConfigurationDeps;

export interface AdminConfigurationHandlers {
  create(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  list(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  detail(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  createVersion(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  publishVersion(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  getVersion(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  versionStatus(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function requireParam(req: AdminHttpRequest, name: string): string {
  const value = req.params?.[name];
  if (!value) throw configurationValidationFailed(`${name} path parameter is required`);
  return value;
}

function requireVersionParam(req: AdminHttpRequest): number {
  const raw = requireParam(req, 'version');
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw configurationValidationFailed('version path parameter must be a positive integer');
  }
  return version;
}

function optionalTimestamp(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw configurationValidationFailed(`${field} must be an RFC 3339 UTC timestamp`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw configurationValidationFailed(`${field} must be a valid RFC 3339 timestamp`);
  return date;
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminConfigurationError) {
    const message = SENSITIVE_LEAK_PATTERN.test(err.message) ? 'The request failed' : err.message;
    return { status: err.httpStatus, body: { error: { code: err.code, message, requestId: req.requestId } } };
  }
  if (err instanceof ConfigurationError) {
    // 领域校验错误：message 汇总字段错误（字段名对外安全）
    const detail = err.fieldErrors.length > 0 ? `${err.message}: ${err.fieldErrors.join('; ')}` : err.message;
    const status = err.code === 'CONFLICT' ? 409 : 400;
    return { status, body: { error: { code: err.code, message: detail, requestId: req.requestId } } };
  }
  const mapped = mapDbErrorToHttp(err);
  if (mapped.status !== 500) {
    return {
      status: mapped.status,
      body: { error: { code: mapped.code, message: 'The request failed validation', requestId: req.requestId } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: req.requestId } },
  };
}

export function createAdminConfigurationHandlers(deps: AdminConfigurationHandlerDeps): AdminConfigurationHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });
  const actorOf = (req: AdminHttpRequest) => req.actor as ActorContext;

  const create = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'config:publish' },
    async (req) => {
      const body = parseStrictObject(
        req.body,
        ['name', 'targetModel', 'targetDeviceId', 'reason'],
        configurationValidationFailed,
      );
      assertOptionalStringFields(body, ['reason'], configurationValidationFailed);
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw configurationValidationFailed('name is required');
      }
      if (body.targetModel !== undefined && typeof body.targetModel !== 'string') {
        throw configurationValidationFailed('targetModel must be a string');
      }
      if (body.targetDeviceId !== undefined && typeof body.targetDeviceId !== 'string') {
        throw configurationValidationFailed('targetDeviceId must be a string');
      }
      const view = await createConfiguration(deps, actorOf(req), {
        name: body.name,
        targetModel: body.targetModel as string | undefined,
        targetDeviceId: body.targetDeviceId as string | undefined,
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });
      return { status: 201, body: { data: view, meta: meta(req) } };
    },
  );

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'config:read' }, async (req) => {
    const items = await listConfigurations(deps, {
      ...(req.query?.targetModel !== undefined ? { targetModel: req.query.targetModel } : {}),
      ...(req.query?.targetDeviceId !== undefined ? { targetDeviceId: req.query.targetDeviceId } : {}),
    });
    return { status: 200, body: { data: items, meta: meta(req) } };
  });

  const detail = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'config:read' }, async (req) => {
    const view = await getConfigurationDetail(deps, requireParam(req, 'configurationId'));
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const createVersion = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'config:publish' },
    async (req) => {
      const body = parseStrictObject(req.body, ['payload', 'changeNote', 'reason'], configurationValidationFailed);
      assertOptionalStringFields(body, ['changeNote', 'reason'], configurationValidationFailed);
      if (body.payload === undefined) throw configurationValidationFailed('payload is required');
      if (body.changeNote !== undefined && typeof body.changeNote !== 'string') {
        throw configurationValidationFailed('changeNote must be a string');
      }
      const view = await createConfigurationVersion(deps, actorOf(req), requireParam(req, 'configurationId'), {
        payload: body.payload,
        ...(typeof body.changeNote === 'string' ? { changeNote: body.changeNote } : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });
      return { status: 201, body: { data: view, meta: meta(req) } };
    },
  );

  const publishVersion = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'config:publish' },
    async (req) => {
      const body = parseStrictObject(req.body ?? {}, ['effectiveAt', 'reason'], configurationValidationFailed);
      assertOptionalStringFields(body, ['effectiveAt', 'reason'], configurationValidationFailed);
      const result = await publishConfigurationVersion(
        deps,
        actorOf(req),
        requireParam(req, 'configurationId'),
        requireVersionParam(req),
        {
          effectiveAt: optionalTimestamp(body.effectiveAt, 'effectiveAt'),
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        },
      );
      return { status: 200, body: { data: result, meta: meta(req) } };
    },
  );

  const getVersion = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'config:read' },
    async (req) => {
      const view = await getConfigurationVersion(deps, requireParam(req, 'configurationId'), requireVersionParam(req));
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const versionStatus = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'config:read' },
    async (req) => {
      const view = await getConfigurationVersionStatus(
        deps,
        requireParam(req, 'configurationId'),
        requireVersionParam(req),
      );
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const wrap =
    (fn: (req: AdminHttpRequest) => Promise<AdminHttpResponse>) =>
    async (req: AdminHttpRequest): Promise<AdminHttpResponse> => {
      try {
        return await fn(req);
      } catch (err) {
        return toErrorResponse(err, req);
      }
    };

  return {
    create: wrap(create),
    list: wrap(list),
    detail: wrap(detail),
    createVersion: wrap(createVersion),
    publishVersion: wrap(publishVersion),
    getVersion: wrap(getVersion),
    versionStatus: wrap(versionStatus),
  };
}
