/**
 * BE-MED-01 设备端 Media 上传会话 Handler：POST /api/v1/device/media/upload-sessions（框架无关）。
 *
 * 接线：AUTH-03 verifyDeviceCertificate（mTLS 白名单；Retired 无例外——DEC-014 仅放行 Sync）→
 * createMediaUploadSession（类型/大小/配额/Hash 申报校验 + 设备前缀短期预签名 URL）。
 * 响应：data + meta{requestId,timestamp}（CT-05）；错误 400/401/403/409/500（不暴露内部细节）。
 */
import { AuthError, verifyDeviceCertificate } from '@fdp/auth';
import type { ClientCertIdentity } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import { parseStrictObject } from '../admin/shared/strict-object.js';
import { MediaError, mediaValidationFailed } from './errors.js';
import { createMediaUploadSession } from './service.js';
import type { MediaDeps } from './service.js';

export interface DeviceMediaRequest {
  readonly identity?: ClientCertIdentity | undefined;
  readonly body?: unknown;
  readonly requestId: string;
}

export interface DeviceMediaResponse {
  readonly status: number;
  readonly body: unknown;
}

export type DeviceMediaHandlerDeps = MediaDeps;

const SENSITIVE_LEAK_PATTERN = /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret)/i;

function toErrorResponse(err: unknown, req: DeviceMediaRequest): DeviceMediaResponse {
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

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw mediaValidationFailed(`${field} is required`);
  return value;
}

export function createDeviceMediaHandler(
  deps: DeviceMediaHandlerDeps,
): (req: DeviceMediaRequest) => Promise<DeviceMediaResponse> {
  const now = deps.now ?? (() => new Date());
  return async (req) => {
    try {
      const body = parseStrictObject(
        req.body,
        ['mediaType', 'fileName', 'sizeKb', 'sizeBytes', 'sha256'],
        mediaValidationFailed,
      );
      if (typeof body.sizeKb !== 'number') throw mediaValidationFailed('sizeKb is required');
      if (typeof body.sizeBytes !== 'number') throw mediaValidationFailed('sizeBytes is required');
      const auth = await verifyDeviceCertificate(deps.client, req.identity, { now: now() });
      const view = await createMediaUploadSession(deps, auth, {
        mediaType: requireString(body, 'mediaType'),
        fileName: requireString(body, 'fileName'),
        sizeKb: body.sizeKb,
        sizeBytes: body.sizeBytes,
        sha256: requireString(body, 'sha256'),
      });
      return {
        status: 201,
        body: { data: view, meta: { requestId: req.requestId, timestamp: now().toISOString() } },
      };
    } catch (err) {
      return toErrorResponse(err, req);
    }
  };
}
