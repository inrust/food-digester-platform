/**
 * BE-CUS-02 Site 管理 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（Cognito actor 由适配层注入）→ Service/Repository。
 * 路由：
 * - GET    /api/v1/admin/sites                  列表（site:read；customerId/region/subregion/status 筛选 + 键集游标分页；
 *                                               Customer 角色强制所属 Customer scope）
 * - POST   /api/v1/admin/sites                  创建（site:write，Customer 存在性校验 + 审计）
 * - GET    /api/v1/admin/sites/{siteId}         详情（site:read；Customer 角色仅本 Customer 站点；含设备数量）
 * - PATCH  /api/v1/admin/sites/{siteId}         更新（site:write + If-Match；customerId 不可变 + 审计）
 * - POST   /api/v1/admin/sites/{siteId}/deactivate 停用（site:write + If-Match + 强制原因 + 审计）
 * - DELETE /api/v1/admin/sites/{siteId}         软删除（site:write + If-Match + 审计；有关联设备时 409）
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp[,nextCursor]}；
 * 错误 {error{code,message,requestId}}，未知异常一律 500 通用消息。
 */
import { AuthError, assertCustomerScope, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import type { DbClient } from '@fdp/database';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminSiteError, siteNotFound, siteValidationFailed } from './errors.js';
import { findSiteById, listSites, toSiteDto } from './repository.js';
import { createSite, deactivateSite, deleteSite, parseSiteCreate, parseSiteUpdate, updateSite } from './service.js';

export interface AdminSiteHandlerDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export interface AdminSiteHandlers {
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
    throw siteValidationFailed('The If-Match header is required for this operation');
  }
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) {
    throw siteValidationFailed('The If-Match header must be a non-negative integer version');
  }
  return version;
}

function requireSiteId(req: AdminHttpRequest): string {
  const siteId = req.params?.siteId;
  if (!siteId) throw siteValidationFailed('siteId path parameter is required');
  return siteId;
}

/**
 * Customer 范围由服务端身份上下文注入（规范 §3）：Customer 角色的有效 customerId 恒为
 * actor.customerId；query 中的 customerId 仅用于与 actor scope 比对（不一致 → 403）。
 */
function effectiveCustomerFilter(actor: ActorContext, queryCustomerId: string | undefined): string | undefined {
  if (actor.actorType === 'customer') {
    if (queryCustomerId !== undefined) assertCustomerScope(actor, queryCustomerId);
    return actor.customerId ?? undefined;
  }
  return queryCustomerId;
}

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminSiteError) {
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

export function createAdminSiteHandlers(deps: AdminSiteHandlerDeps): AdminSiteHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'site:read' }, async (req) => {
    const actor = req.actor as ActorContext;
    const page = await listSites(deps.client, {
      customerId: effectiveCustomerFilter(actor, req.query?.customerId),
      region: req.query?.region,
      subregion: req.query?.subregion,
      status: req.query?.status,
      cursor: req.query?.cursor,
      limit: req.query?.limit,
    });
    return {
      status: 200,
      body: { data: page.items.map(toSiteDto), meta: { ...meta(req), nextCursor: page.nextCursor } },
    };
  });

  const create = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'site:write' }, async (req) => {
    const input = parseSiteCreate(req.body);
    const created = await createSite(deps.client, req.actor as ActorContext, input);
    return { status: 201, body: { data: toSiteDto(created), meta: meta(req) } };
  });

  const detail = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'site:read' }, async (req) => {
    const record = await findSiteById(deps.client, requireSiteId(req));
    if (!record) throw siteNotFound();
    const actor = req.actor as ActorContext;
    if (actor.actorType === 'customer') assertCustomerScope(actor, record.customerId);
    return { status: 200, body: { data: toSiteDto(record), meta: meta(req) } };
  });

  const update = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'site:write' }, async (req) => {
    const patch = parseSiteUpdate(req.body);
    const updated = await updateSite(deps.client, req.actor as ActorContext, {
      siteId: requireSiteId(req),
      ifMatchVersion: parseIfMatch(headerOf(req, 'If-Match')),
      patch,
    });
    return { status: 200, body: { data: toSiteDto(updated), meta: meta(req) } };
  });

  const deactivate = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'site:write' },
    async (req) => {
      const reason = (req.body ?? {}) as Record<string, unknown>;
      const updated = await deactivateSite(deps.client, req.actor as ActorContext, {
        siteId: requireSiteId(req),
        ifMatchVersion: parseIfMatch(headerOf(req, 'If-Match')),
        ...(typeof reason.reason === 'string' ? { reason: reason.reason } : {}),
      });
      return { status: 200, body: { data: toSiteDto(updated), meta: meta(req) } };
    },
  );

  const remove = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'site:write' }, async (req) => {
    const deleted = await deleteSite(deps.client, req.actor as ActorContext, {
      siteId: requireSiteId(req),
      ifMatchVersion: parseIfMatch(headerOf(req, 'If-Match')),
    });
    return { status: 200, body: { data: toSiteDto(deleted), meta: meta(req) } };
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
    list: wrap(list),
    create: wrap(create),
    detail: wrap(detail),
    update: wrap(update),
    deactivate: wrap(deactivate),
    remove: wrap(remove),
  };
}
