/**
 * BE-SYNC-02 Deactivate API Handler：POST /api/v1/device/deactivate（框架无关）。
 *
 * 接线：专用 deactivate 身份校验（Retired 设备在证书撤销前必须可达；AUTH-03 通用校验对
 * Retired 一律 403，故不复用）→ confirmDeactivation。
 * 响应：data（退役视图 + 已撤销证书摘要）+ meta{requestId,timestamp}（CT-05）；
 * 错误：401 UNAUTHENTICATED / 403 FORBIDDEN / 404 NOT_FOUND / 409 CONFLICT |
 * DEVICE_STATE_NOT_ALLOWED / 500 通用消息。不泄露证书材料。
 */
import { AuthError } from '@fdp/auth';
import type { ClientCertIdentity } from '@fdp/auth';
import type { DbClient } from '@fdp/database';
import { mapDbErrorToHttp } from '@fdp/database';
import { DeviceDeactivateError, confirmDeactivation, verifyDeactivateIdentity } from './deactivate.js';

export interface DeviceDeactivateRequest {
  readonly identity?: ClientCertIdentity | undefined;
  readonly body?: unknown;
  readonly requestId: string;
}

export interface DeviceDeactivateResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface DeviceDeactivateHandlerDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

const SENSITIVE_LEAK_PATTERN =
  /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret|pem|private)/i;

function toErrorResponse(err: unknown, req: DeviceDeactivateRequest): DeviceDeactivateResponse {
  if (err instanceof AuthError || err instanceof DeviceDeactivateError) {
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

export function createDeviceDeactivateHandler(
  deps: DeviceDeactivateHandlerDeps,
): (req: DeviceDeactivateRequest) => Promise<DeviceDeactivateResponse> {
  const now = deps.now ?? (() => new Date());
  return async (req) => {
    try {
      const identity = await verifyDeactivateIdentity(deps.client, req.identity, now());
      const result = await confirmDeactivation(deps.client, identity, now);
      return {
        status: 200,
        body: { data: result, meta: { requestId: req.requestId, timestamp: now().toISOString() } },
      };
    } catch (err) {
      return toErrorResponse(err, req);
    }
  };
}
