/**
 * BE-DEV-04 Device Retirement API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（device:write，SuperAdmin/Operator；retire 的 DOM-01 迁移
 * 仅 SuperAdmin，Operator 触发领域层 403）→ Service。
 * 路由：
 * - POST /api/v1/admin/devices/{deviceId}/retire           管理员退役（强制原因 + confirm=true）
 * - POST /api/v1/admin/devices/{deviceId}/retire/complete  force-complete（强制原因；离线设备不等待确认）
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { DeviceStateError } from '@fdp/domain';
import type { DbClient } from '@fdp/database';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminRetirementError, retirementValidationFailed } from './errors.js';
import { forceCompleteRetirement, parseForceCompleteBody, parseRetireBody, retireDevice } from './service.js';

export interface AdminDeviceRetirementHandlerDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export interface AdminDeviceRetirementHandlers {
  retire(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  forceComplete(req: AdminHttpRequest): Promise<AdminHttpResponse>;
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
  if (!deviceId) throw retirementValidationFailed('deviceId path parameter is required');
  return deviceId;
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminRetirementError) {
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

export function createAdminDeviceRetirementHandlers(
  deps: AdminDeviceRetirementHandlerDeps,
): AdminDeviceRetirementHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });

  const retire = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'device:write' }, async (req) => {
    const body = parseRetireBody(req.body);
    const view = await retireDevice(
      deps.client,
      req.actor as ActorContext,
      { deviceId: requireDeviceId(req), reason: body.reason },
      now,
    );
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const forceComplete = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device:write' },
    async (req) => {
      const body = parseForceCompleteBody(req.body);
      const view = await forceCompleteRetirement(
        deps.client,
        req.actor as ActorContext,
        { deviceId: requireDeviceId(req), reason: body.reason },
        now,
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

  return { retire: wrap(retire), forceComplete: wrap(forceComplete) };
}
