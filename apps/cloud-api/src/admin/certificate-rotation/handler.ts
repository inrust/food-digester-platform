/**
 * BE-CERT-03 管理员证书轮换发起 API Handler（框架无关）。
 *
 * 接线：AUTH-01 withAuthorization({permission: 'certificate:rotate'})（权限矩阵唯一持有者
 * PlatformSuperAdmin）→ Service。
 * 路由：POST /api/v1/admin/devices/{deviceId}/certificate-rotation-requests
 * 201 新建 / 200 幂等重放；400/401/403/404/409 稳定错误码（CT-05）。
 */
import type { DbClient } from '@fdp/database';
import { AuthError, withAuthorization } from '@fdp/auth';
import { AdminOnboardingError } from '../onboarding/errors.js';
import type { AdminHttpRequest, AdminHttpResponse } from '../onboarding/handler.js';
import { createCertificateRotationRequest } from './service.js';

export interface AdminCertificateRotationHandlerDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export type AdminCertificateRotationHandler = (req: AdminHttpRequest) => Promise<AdminHttpResponse>;

function toErrorResponse(err: unknown, requestId: string): AdminHttpResponse {
  if (err instanceof AuthError || err instanceof AdminOnboardingError) {
    return { status: err.httpStatus, body: { error: { code: err.code, message: err.message, requestId } } };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } },
  };
}

export function createAdminCertificateRotationHandler(
  deps: AdminCertificateRotationHandlerDeps,
): AdminCertificateRotationHandler {
  const now = deps.now ?? (() => new Date());
  const guarded = withAuthorization<AdminHttpRequest, AdminHttpResponse>(
    { permission: 'certificate:rotate' },
    async (req) => {
      const deviceId = req.params?.deviceId;
      if (!deviceId) throw new AdminOnboardingError('VALIDATION_FAILED', 'path param deviceId is required');
      const result = await createCertificateRotationRequest(deps.client, deviceId, req.actor, now);
      return {
        status: result.replayed ? 200 : 201,
        body: { data: result.view, meta: { requestId: req.requestId, timestamp: now().toISOString() } },
      };
    },
  );
  return async (req) => {
    try {
      return await guarded(req);
    } catch (err) {
      return toErrorResponse(err, req.requestId);
    }
  };
}
