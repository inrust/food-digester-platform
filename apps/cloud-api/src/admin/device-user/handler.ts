/**
 * BE-DUSR-01 Device User 管理 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（device-user:write = PlatformSuperAdmin/CustomerAdmin
 * （DEC-012 矩阵：Operator 无 device-user 权限；CustomerAdmin 租户强制）；
 * device-user:read = SuperAdmin/Auditor/CustomerAdmin/CustomerViewer + Customer 租户隔离）→ Service。
 * 路由：
 * - POST  /api/v1/admin/device-users                          创建（拒收明文密码，仅预计算验证材料）
 * - GET   /api/v1/admin/device-users                          列表（customerId/status/keyword）
 * - GET   /api/v1/admin/device-users/{deviceUserId}           详情 + 分配历史
 * - PATCH /api/v1/admin/device-users/{deviceUserId}           修改/验证材料轮换（If-Match + 强制原因）
 * - POST  /api/v1/admin/device-users/{deviceUserId}/disable   停用（If-Match + 强制原因）
 * - POST  /api/v1/admin/device-users/{deviceUserId}/assignments         批量分配设备（If-Match，全成或全败）
 * - POST  /api/v1/admin/device-users/{deviceUserId}/assignments/revoke  批量撤销分配（If-Match，全成或全败）
 * 任何变化 version+1 并向受影响设备发 USERS_CHANGED（Outbox，deviceAction=SYNC）。
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminDeviceUserError, deviceUserValidationFailed } from './errors.js';
import {
  assignDevices,
  createDeviceUser,
  disableDeviceUser,
  getDeviceUser,
  listDeviceUsers,
  revokeDevices,
  updateDeviceUser,
} from './service.js';
import type { DeviceUserDeps } from './service.js';

export type AdminDeviceUserHandlerDeps = DeviceUserDeps;

export interface AdminDeviceUserHandlers {
  create(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  list(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  detail(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  update(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  disable(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  assign(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  revoke(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function headerOf(req: AdminHttpRequest, name: string): string | undefined {
  return req.headers[name] ?? req.headers[name.toLowerCase()];
}

function parseIfMatch(value: string | undefined): number {
  if (value === undefined || value === '') {
    throw deviceUserValidationFailed('The If-Match header is required for this operation');
  }
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) {
    throw deviceUserValidationFailed('The If-Match header must be a positive integer version');
  }
  return version;
}

function requireUserId(req: AdminHttpRequest): string {
  const deviceUserId = req.params?.deviceUserId;
  if (!deviceUserId) throw deviceUserValidationFailed('deviceUserId path parameter is required');
  return deviceUserId;
}

function bodyOf(req: AdminHttpRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function requireReason(body: Record<string, unknown>): string {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw deviceUserValidationFailed('The reason is required for this operation');
  return reason;
}

function requireDeviceIds(body: Record<string, unknown>): string[] {
  if (
    !Array.isArray(body.deviceIds) ||
    body.deviceIds.length === 0 ||
    body.deviceIds.some((id) => typeof id !== 'string' || id.trim().length === 0)
  ) {
    throw deviceUserValidationFailed('deviceIds must be a non-empty string array');
  }
  return (body.deviceIds as string[]).map((id) => id.trim());
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 200) {
    throw deviceUserValidationFailed(`${field} must be a string of 1~200 characters`);
  }
  return value.trim();
}

/** DEC-004：拒收明文密码字段（仅接受预计算验证材料）。 */
function rejectPlaintextPassword(body: Record<string, unknown>): void {
  if ('password' in body || 'plainPassword' in body || 'passwordHash' in body) {
    throw deviceUserValidationFailed('Plaintext passwords or cloud password hashes are not accepted');
  }
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminDeviceUserError) {
    const message = SENSITIVE_LEAK_PATTERN.test(err.message) ? 'The request failed' : err.message;
    return { status: err.httpStatus, body: { error: { code: err.code, message, requestId: req.requestId } } };
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

export function createAdminDeviceUserHandlers(deps: AdminDeviceUserHandlerDeps): AdminDeviceUserHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });
  const actorOf = (req: AdminHttpRequest) => req.actor as ActorContext;
  const writeInputOf = (req: AdminHttpRequest) => ({
    deviceUserId: requireUserId(req),
    ifMatchVersion: parseIfMatch(headerOf(req, 'If-Match')),
    reason: requireReason(bodyOf(req)),
  });

  const create = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device-user:write' },
    async (req) => {
      const body = bodyOf(req);
      rejectPlaintextPassword(body);
      if (typeof body.username !== 'string') throw deviceUserValidationFailed('username is required');
      if (typeof body.verifierValue !== 'string' || typeof body.verifierSalt !== 'string') {
        throw deviceUserValidationFailed('verifierValue and verifierSalt are required');
      }
      const view = await createDeviceUser(deps, actorOf(req), {
        ...(typeof body.customerId === 'string' ? { customerId: body.customerId } : {}),
        username: body.username,
        ...(body.displayName !== undefined ? { displayName: optionalString(body.displayName, 'displayName') } : {}),
        verifierValue: body.verifierValue,
        verifierSalt: body.verifierSalt,
        ...(body.verifierKdf !== undefined ? { verifierKdf: optionalString(body.verifierKdf, 'verifierKdf') } : {}),
        ...(body.verifierVersion !== undefined
          ? { verifierVersion: optionalString(body.verifierVersion, 'verifierVersion') }
          : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
      });
      return { status: 201, body: { data: view, meta: meta(req) } };
    },
  );

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device-user:read' },
    async (req) => {
      const q = req.query ?? {};
      const items = await listDeviceUsers(deps, actorOf(req), {
        ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
        ...(q.keyword !== undefined ? { keyword: q.keyword } : {}),
      });
      return { status: 200, body: { data: items, meta: meta(req) } };
    },
  );

  const detail = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device-user:read' },
    async (req) => {
      const view = await getDeviceUser(deps, actorOf(req), requireUserId(req));
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const update = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device-user:write' },
    async (req) => {
      const body = bodyOf(req);
      rejectPlaintextPassword(body);
      const view = await updateDeviceUser(deps, actorOf(req), {
        ...writeInputOf(req),
        ...(body.displayName !== undefined
          ? { displayName: body.displayName === null ? null : optionalString(body.displayName, 'displayName') }
          : {}),
        ...(body.verifierValue !== undefined
          ? { verifierValue: typeof body.verifierValue === 'string' ? body.verifierValue : '' }
          : {}),
        ...(body.verifierSalt !== undefined
          ? { verifierSalt: typeof body.verifierSalt === 'string' ? body.verifierSalt : '' }
          : {}),
        ...(body.verifierKdf !== undefined ? { verifierKdf: optionalString(body.verifierKdf, 'verifierKdf') } : {}),
        ...(body.verifierVersion !== undefined
          ? { verifierVersion: optionalString(body.verifierVersion, 'verifierVersion') }
          : {}),
      });
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const disable = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device-user:write' },
    async (req) => {
      const view = await disableDeviceUser(deps, actorOf(req), writeInputOf(req));
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const assign = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device-user:write' },
    async (req) => {
      const result = await assignDevices(deps, actorOf(req), {
        ...writeInputOf(req),
        deviceIds: requireDeviceIds(bodyOf(req)),
      });
      return { status: 201, body: { data: result, meta: meta(req) } };
    },
  );

  const revoke = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device-user:write' },
    async (req) => {
      const result = await revokeDevices(deps, actorOf(req), {
        ...writeInputOf(req),
        deviceIds: requireDeviceIds(bodyOf(req)),
      });
      return { status: 200, body: { data: result, meta: meta(req) } };
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
    update: wrap(update),
    disable: wrap(disable),
    assign: wrap(assign),
    revoke: wrap(revoke),
  };
}
