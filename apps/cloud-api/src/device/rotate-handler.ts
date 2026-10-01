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

function rotationInputOf(body: unknown): { currentCertificateId: string | undefined; csrPem: string | undefined } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { currentCertificateId: undefined, csrPem: undefined };
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['currentCertificateId', 'csrPem'].includes(key))) {
    throw new CertificateRotationError('VALIDATION_FAILED', 'Request body contains unknown fields');
  }
  return {
    currentCertificateId: typeof record.currentCertificateId === 'string' ? record.currentCertificateId : undefined,
    csrPem: typeof record.csrPem === 'string' ? record.csrPem : undefined,
  };
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
      const { currentCertificateId, csrPem } = rotationInputOf(req.body);
      const result: RotationResult = await rotateCertificate(deps, auth, currentCertificateId, csrPem);
      return {
        status: 200,
        body: {
          certificateId: result.certificateId,
          certificatePem: result.certificatePem,
          certificateChain: result.certificateChain,
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
