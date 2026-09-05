/**
 * BE-MED-01 管理端 Media API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（media:read：全平台角色 + CustomerAdmin/CustomerViewer；
 * Customer 角色强制 actor.customerId 租户隔离）→ Service。路由：
 * - GET /api/v1/admin/media                        列表（筛选 + 键集游标分页）
 * - GET /api/v1/admin/media/{mediaId}/download-url 15 分钟预签名下载 URL
 * 响应契约对齐 CT-05；V1 不提供实时流媒体会话（DEC-009）。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../admin/onboarding/handler.js';
import { MediaError, mediaValidationFailed } from './errors.js';
import { createMediaDownloadUrl, listMedia } from './service.js';
import type { MediaDeps } from './service.js';

export type AdminMediaHandlerDeps = MediaDeps;

export interface AdminMediaHandlers {
  listMedia(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  createDownloadUrl(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof MediaError) {
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

export function createAdminMediaHandlers(deps: AdminMediaHandlerDeps): AdminMediaHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest, nextCursor?: string | null) => ({
    requestId: req.requestId,
    timestamp: now().toISOString(),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'media:read' }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const page = await listMedia(deps, req.actor as ActorContext, {
      ...(q.deviceId !== undefined ? { deviceId: q.deviceId } : {}),
      ...(q.mediaType !== undefined ? { mediaType: q.mediaType } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
      ...(q.from !== undefined ? { from: q.from } : {}),
      ...(q.to !== undefined ? { to: q.to } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
    return { status: 200, body: { data: page.items, meta: meta(req, page.nextCursor) } };
  });

  const download = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'media:read' }, async (req) => {
    const mediaId = req.params?.mediaId;
    if (!mediaId) throw mediaValidationFailed('mediaId path parameter is required');
    const view = await createMediaDownloadUrl(deps, req.actor as ActorContext, mediaId);
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

  return { listMedia: wrap(list), createDownloadUrl: wrap(download) };
}
