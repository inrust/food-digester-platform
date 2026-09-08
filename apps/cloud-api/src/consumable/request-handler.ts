/**
 * BE-CNS-02 耗材更换申请工作流 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（创建/状态迁移 device:write = PlatformSuperAdmin/PlatformOperator；
 * 查询 device:read + Customer 租户隔离）→ Service。
 * 路由：
 * - POST /api/v1/admin/consumable-requests                  创建（幂等：开放申请重复 → replayed）
 * - GET  /api/v1/admin/consumable-requests                  列表（customerId/deviceId/status/consumableType）
 * - GET  /api/v1/admin/consumable-requests/{requestId}      详情（跨 Customer → 404）
 * - POST /api/v1/admin/consumable-requests/{requestId}/process   PENDING→PROCESSING（If-Match）
 * - POST /api/v1/admin/consumable-requests/{requestId}/complete  PROCESSING→COMPLETED（If-Match + 强制处理备注）
 * - POST /api/v1/admin/consumable-requests/{requestId}/cancel    PENDING/PROCESSING→CANCELLED（If-Match + 强制原因）
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { ConsumableError } from '@fdp/domain';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../admin/onboarding/handler.js';
import { AdminConsumableError, consumableValidationFailed } from './errors.js';
import {
  cancelConsumableRequest,
  completeConsumableRequest,
  createConsumableRequest,
  getConsumableRequest,
  listConsumableRequests,
  processConsumableRequest,
} from './request-service.js';
import type { ConsumableRequestDeps } from './request-service.js';
import { parseStrictObject } from '../admin/shared/strict-object.js';

export type AdminConsumableRequestHandlerDeps = ConsumableRequestDeps;

export interface AdminConsumableRequestHandlers {
  create(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  list(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  detail(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  process(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  complete(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  cancel(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

/** 领域 ConsumableError → CT-05 状态码。 */
const CONSUMABLE_STATE_ERROR_HTTP: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: 400,
  UNKNOWN_CONSUMABLE_TYPE: 400,
  CONFLICT: 409,
};

function headerOf(req: AdminHttpRequest, name: string): string | undefined {
  return req.headers[name] ?? req.headers[name.toLowerCase()];
}

function parseIfMatch(value: string | undefined): number {
  if (value === undefined || value === '') {
    throw consumableValidationFailed('The If-Match header is required for this operation');
  }
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw consumableValidationFailed('The If-Match header must be a positive integer version');
  }
  return version;
}

function requireRequestId(req: AdminHttpRequest): string {
  const requestId = req.params?.requestId;
  if (!requestId) throw consumableValidationFailed('requestId path parameter is required');
  return requestId;
}

function bodyOf(req: AdminHttpRequest, allowedKeys: readonly string[]): Record<string, unknown> {
  return parseStrictObject(req.body ?? {}, allowedKeys, consumableValidationFailed);
}

function optionalNote(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 500) {
    throw consumableValidationFailed(`${field} must be a string of 1~500 characters`);
  }
  return value.trim();
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminConsumableError) {
    const message = SENSITIVE_LEAK_PATTERN.test(err.message) ? 'The request failed' : err.message;
    return { status: err.httpStatus, body: { error: { code: err.code, message, requestId: req.requestId } } };
  }
  if (err instanceof ConsumableError) {
    const status = CONSUMABLE_STATE_ERROR_HTTP[err.code] ?? 500;
    return {
      status,
      body: { error: { code: err.code, message: 'The request failed validation', requestId: req.requestId } },
    };
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

export function createAdminConsumableRequestHandlers(
  deps: AdminConsumableRequestHandlerDeps,
): AdminConsumableRequestHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });
  const actorOf = (req: AdminHttpRequest) => req.actor as ActorContext;
  const transitionInputOf = (req: AdminHttpRequest, allowedKeys: readonly string[]) => ({
    requestId: requireRequestId(req),
    ifMatchVersion: parseIfMatch(headerOf(req, 'If-Match')),
    note: optionalNote(bodyOf(req, allowedKeys).note, 'note'),
  });

  const create = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'device:write' }, async (req) => {
    const body = bodyOf(req, ['deviceId', 'consumableType', 'note']);
    if (typeof body.deviceId !== 'string' || body.deviceId.trim().length === 0) {
      throw consumableValidationFailed('deviceId is required');
    }
    if (typeof body.consumableType !== 'string') {
      throw consumableValidationFailed('consumableType is required');
    }
    const result = await createConsumableRequest(deps, actorOf(req), {
      deviceId: body.deviceId.trim(),
      consumableType: body.consumableType,
      note: optionalNote(body.note, 'note'),
    });
    return {
      status: result.replayed ? 200 : 201,
      body: { data: { ...result.view, replayed: result.replayed }, meta: meta(req) },
    };
  });

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'device:read' }, async (req) => {
    const q = req.query ?? {};
    const items = await listConsumableRequests(deps, actorOf(req), {
      ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
      ...(q.deviceId !== undefined ? { deviceId: q.deviceId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.consumableType !== undefined ? { consumableType: q.consumableType } : {}),
    });
    return { status: 200, body: { data: items, meta: meta(req) } };
  });

  const detail = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'device:read' }, async (req) => {
    const view = await getConsumableRequest(deps, actorOf(req), requireRequestId(req));
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const process = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device:write' },
    async (req) => {
      const view = await processConsumableRequest(deps, actorOf(req), transitionInputOf(req, ['note']));
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const complete = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device:write' },
    async (req) => {
      const view = await completeConsumableRequest(deps, actorOf(req), transitionInputOf(req, ['note']));
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const cancel = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'device:write' }, async (req) => {
    const view = await cancelConsumableRequest(deps, actorOf(req), transitionInputOf(req, ['note']));
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

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
    process: wrap(process),
    complete: wrap(complete),
    cancel: wrap(cancel),
  };
}
