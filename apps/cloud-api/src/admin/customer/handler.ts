/**
 * BE-CUS-01 Customer 管理 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（Cognito actor 由适配层注入）→ Service/Repository。
 * 路由：
 * - GET    /api/v1/admin/customers                    列表（customer:read；键集游标分页 + status 筛选）
 * - POST   /api/v1/admin/customers                    创建（customer:write，201 + 审计）
 * - GET    /api/v1/admin/customers/{customerId}       详情（customer:read；Customer 角色仅可读自身）
 * - PATCH  /api/v1/admin/customers/{customerId}       更新名称（customer:write + If-Match + 审计）
 * - POST   /api/v1/admin/customers/{customerId}/deactivate 停用（customer:write + If-Match + 强制原因 + 审计）
 * - DELETE /api/v1/admin/customers/{customerId}       软删除（customer:write + If-Match + 审计；
 *                                                     关联有效设备/License 时 409；V1 不做物理删除）
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp[,nextCursor]}；
 * 错误 {error{code,message,requestId}}，未知异常一律 500 通用消息。
 */
import { AuthError, assertCustomerScope, hasPermission, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import type { DbClient } from '@fdp/database';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminCustomerError, customerNotFound, validationFailed } from './errors.js';
import { findCustomerById, listCustomers, toCustomerDto } from './repository.js';
import { createCustomer, deactivateCustomer, deleteCustomer, parseCustomerName, updateCustomer } from './service.js';

export interface AdminCustomerHandlerDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export interface AdminCustomerHandlers {
  list(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  create(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  detail(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  update(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  deactivate(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  remove(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function headerOf(req: AdminHttpRequest, name: string): string | undefined {
  return req.headers[name] ?? req.headers[name.toLowerCase()];
}

/** If-Match 解析（语义与 CT-05 parseIfMatch 一致）：缺失/非法 → 400 VALIDATION_FAILED。 */
function parseIfMatch(value: string | undefined): number {
  if (value === undefined || value === '') {
    throw validationFailed('The If-Match header is required for this operation');
  }
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw validationFailed('The If-Match header must be a non-negative integer version');
  }
  return version;
}

function requireCustomerId(req: AdminHttpRequest): string {
  const customerId = req.params?.customerId;
  if (!customerId) throw validationFailed('customerId path parameter is required');
  return customerId;
}

function bodyOf(req: AdminHttpRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminCustomerError) {
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

export function createAdminCustomerHandlers(deps: AdminCustomerHandlerDeps): AdminCustomerHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'customer:read' }, async (req) => {
    const page = await listCustomers(deps.client, {
      status: req.query?.status,
      cursor: req.query?.cursor,
      limit: req.query?.limit,
    });
    return {
      status: 200,
      body: { data: page.items.map(toCustomerDto), meta: { ...meta(req), nextCursor: page.nextCursor } },
    };
  });

  const create = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'customer:write' },
    async (req) => {
      const name = parseCustomerName(bodyOf(req).name);
      const created = await createCustomer(deps.client, req.actor as ActorContext, { name });
      return { status: 201, body: { data: toCustomerDto(created), meta: meta(req) } };
    },
  );

  // 详情：customer:read 持有者（平台三角色）可读任意 Customer；其余（Customer 角色）仅可读自身。
  const detail = withAuthorization<AdminHttpRequest, AdminHttpResponse>({}, async (req) => {
    const actor = req.actor as ActorContext;
    const customerId = requireCustomerId(req);
    if (!actor.roles.some((role) => hasPermission(role, 'customer:read'))) {
      assertCustomerScope(actor, customerId);
    }
    const record = await findCustomerById(deps.client, customerId);
    if (!record) throw customerNotFound();
    return { status: 200, body: { data: toCustomerDto(record), meta: meta(req) } };
  });

  const update = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'customer:write' },
    async (req) => {
      const name = parseCustomerName(bodyOf(req).name);
      const updated = await updateCustomer(deps.client, req.actor as ActorContext, {
        customerId: requireCustomerId(req),
        ifMatchVersion: parseIfMatch(headerOf(req, 'If-Match')),
        name,
      });
      return { status: 200, body: { data: toCustomerDto(updated), meta: meta(req) } };
    },
  );

  const deactivate = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'customer:write' },
    async (req) => {
      const reason = bodyOf(req).reason;
      const updated = await deactivateCustomer(deps.client, req.actor as ActorContext, {
        customerId: requireCustomerId(req),
        ifMatchVersion: parseIfMatch(headerOf(req, 'If-Match')),
        ...(typeof reason === 'string' ? { reason } : {}),
      });
      return { status: 200, body: { data: toCustomerDto(updated), meta: meta(req) } };
    },
  );

  const remove = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'customer:write' },
    async (req) => {
      const deleted = await deleteCustomer(deps.client, req.actor as ActorContext, {
        customerId: requireCustomerId(req),
        ifMatchVersion: parseIfMatch(headerOf(req, 'If-Match')),
      });
      return { status: 200, body: { data: toCustomerDto(deleted), meta: meta(req) } };
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
    list: wrap(list),
    create: wrap(create),
    detail: wrap(detail),
    update: wrap(update),
    deactivate: wrap(deactivate),
    remove: wrap(remove),
  };
}
