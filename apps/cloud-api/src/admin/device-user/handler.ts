/**
 * BE-DUSR-01 Device User 管理 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（device-user:write = PlatformSuperAdmin/CustomerAdmin
 * （DEC-012 矩阵：Operator 无 device-user 权限；CustomerAdmin 租户强制）；
 * device-user:read = SuperAdmin/Auditor/CustomerAdmin/CustomerViewer + Customer 租户隔离）→ Service。
 * 路由：
 * - POST  /api/v1/admin/device-users                          创建（受控接收密码，立即派生 Argon2id PHC）
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
import { VerifierError } from './verifier.js';
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
import { assertOptionalStringFields, parseStrictObject } from '../shared/strict-object.js';

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

function bodyOf(req: AdminHttpRequest, allowedKeys: readonly string[]): Record<string, unknown> {
  return parseStrictObject(req.body ?? {}, allowedKeys, deviceUserValidationFailed);
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

/** DEC-004：只允许受控 password 写入；拒收云端 Hash 或冻结前四组件。 */
function rejectPrecomputedVerifier(body: Record<string, unknown>): void {
  if (
    'plainPassword' in body ||
    'passwordHash' in body ||
    'verifierValue' in body ||
    'verifierSalt' in body ||
    'verifierKdf' in body ||
    'verifierVersion' in body
  ) {
    throw deviceUserValidationFailed('Precomputed or cloud password hashes are not accepted');
  }
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminDeviceUserError || err instanceof VerifierError) {
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
  const writeInputOf = (req: AdminHttpRequest, allowedKeys: readonly string[]) => ({
    deviceUserId: requireUserId(req),
    ifMatchVersion: parseIfMatch(headerOf(req, 'If-Match')),
    reason: requireReason(bodyOf(req, allowedKeys)),
  });

  const create = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device-user:write' },
    async (req) => {
      const body = bodyOf(req, ['customerId', 'username', 'displayName', 'password', 'reason']);
      assertOptionalStringFields(body, ['customerId', 'displayName', 'reason'], deviceUserValidationFailed);
      rejectPrecomputedVerifier(body);
      if (typeof body.username !== 'string') throw deviceUserValidationFailed('username is required');
      if (typeof body.password !== 'string') throw deviceUserValidationFailed('password is required');
      const view = await createDeviceUser(deps, actorOf(req), {
        ...(typeof body.customerId === 'string' ? { customerId: body.customerId } : {}),
        username: body.username,
        ...(body.displayName !== undefined ? { displayName: optionalString(body.displayName, 'displayName') } : {}),
        password: body.password,
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
      const body = bodyOf(req, ['displayName', 'password', 'reason']);
      rejectPrecomputedVerifier(body);
      if (body.password !== undefined && typeof body.password !== 'string') {
        throw deviceUserValidationFailed('password must be a string');
      }
      const view = await updateDeviceUser(deps, actorOf(req), {
        ...writeInputOf(req, ['displayName', 'password', 'reason']),
        ...(body.displayName !== undefined
          ? { displayName: body.displayName === null ? null : optionalString(body.displayName, 'displayName') }
          : {}),
        ...(typeof body.password === 'string' ? { password: body.password } : {}),
      });
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const disable = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device-user:write' },
    async (req) => {
      const view = await disableDeviceUser(deps, actorOf(req), writeInputOf(req, ['reason']));
      return { status: 200, body: { data: view, meta: meta(req) } };
    },
  );

  const assign = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device-user:write' },
    async (req) => {
      const result = await assignDevices(deps, actorOf(req), {
        ...writeInputOf(req, ['deviceIds', 'reason']),
        deviceIds: requireDeviceIds(bodyOf(req, ['deviceIds', 'reason'])),
      });
      return { status: 201, body: { data: result, meta: meta(req) } };
    },
  );

  const revoke = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'device-user:write' },
    async (req) => {
      const result = await revokeDevices(deps, actorOf(req), {
        ...writeInputOf(req, ['deviceIds', 'reason']),
        deviceIds: requireDeviceIds(bodyOf(req, ['deviceIds', 'reason'])),
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
