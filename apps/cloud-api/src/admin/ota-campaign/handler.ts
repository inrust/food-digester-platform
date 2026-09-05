/**
 * BE-OTA-02 OTA Campaign API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（写操作 ota:write = PlatformSuperAdmin/PlatformOperator；
 * 查询 ota:read = +Auditor；Customer 角色无 OTA 权限 → 403）→ Service。路由：
 * - POST /api/v1/admin/ota/campaigns                     创建（强制首批 1 台 → RUNNING，201）
 * - GET  /api/v1/admin/ota/campaigns                     列表（筛选 + 键集游标分页）
 * - GET  /api/v1/admin/ota/campaigns/{campaignId}        详情（含 target 状态计数）
 * - GET  /api/v1/admin/ota/campaigns/{campaignId}/targets 目标列表（状态看板）
 * - POST /api/v1/admin/ota/campaigns/{campaignId}/batches 扩大批次（仅 RUNNING；禁止全量）
 * - POST /api/v1/admin/ota/campaigns/{campaignId}/pause   暂停（幂等回放）
 * - POST /api/v1/admin/ota/campaigns/{campaignId}/resume  恢复（幂等回放）
 * - POST /api/v1/admin/ota/campaigns/{campaignId}/cancel  取消（级联未完成 target → CANCELLED）
 * - POST /api/v1/admin/ota/campaigns/{campaignId}/retry   失败重试（FAILED → PENDING）
 * 功能边界：不执行固件安装；MQTT 下发与 ACK 属 BE-OTA-03。
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminOtaCampaignError, otaCampaignValidationFailed } from './errors.js';
import {
  cancelOtaCampaign,
  createOtaCampaign,
  expandOtaCampaignBatch,
  getOtaCampaign,
  listOtaCampaigns,
  listOtaTargets,
  pauseOtaCampaign,
  resumeOtaCampaign,
  retryOtaCampaignFailures,
} from './service.js';
import type { OtaCampaignDeps } from './service.js';

export type AdminOtaCampaignHandlerDeps = OtaCampaignDeps;

export interface AdminOtaCampaignHandlers {
  createCampaign(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listCampaigns(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  getCampaign(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listTargets(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  expandBatch(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  pauseCampaign(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  resumeCampaign(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  cancelCampaign(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  retryCampaign(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminOtaCampaignError) {
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

function requireCampaignId(req: AdminHttpRequest): string {
  const campaignId = req.params?.campaignId;
  if (!campaignId) throw otaCampaignValidationFailed('campaignId path parameter is required');
  return campaignId;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw otaCampaignValidationFailed(`${field} is required`);
  return value;
}

function requireStringArray(body: Record<string, unknown>, field: string): string[] {
  const value = body[field];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw otaCampaignValidationFailed(`${field} must be an array of strings`);
  }
  return value as string[];
}

function optionalStringArray(body: Record<string, unknown>, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  return requireStringArray(body, field);
}

export function createAdminOtaCampaignHandlers(deps: AdminOtaCampaignHandlerDeps): AdminOtaCampaignHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest, nextCursor?: string | null) => ({
    requestId: req.requestId,
    timestamp: now().toISOString(),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });

  const create = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'ota:write' }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const view = await createOtaCampaign(deps, req.actor as ActorContext, {
      name: requireString(body, 'name'),
      packageId: requireString(body, 'packageId'),
      deviceIds: requireStringArray(body, 'deviceIds'),
    });
    return { status: 201, body: { data: view, meta: meta(req) } };
  });

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'ota:read' }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const page = await listOtaCampaigns(deps, {
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.targetModel !== undefined ? { targetModel: q.targetModel } : {}),
      ...(q.packageId !== undefined ? { packageId: q.packageId } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
    return { status: 200, body: { data: page.items, meta: meta(req, page.nextCursor) } };
  });

  const get = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'ota:read' }, async (req) => {
    const view = await getOtaCampaign(deps, requireCampaignId(req));
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const targets = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'ota:read' }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const page = await listOtaTargets(deps, requireCampaignId(req), {
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.batchNo !== undefined ? { batchNo: q.batchNo } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
    return { status: 200, body: { data: page.items, meta: meta(req, page.nextCursor) } };
  });

  const expand = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'ota:write' }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await expandOtaCampaignBatch(deps, req.actor as ActorContext, requireCampaignId(req), {
      deviceIds: requireStringArray(body, 'deviceIds'),
    });
    return { status: 201, body: { data: result, meta: meta(req) } };
  });

  const transition =
    (fn: (deps: OtaCampaignDeps, actor: ActorContext, campaignId: string) => Promise<unknown>) =>
    async (req: AdminHttpRequest): Promise<AdminHttpResponse> => {
      const view = await fn(deps, req.actor as ActorContext, requireCampaignId(req));
      return { status: 200, body: { data: view, meta: meta(req) } };
    };

  const pause = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'ota:write' },
    transition(pauseOtaCampaign),
  );
  const resume = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'ota:write' },
    transition(resumeOtaCampaign),
  );
  const cancel = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'ota:write' },
    transition(cancelOtaCampaign),
  );

  const retry = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'ota:write' }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await retryOtaCampaignFailures(deps, req.actor as ActorContext, requireCampaignId(req), {
      targetIds: optionalStringArray(body, 'targetIds'),
    });
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
    createCampaign: wrap(create),
    listCampaigns: wrap(list),
    getCampaign: wrap(get),
    listTargets: wrap(targets),
    expandBatch: wrap(expand),
    pauseCampaign: wrap(pause),
    resumeCampaign: wrap(resume),
    cancelCampaign: wrap(cancel),
    retryCampaign: wrap(retry),
  };
}
