/**
 * BE-RPL-01 消息重放管理 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization({permission: 'replay:create'})（权限矩阵持有者
 * PlatformSuperAdmin/PlatformOperator，技术对接要求仅这两类角色）→ Service/Repository。
 * 路由：
 * - POST /api/v1/admin/replay/jobs（创建，201 + 审计）
 * - GET  /api/v1/admin/replay/jobs（列表，键集游标分页，customerId/status 过滤）
 * - GET  /api/v1/admin/replay/jobs/{jobId}（详情，含成功/跳过/失败统计 resultSummary）
 */
import type { DbClient } from '@fdp/database';
import { AuthError, withAuthorization } from '@fdp/auth';
import { AdminOnboardingError } from '../onboarding/errors.js';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { findReplayJobById, listReplayJobs } from './repository.js';
import { createReplayJob, parseReplayScope } from './service.js';

export interface AdminReplayHandlerDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export interface AdminReplayHandlers {
  create(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  list(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  detail(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function toErrorResponse(err: unknown, requestId: string): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminOnboardingError) {
    return { status: err.httpStatus, body: { error: { code: err.code, message: err.message, requestId } } };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } },
  };
}

function guard(
  handler: (req: AdminHttpRequest) => Promise<AdminHttpResponse>,
): (req: AdminHttpRequest) => Promise<AdminHttpResponse> {
  const guarded = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'replay:create' }, handler);
  return async (req) => {
    try {
      return await guarded(req);
    } catch (err) {
      return toErrorResponse(err, req.requestId);
    }
  };
}

export function createAdminReplayHandlers(deps: AdminReplayHandlerDeps): AdminReplayHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });

  return {
    create: guard(async (req) => {
      const scope = await parseReplayScope(deps.client, req.body);
      const view = await createReplayJob(deps.client, scope, req.actor as never);
      return { status: 201, body: { data: view, meta: meta(req) } };
    }),
    list: guard(async (req) => {
      const limitRaw = req.query?.limit;
      const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new AdminOnboardingError('VALIDATION_FAILED', `limit must be an integer in [1, ${MAX_LIMIT}]`);
      }
      const page = await listReplayJobs(deps.client, {
        limit,
        cursor: req.query?.cursor,
        customerId: req.query?.customerId,
        status: req.query?.status,
      });
      return {
        status: 200,
        body: { data: page.items, meta: { ...meta(req), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) } },
      };
    }),
    detail: guard(async (req) => {
      const jobId = req.params?.jobId;
      if (!jobId) throw new AdminOnboardingError('VALIDATION_FAILED', 'path param jobId is required');
      const view = await findReplayJobById(deps.client, jobId);
      return { status: 200, body: { data: view, meta: meta(req) } };
    }),
  };
}
