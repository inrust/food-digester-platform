/**
 * BE-DEV-03 Device Suspend/Reactivate API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（device:write，SuperAdmin/Operator）→ Service。
 * 路由：
 * - POST /api/v1/admin/devices/{deviceId}/suspend     挂起（Active→Suspended，强制原因，DEVICE_SUSPENDED 通知）
 * - POST /api/v1/admin/devices/{deviceId}/reactivate  恢复（Suspended→Active，强制原因 + 问题已解决标志，
 *   STATUS_CHANGED 通知）
 * 重复请求幂等（已处于目标状态 → replayed，无新通知）。不执行设备端模式切换。
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { DeviceStateError } from '@fdp/domain';
import type { DbClient } from '@fdp/database';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminDeviceStatusError, deviceStatusValidationFailed } from './errors.js';
import { parseReactivateBody, parseSuspendBody, reactivateDevice, suspendDevice } from './service.js';

export interface AdminDeviceStatusHandlerDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export interface AdminDeviceStatusHandlers {
  suspend(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  reactivate(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

/** DOM-01 DeviceStateError → CT-05 状态码（message 统一对外安全文案）。 */
const DEVICE_STATE_ERROR_HTTP: Readonly<Record<string, number>> = {
  DEVICE_STATE_NOT_ALLOWED: 409,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
};

function requireDeviceId(req: AdminHttpRequest): string {
  const deviceId = req.params?.deviceId;
  if (!deviceId) throw deviceStatusValidationFailed('deviceId path parameter is required');
  return deviceId;
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminDeviceStatusError) {
    const message = SENSITIVE_LEAK_PATTERN.test(err.message) ? 'The request failed' : err.message;
    return { status: err.httpStatus, body: { error: { code: err.code, message, requestId: req.requestId } } };
  }
  if (err instanceof DeviceStateError) {
    const status = DEVICE_STATE_ERROR_HTTP[err.code] ?? 500;
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

export function createAdminDeviceStatusHandlers(deps: AdminDeviceStatusHandlerDeps): AdminDeviceStatusHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });

  const suspend = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device:write' },
    async (req) => {
      const body = parseSuspendBody(req.body);
      const view = await suspendDevice(deps.client, req.actor as ActorContext, {
        deviceId: requireDeviceId(req),
        reason: body.reason,
      });
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const reactivate = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device:write' },
    async (req) => {
      const body = parseReactivateBody(req.body);
      const view = await reactivateDevice(deps.client, req.actor as ActorContext, {
        deviceId: requireDeviceId(req),
        reason: body.reason,
        issueResolved: body.issueResolved,
      });
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

  return { suspend: wrap(suspend), reactivate: wrap(reactivate) };
}
