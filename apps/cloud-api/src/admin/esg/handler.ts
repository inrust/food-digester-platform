/**
 * BE-ESG-02 ESG 查询与 CSV 导出 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（查询 report:read 全角色；导出 export:create =
 * PlatformSuperAdmin/Auditor/CustomerAdmin；Customer 角色租户隔离）→ Service。
 * 路由：
 * - GET  /api/v1/admin/esg/overview              最近聚合窗口 + ACTIVE 计算版本
 * - GET  /api/v1/admin/esg/hourly                小时汇总（筛选 + 游标）
 * - GET  /api/v1/admin/esg/daily                 日汇总（筛选 + 游标）
 * - GET  /api/v1/admin/esg/reports               设备提交 Report（+reportType 筛选）
 * - GET  /api/v1/admin/esg/daily-summary         ESG 日汇总（含完整率/计算版本引用）
 * - GET  /api/v1/admin/esg/calculation-versions  计算版本查询
 * - POST /api/v1/admin/esg/exports               创建异步 CSV 导出（202 + 审计）
 * - GET  /api/v1/admin/esg/exports/{exportId}    导出状态；COMPLETED 且未过期返回短期 URL（过期不返回 + 下载审计）
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp[,nextCursor]}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminEsgError, esgValidationFailed } from './errors.js';
import {
  getEsgOverview,
  listEsgCalculationVersions,
  listEsgDaily,
  listEsgDailySummary,
  listEsgHourly,
  listEsgReports,
} from './service.js';
import type { EsgDeps, EsgFilter } from './service.js';
import { createEsgExport, getEsgExport } from './export-service.js';
import type { EsgExportDeps } from './export-service.js';

export type AdminEsgHandlerDeps = EsgDeps & EsgExportDeps;

export interface AdminEsgHandlers {
  overview(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listHourly(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listDaily(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listReports(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listDailySummary(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listCalculationVersions(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  createExport(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  exportDetail(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminEsgError) {
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

function filterOf(req: AdminHttpRequest): EsgFilter {
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  return {
    ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
    ...(q.siteId !== undefined ? { siteId: q.siteId } : {}),
    ...(q.deviceId !== undefined ? { deviceId: q.deviceId } : {}),
    ...(q.from !== undefined ? { from: q.from } : {}),
    ...(q.to !== undefined ? { to: q.to } : {}),
    ...(q.reportType !== undefined ? { reportType: q.reportType } : {}),
    ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
  };
}

export function createAdminEsgHandlers(deps: AdminEsgHandlerDeps): AdminEsgHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest, nextCursor?: string | null) => ({
    requestId: req.requestId,
    timestamp: now().toISOString(),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });
  const actorOf = (req: AdminHttpRequest) => req.actor as ActorContext;

  const read = (fn: (req: AdminHttpRequest) => Promise<AdminHttpResponse>) =>
    withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'report:read' }, fn);

  const overview = read(async (req) => {
    const view = await getEsgOverview(deps, actorOf(req), filterOf(req));
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const paged = (
    listFn: (actor: ActorContext, filter: EsgFilter) => Promise<{ items: unknown[]; nextCursor: string | null }>,
  ) =>
    read(async (req) => {
      const page = await listFn(actorOf(req), filterOf(req));
      return { status: 200, body: { data: page.items, meta: meta(req, page.nextCursor) } };
    });

  const listHourly = paged((actor, filter) => listEsgHourly(deps, actor, filter));
  const listDaily = paged((actor, filter) => listEsgDaily(deps, actor, filter));
  const listReports = paged((actor, filter) => listEsgReports(deps, actor, filter));
  const listDailySummaryH = paged((actor, filter) => listEsgDailySummary(deps, actor, filter));

  const listVersions = read(async (req) => {
    const items = await listEsgCalculationVersions(deps);
    return { status: 200, body: { data: items, meta: meta(req) } };
  });

  const createExport = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'export:create' },
    async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.dataset !== 'string') throw esgValidationFailed('dataset is required');
      const view = await createEsgExport(deps, actorOf(req), {
        dataset: body.dataset,
        ...(typeof body.customerId === 'string' ? { customerId: body.customerId } : {}),
        ...(typeof body.siteId === 'string' ? { siteId: body.siteId } : {}),
        ...(typeof body.deviceId === 'string' ? { deviceId: body.deviceId } : {}),
        ...(typeof body.from === 'string' ? { from: body.from } : {}),
        ...(typeof body.to === 'string' ? { to: body.to } : {}),
      });
      return { status: 202, body: { data: view, meta: meta(req) } };
    },
  );

  const exportDetail = read(async (req) => {
    const exportId = req.params?.exportId;
    if (!exportId) throw esgValidationFailed('exportId path parameter is required');
    const view = await getEsgExport(deps, actorOf(req), exportId);
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

  return {
    overview: wrap(overview),
    listHourly: wrap(listHourly),
    listDaily: wrap(listDaily),
    listReports: wrap(listReports),
    listDailySummary: wrap(listDailySummaryH),
    listCalculationVersions: wrap(listVersions),
    createExport: wrap(createExport),
    exportDetail: wrap(exportDetail),
  };
}
