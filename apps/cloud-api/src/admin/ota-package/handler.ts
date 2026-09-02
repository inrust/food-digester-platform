/**
 * BE-OTA-01 Firmware Package API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization（写操作 ota:write = PlatformSuperAdmin/PlatformOperator；
 * 查询 ota:read = +Auditor；Customer 角色无 OTA 权限 → 403）→ Service。路由：
 * - POST /api/v1/admin/ota/packages/upload-sessions        创建上传会话（201；重复 → 409）
 * - POST /api/v1/admin/ota/packages/{packageId}/complete   上传后校验 → VERIFIED（不可变）
 * - GET  /api/v1/admin/ota/packages                        列表（筛选 + 键集游标分页；可发布 = VERIFIED）
 * - GET  /api/v1/admin/ota/packages/{packageId}            详情
 * 功能边界：不实现设备端验签、安装和回滚。
 * 响应契约对齐 CT-05：data + meta{requestId,timestamp}；错误 {error{code,message,requestId}}。
 */
import { AuthError, withAuthorization } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { AdminOtaPackageError, otaValidationFailed } from './errors.js';
import {
  completeFirmwareUpload,
  createFirmwareUploadSession,
  getFirmwarePackage,
  listFirmwarePackages,
} from './service.js';
import type { OtaPackageDeps } from './service.js';

export type AdminOtaPackageHandlerDeps = OtaPackageDeps;

export interface AdminOtaPackageHandlers {
  createUploadSession(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  completeUpload(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  listPackages(req: AdminHttpRequest): Promise<AdminHttpResponse>;
  getPackage(req: AdminHttpRequest): Promise<AdminHttpResponse>;
}

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: AdminHttpRequest): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminOtaPackageError) {
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

function requirePackageId(req: AdminHttpRequest): string {
  const packageId = req.params?.packageId;
  if (!packageId) throw otaValidationFailed('packageId path parameter is required');
  return packageId;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw otaValidationFailed(`${field} is required`);
  return value;
}

export function createAdminOtaPackageHandlers(deps: AdminOtaPackageHandlerDeps): AdminOtaPackageHandlers {
  const now = deps.now ?? (() => new Date());
  const meta = (req: AdminHttpRequest, nextCursor?: string | null) => ({
    requestId: req.requestId,
    timestamp: now().toISOString(),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  });

  const create = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'ota:write' }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.sizeBytes !== 'number') throw otaValidationFailed('sizeBytes is required');
    const view = await createFirmwareUploadSession(deps, req.actor as ActorContext, {
      model: requireString(body, 'model'),
      version: requireString(body, 'version'),
      packageType: requireString(body, 'packageType'),
      sizeBytes: body.sizeBytes,
      sha256: requireString(body, 'sha256'),
      signature: requireString(body, 'signature'),
    });
    return { status: 201, body: { data: view, meta: meta(req) } };
  });

  const complete = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'ota:write' }, async (req) => {
    const view = await completeFirmwareUpload(deps, req.actor as ActorContext, requirePackageId(req));
    return { status: 200, body: { data: view, meta: meta(req) } };
  });

  const list = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'ota:read' }, async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const page = await listFirmwarePackages(deps, {
      ...(q.model !== undefined ? { model: q.model } : {}),
      ...(q.version !== undefined ? { version: q.version } : {}),
      ...(q.packageType !== undefined ? { packageType: q.packageType } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
    return { status: 200, body: { data: page.items, meta: meta(req, page.nextCursor) } };
  });

  const get = withAuthorization<AdminHttpRequest, AdminHttpResponse>({ permission: 'ota:read' }, async (req) => {
    const view = await getFirmwarePackage(deps, requirePackageId(req));
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
    createUploadSession: wrap(create),
    completeUpload: wrap(complete),
    listPackages: wrap(list),
    getPackage: wrap(get),
  };
}
