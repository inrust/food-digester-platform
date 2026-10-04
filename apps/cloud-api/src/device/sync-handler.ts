/**
 * BE-SYNC-01 Unified Device Sync API Handler：POST /api/v1/device/sync（框架无关）。
 *
 * 接线：AUTH-03 verifyDeviceCertificate（mTLS 白名单；DEC-014 仅放行 72 小时窗口内的
 * PENDING_CONFIRMATION Retired；Suspended 放行）→ parseSyncRequest → 可选许可证确认 → buildDeviceSyncSnapshot。
 * 响应：源协议顶层完整事实快照（含 etag），不使用 data/meta Envelope；
 * 错误：400 VALIDATION_FAILED / 401 UNAUTHENTICATED / 403 FORBIDDEN / 409 CONFLICT / 500 通用消息。
 * 写入最小 Device User 快照交付/确认状态及证书 REST 验证时间；双通道轮换确认可撤销旧证并审计；响应不含证书材料与云端凭据（Device Users 验证材料为
 * DEC-004 设备本地专用加盐验证值，是本域的授权下发内容）。
 */
import { AuthError, verifyDeviceCertificate, recordCertificateVerification } from '@fdp/auth';
import type { ClientCertIdentity } from '@fdp/auth';
import { mapDbErrorToHttp } from '@fdp/database';
import { DeviceSyncError, buildDeviceSyncSnapshot, parseSyncRequest } from './sync.js';
import type { DeviceSyncDeps } from './sync.js';
import { confirmLicenseSnapshot, recordLicenseSnapshotServed } from './license-sync.js';

export interface DeviceSyncRequest {
  readonly identity?: ClientCertIdentity | undefined;
  readonly body?: unknown;
  readonly requestId: string;
}

export interface DeviceSyncResponse {
  readonly status: number;
  readonly body: unknown;
  readonly onCommitted?: () => Promise<void>;
}

export type DeviceSyncHandlerDeps = DeviceSyncDeps;

const SENSITIVE_LEAK_PATTERN =
  /(stack|sql|select |insert |update |delete from|aws|arn:aws|access ?key|secret|pem|private)/i;

function toErrorResponse(err: unknown, req: DeviceSyncRequest): DeviceSyncResponse {
  if (err instanceof AuthError || err instanceof DeviceSyncError) {
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

export function createDeviceSyncHandler(
  deps: DeviceSyncHandlerDeps,
): (req: DeviceSyncRequest) => Promise<DeviceSyncResponse> {
  const now = deps.now ?? (() => new Date());
  return async (req) => {
    try {
      const auth = await verifyDeviceCertificate(deps.client, req.identity, { now: now(), retiredAccess: 'SYNC' });
      const input = parseSyncRequest(req.body);
      if (input.licenseConfirmation) await confirmLicenseSnapshot(deps, auth, input.licenseConfirmation, req.requestId);
      const snapshot = await buildDeviceSyncSnapshot(deps, auth, input);
      return {
        status: 200,
        body: snapshot,
        onCommitted: async () => {
          await recordLicenseSnapshotServed(deps, auth, snapshot, req.requestId);
          await recordCertificateVerification(
            deps.client,
            { deviceId: auth.deviceId, certificateFingerprint: auth.certificateFingerprint, channel: 'rest' },
            now(),
          );
        },
      };
    } catch (err) {
      return toErrorResponse(err, req);
    }
  };
}
