/**
 * BE-DASH-01 管理后台总览聚合 API Handler（框架无关，只读）。
 *
 * 接线：AUTH-01 withAuthorization（dashboard:read——全角色持有；Customer 角色租户隔离
 * 在 Service 层强制）→ Service。路由：
 * - GET /api/v1/admin/dashboard/overview  总览聚合（Contract/设备/在线率/今日 ESG/告警/设备卡片）
 * 只读：不存在写路由；不在查询中执行命令或 OTA（只返回版本化 capability 描述）。
 * 功能边界：不返回 AWS CPU、队列深度等运维指标。
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { getDashboardOverview } from './service.js';
import type { DashboardDeps } from './service.js';

export type AdminDashboardHandlerDeps = DashboardDeps;

export interface AdminDashboardHandlers {
  getOverview(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError) {
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

export function createAdminDashboardHandlers(deps: AdminDashboardHandlerDeps): AdminDashboardHandlers {
  const now = deps.now ?? (() => new Date());

  const overview = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'dashboard:read' },
    async (req) => {
      const view = await getDashboardOverview(deps, req.actor as ActorContext, req.requestId);
      return {
        status: 200,
        body: { data: view, meta: { requestId: req.requestId, timestamp: now().toISOString() } },
      };
    },
  );

  return {
    getOverview: async (req) => {
      try {
        return await overview(req);
      } catch (err) {
        return toErrorResponse(err, req);
      }
    },
  };
}
