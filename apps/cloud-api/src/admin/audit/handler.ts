/**
 * BE-AUD-01 审计日志查询 API Handler（框架无关，只读）。
 *
 * 接线：AUTH-01 withAuthorization（audit:read——V1 矩阵仅 PlatformSuperAdmin/Auditor
 * 持有，DEC-012 固定只读）→ Service。路由：
 * - GET /api/v1/admin/audit-logs            列表（筛选 + 键集游标分页）
 * - GET /api/v1/admin/audit-logs/{auditId}  详情（脱敏前后值；跨 Customer → 404）
 * 只读：不存在任何修改/删除路由。功能边界：不查询 CloudTrail 和基础设施日志。
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminAuditError, auditValidationFailed } from './errors.js';
import { getAuditLogDetail, listAuditLogs } from './service.js';
import type { AuditQueryDeps } from './service.js';

export type AdminAuditHandlerDeps = AuditQueryDeps;

export interface AdminAuditHandlers {
  listAuditLogs(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  getAuditLogDetail(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminAuditError) {
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

export function createAdminAuditHandlers(deps: AdminAuditHandlerDeps): AdminAuditHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest, nextCursor?: string | null) => ({
    requestId: req.requestId,
    timestamp: now().toISOString(),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'audit:read' }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const page = await listAuditLogs(deps, req.actor as ActorContext, {
      ...(q.actorId !== undefined ? { actorId: q.actorId } : {}),
      ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
      ...(q.objectType !== undefined ? { objectType: q.objectType } : {}),
      ...(q.objectId !== undefined ? { objectId: q.objectId } : {}),
      ...(q.action !== undefined ? { action: q.action } : {}),
      ...(q.result !== undefined ? { result: q.result } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
    return { status: 200, body: { data: page.items, meta: meta(req, page.nextCursor) } };
  });

  const detail = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'audit:read' }, async (req) => {
    const auditId = req.params?.auditId;
    if (!auditId) throw auditValidationFailed('auditId path parameter is required');
    const view = await getAuditLogDetail(deps, req.actor as ActorContext, auditId);
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

  return { listAuditLogs: wrap(list), getAuditLogDetail: wrap(detail) };
}
