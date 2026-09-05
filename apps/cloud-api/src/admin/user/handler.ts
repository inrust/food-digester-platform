/**
 * BE-RBAC-01 用户/角色/Scope 管理 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（列表 user:read；写操作 user:write——V1 矩阵中仅
 * PlatformSuperAdmin 持有，DEC-012 固定只读）→ Service。路由：
 * - GET /api/v1/admin/users                         列表（筛选 + 键集游标分页）
 * - POST /api/v1/admin/users                        邀请（Cognito 临时凭证，API 不接收永久密码）
 * - PUT  /api/v1/admin/users/{userId}/roles         角色分配（整体替换）
 * - PUT  /api/v1/admin/users/{userId}/scope         Customer scope 变更
 * - POST /api/v1/admin/users/{userId}/disable       停用（幂等回放）
 * - POST /api/v1/admin/users/{userId}/password-reset 受控密码重置触发（响应不含凭证材料）
 * 功能边界：不负责 Cognito 租户运维、MFA 客服重置和人工账号恢复。
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminUserError, userValidationFailed } from './errors.js';
import {
  assignUserRoles,
  disableUser,
  inviteUser,
  listUsers,
  setUserScope,
  triggerUserPasswordReset,
} from './service.js';
import type { UserAdminDeps } from './service.js';

export type AdminUserHandlerDeps = UserAdminDeps;

export interface AdminUserHandlers {
  listUsers(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  inviteUser(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  assignRoles(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  setScope(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  disableUser(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  triggerPasswordReset(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminUserError) {
    const message = SENSITIVE_LEAK_PATTERN.test(err.message) ? 'The request failed' : err.message;
    return { status: err.httpStatus, body: { error: { code: err.code, message, requestId: req.requestId } } };
  }
  const mapped = mapDbErrorToHttp(err);
  if (mapped.status !== 500) {
    return {
      status: mapped.status,
      body: { error: { code: mapped.code, message: 'The request failed', requestId: req.requestId } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: req.requestId } },
  };
}

function requireUserId(req: AdminHttpRequest): string {
  const userId = req.params?.userId;
  if (!userId) throw userValidationFailed('userId path parameter is required');
  return userId;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw userValidationFailed(`${field} is required`);
  return value;
}

function requireRoleArray(body: Record<string, unknown>): string[] {
  const value = body.roles;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw userValidationFailed('roles must be an array of strings');
  }
  return value as string[];
}

export function createAdminUserHandlers(deps: AdminUserHandlerDeps): AdminUserHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest, nextCursor?: string | null) => ({
    requestId: req.requestId,
    timestamp: now().toISOString(),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'user:read' }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const page = await listUsers(deps, req.actor as ActorContext, {
      ...(q.roleType !== undefined ? { roleType: q.roleType } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
      ...(q.q !== undefined ? { q: q.q } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
    return { status: 200, body: { data: page.items, meta: meta(req, page.nextCursor) } };
  });

  const invite = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'user:write' }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const view = await inviteUser(deps, req.actor as ActorContext, {
      email: requireString(body, 'email'),
      displayName: requireString(body, 'displayName'),
      roles: requireRoleArray(body),
      ...(body.customerId !== undefined ? { customerId: requireString(body, 'customerId') } : {}),
    });
    return { status: 201, body: { data: view, meta: meta(req) } };
  });

  const roles = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'user:write' }, async (req) => {
    const view = await assignUserRoles(deps, req.actor as ActorContext, requireUserId(req), {
      roles: requireRoleArray((req.body ?? {}) as Record<string, unknown>),
    });
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const scope = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'user:write' }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const view = await setUserScope(deps, req.actor as ActorContext, requireUserId(req), {
      customerId: requireString(body, 'customerId'),
    });
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const disable = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'user:write' }, async (req) => {
    const view = await disableUser(deps, req.actor as ActorContext, requireUserId(req));
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const reset = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'user:write' }, async (req) => {
    const result = await triggerUserPasswordReset(deps, req.actor as ActorContext, requireUserId(req));
    return { status: 200, body: { data: result, meta: meta(req) } };
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
    listUsers: wrap(list),
    inviteUser: wrap(invite),
    assignRoles: wrap(roles),
    setScope: wrap(scope),
    disableUser: wrap(disable),
    triggerPasswordReset: wrap(reset),
  };
}
