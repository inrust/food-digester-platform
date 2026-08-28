/**
 * BE-DEV-02 Device Assignment API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（Cognito actor 由适配层注入）→ Service。
 * 路由：
 * - POST /api/v1/admin/devices/{deviceId}/assignment  分配/调整（device:assign，SuperAdmin/Operator；
 *   首次分配 Onboarded→Assigned 按 DOM-01 迁移表仅 SuperAdmin）
 * - GET  /api/v1/admin/devices/{deviceId}/assignments Assignment 历史（device:read；
 *   Customer 角色仅本 Customer 设备）
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, assertCustomerScope, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { DeviceStateError } from '@fdp/domain';
import type { DbClient } from '@fdp/database';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminAssignmentError, assignmentNotFound, assignmentValidationFailed } from './errors.js';
import { assignDevice, listAssignmentHistory, parseAssignInput } from './service.js';

export interface AdminDeviceAssignmentHandlerDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export interface AdminDeviceAssignmentHandlers {
  assign(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  history(req: AdminHttpRequest): Promise<AdminHttpResponse>;
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
  if (!deviceId) throw assignmentValidationFailed('deviceId path parameter is required');
  return deviceId;
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminAssignmentError) {
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

export function createAdminDeviceAssignmentHandlers(
  deps: AdminDeviceAssignmentHandlerDeps,
): AdminDeviceAssignmentHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });

  const assign = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device:assign' },
    async (req) => {
      const input = parseAssignInput(requireDeviceId(req), req.body);
      const view = await assignDevice(deps.client, req.actor as ActorContext, input, now);
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const history = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'device:read' }, async (req) => {
    const deviceId = requireDeviceId(req);
    const devices = (deps.client as unknown as Record<string, unknown>).device as {
      findFirst(args: { where: Record<string, unknown> }): Promise<{
        id: string;
        customerId: string | null;
        lifecycleStatus: string;
      } | null>;
    };
    const device = await devices.findFirst({ where: { id: deviceId } });
    if (!device) throw assignmentNotFound();
    const actor = req.actor as ActorContext;
    if (actor.actorType === 'customer') assertCustomerScope(actor, device.customerId ?? '');
    const items = await listAssignmentHistory(deps.client, deviceId, device.lifecycleStatus);
    return { status: 200, body: { data: items, meta: meta(req) } };
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

  return { assign: wrap(assign), history: wrap(history) };
}
