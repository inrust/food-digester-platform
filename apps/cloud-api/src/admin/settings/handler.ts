/**
 * BE-SET-01 业务设置与字典 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（读取 settings:read——PlatformSuperAdmin/Auditor；
 * 写入 settings:write——仅 PlatformSuperAdmin，DEC-012 固定矩阵）→ Service。路由：
 * - GET /api/v1/admin/settings          列表（封闭 key 集全部条目）
 * - GET /api/v1/admin/settings/{key}    读取单项（未知 key → 404）
 * - PUT /api/v1/admin/settings/{key}    更新（乐观锁 version；非法配置 → 400；并发 → 409）
 * 无新建/删除路由（固定 key 集）；不得改写固定协议枚举、Topic 或 AWS 运维配置。
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminSettingsError, settingsValidationFailed } from './errors.js';
import { getSetting, listSettings, updateSetting } from './service.js';
import type { SettingsDeps } from './service.js';

export type AdminSettingsHandlerDeps = SettingsDeps;

export interface AdminSettingsHandlers {
  listSettings(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  getSetting(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  updateSetting(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminSettingsError) {
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

function requireKey(req: AdminHttpRequest): string {
  const key = req.params?.key;
  if (!key) throw settingsValidationFailed('key path parameter is required');
  return key;
}

export function createAdminSettingsHandlers(deps: AdminSettingsHandlerDeps): AdminSettingsHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest) => ({ requestId: req.requestId, timestamp: now().toISOString() });

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'settings:read' }, async (req) => {
    const items = await listSettings(deps);
    return { status: 200, body: { data: items, meta: meta(req) } };
  });

  const get = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'settings:read' }, async (req) => {
    const view = await getSetting(deps, requireKey(req));
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const update = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'settings:write' },
    async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!('value' in body)) throw settingsValidationFailed('value is required');
      const view = await updateSetting(deps, req.actor as ActorContext, requireKey(req), {
        value: body.value,
        version: body.version,
      });
      return { status: 200, body: { data: view, meta: meta(req) } };
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

  return { listSettings: wrap(list), getSetting: wrap(get), updateSetting: wrap(update) };
}
