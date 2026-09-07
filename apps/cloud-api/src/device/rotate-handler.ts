/**
 * BE-CERT-02 Rotate API Handler：POST /api/v1/device/certificate/rotate（框架无关）。
 *
 * 接线：AUTH-03 withDeviceAuth（mTLS 白名单，旧证书须 ACTIVE 且属于设备）→ rotateCertificate。
 * 响应：源协议顶层 { certificateId, certificatePem, privateKey, effectiveDate, expiryDate }；
 * 私钥仅本响应一次性携带。错误：400 VALIDATION_FAILED / 401 UNAUTHENTICATED /
 * 403 FORBIDDEN / 409 CONFLICT（重试失败关闭），未知异常 500 通用消息。
 */
import { AuthError, withDeviceAuth } from '@fdp/auth';
import type { ClientCertIdentity } from '@fdp/auth';
import { CertificateRotationError, rotateCertificate } from './certificate-rotate.js';
import type { RotationResult, RotationServiceDeps } from './certificate-rotate.js';

export interface CertificateRotateRequest {
  readonly identity?: ClientCertIdentity | undefined;
  readonly body?: unknown;
  readonly requestId: string;
}

export interface CertificateRotateResponse {
  readonly status: number;
  readonly body: unknown;
  readonly onCommitted?: (() => Promise<void>) | undefined;
}

export type CertificateRotateHandlerDeps = RotationServiceDeps;

function currentCertificateIdOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'currentCertificateId')) {
    throw new CertificateRotationError('VALIDATION_FAILED', 'Request body contains unknown fields');
  }
  return typeof record.currentCertificateId === 'string' ? record.currentCertificateId : undefined;
}

function toErrorResponse(err: unknown, req: CertificateRotateRequest): CertificateRotateResponse {
  if (err instanceof AuthError || err instanceof CertificateRotationError) {
    return {
      status: err.httpStatus,
      body: { error: { code: err.code, message: err.message, requestId: req.requestId } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: req.requestId } },
  };
}

export function createCertificateRotateHandler(
  deps: CertificateRotateHandlerDeps,
): (req: CertificateRotateRequest) => Promise<CertificateRotateResponse> {
  const guarded = withDeviceAuth<CertificateRotateRequest, CertificateRotateResponse>(
    {
      client: deps.client,
      identityOf: (req) => req.identity,
      deviceIdOf: () => undefined, // 无路径 deviceId；身份即设备
      ...(deps.now ? { now: deps.now } : {}),
    },
    async (req, auth) => {
      const currentCertificateId = currentCertificateIdOf(req.body);
      const result: RotationResult = await rotateCertificate(deps, auth, currentCertificateId);
      return {
        status: 200,
        body: {
          certificateId: result.certificateId,
          certificatePem: result.certificatePem,
          privateKey: result.privateKey,
          effectiveDate: result.effectiveDate,
          expiryDate: result.expiryDate,
        },
        onCommitted: result.confirmDelivery,
      };
    },
  );

  return async (req) => {
    try {
      return await guarded(req);
    } catch (err) {
      return toErrorResponse(err, req);
    }
  };
}
