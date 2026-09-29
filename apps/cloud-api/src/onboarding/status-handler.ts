/** GET /api/v1/device/onboarding/status：只接受 CSR 私钥签名。 */
import { createHash } from 'node:crypto';
import type { DbClient } from '@fdp/database';
import { withTransaction } from '@fdp/database';
import { AuthError, createRateLimiter, PostgresRateLimitStore, SecurePackageError } from '@fdp/auth';
import type { RateLimiter, SecurePackageService } from '@fdp/auth';
import { ONBOARDING_TIMEOUT_POLICY } from '@fdp/contracts/lifecycle/onboarding-timeout-policy.js';
import { parseCertificatePackage } from '../provisioning/index.js';
import { inspectCsr, verifyStatusProof } from './csr-proof.js';
import { OnboardingApiError } from './errors.js';
import { onboardingHeader } from './handler.js';
import type { OnboardingHttpRequest, OnboardingHttpResponse } from './handler.js';
import { isUniqueViolation } from './repository.js';
import type { OnboardingRequestRecord } from './repository.js';

export interface OnboardingStatusRequest extends OnboardingHttpRequest {
  readonly query?: Readonly<Record<string, string | undefined>>;
}

export interface OnboardingStatusHandlerDeps {
  readonly client: DbClient;
  readonly securePackage: SecurePackageService;
  readonly mqttEndpoint: string;
  readonly rateLimiter?: RateLimiter;
  readonly now?: () => Date;
  readonly deliveryRecovery: {
    recoverUnconfirmedDelivery(
      request: Pick<OnboardingRequestRecord, 'id' | 'serialNumber'>,
      certificateId: string,
    ): Promise<unknown>;
    recoverExpiredPackage(
      request: Pick<OnboardingRequestRecord, 'id' | 'serialNumber'>,
      certificateId: string,
    ): Promise<unknown>;
    convergeOnboardingTimeout(requestId: string, at: Date): Promise<unknown>;
  };
}

interface CertificateRow {
  readonly id: string;
  readonly deviceId: string;
  readonly claimedAt: Date | null;
  readonly packageExpiresAt: Date | null;
}

function toErrorResponse(err: unknown, req: OnboardingStatusRequest): OnboardingHttpResponse {
  if (err instanceof AuthError || err instanceof OnboardingApiError) {
    return {
      status: err.httpStatus,
      body: { error: { code: err.code, message: err.message, requestId: req.requestId } },
    };
  }
  if (err instanceof SecurePackageError) {
    const code = err.code === 'CORRUPT_PACKAGE' ? 'INTERNAL_ERROR' : err.code;
    const message = err.code === 'CORRUPT_PACKAGE' ? 'Internal server error' : err.message;
    return { status: err.httpStatus, body: { error: { code, message, requestId: req.requestId } } };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: req.requestId } },
  };
}

type StatusBody =
  | { status: 'PENDING' }
  | { status: 'REJECTED'; reason: string }
  | {
      status: 'APPROVED';
      deviceId: string;
      certificate: { certificatePem: string };
      mqtt: { endpoint: string };
      configuration: { heartbeatInterval: 60 };
    };

export function createOnboardingStatusHandler(
  deps: OnboardingStatusHandlerDeps,
): (req: OnboardingStatusRequest) => Promise<OnboardingHttpResponse> {
  const now = deps.now ?? (() => new Date());
  const limiter =
    deps.rateLimiter ??
    createRateLimiter(new PostgresRateLimitStore(deps.client), { limit: 30, windowSeconds: 60 }, now);
  return async (req) => {
    try {
      if (onboardingHeader(req.headers, 'authorization') !== undefined) {
        throw new OnboardingApiError('UNAUTHENTICATED');
      }
      const requestId = req.query?.requestId;
      if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) throw new OnboardingApiError('VALIDATION_FAILED');
      await limiter.assertWithinLimit(`onboarding:status:ip:${req.sourceIp ?? 'unknown'}`);
      await limiter.assertWithinLimit(`onboarding:status:request:${requestId}`);
      const db = deps.client as unknown as {
        onboardingRequest: { findFirst(args: { where: { id: string } }): Promise<OnboardingRequestRecord | null> };
        onboardingProofNonce: {
          create(args: { data: { requestId: string; nonceHash: string; expiresAt: Date } }): Promise<unknown>;
          deleteMany(args: { where: { expiresAt: { lt: Date } } }): Promise<unknown>;
        };
      };
      const request = await db.onboardingRequest.findFirst({ where: { id: requestId } });
      if (!request) throw new OnboardingApiError('UNAUTHENTICATED');
      const proof = {
        requestId,
        timestamp: onboardingHeader(req.headers, 'x-onboarding-timestamp') ?? '',
        nonce: onboardingHeader(req.headers, 'x-onboarding-nonce') ?? '',
        signature: onboardingHeader(req.headers, 'x-onboarding-signature') ?? '',
      };
      const inspected = inspectCsr(request.csrPem);
      if (inspected.fingerprint !== request.publicKeyFingerprint) throw new OnboardingApiError('UNAUTHENTICATED');
      verifyStatusProof(inspected.publicKeyPem, proof, now());
      try {
        await db.onboardingProofNonce.create({
          data: {
            requestId,
            nonceHash: createHash('sha256').update(proof.nonce).digest('hex'),
            expiresAt: new Date(now().getTime() + 300_000),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new OnboardingApiError('UNAUTHENTICATED');
        throw error;
      }
      await db.onboardingProofNonce.deleteMany({ where: { expiresAt: { lt: now() } } });
      const resolved = await resolveStatus(deps, request, now());
      return {
        status: 200,
        body: resolved.body,
        ...(resolved.onCommitted ? { onCommitted: resolved.onCommitted } : {}),
      };
    } catch (err) {
      return toErrorResponse(err, req);
    }
  };
}

interface ResolvedStatus {
  readonly body: StatusBody;
  readonly onCommitted?: () => Promise<void>;
}

async function resolveStatus(
  deps: OnboardingStatusHandlerDeps,
  request: OnboardingRequestRecord,
  current: Date,
): Promise<ResolvedStatus> {
  if (request.status === ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.internalRequestStatus) {
    return {
      body: {
        status: ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalStatus,
        reason: ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalReason,
      },
    };
  }
  if (request.status === 'REJECTED')
    return { body: { status: 'REJECTED', reason: request.rejectReason ?? 'REJECTED' } };
  if (request.status !== 'APPROVED') return { body: { status: 'PENDING' } };
  if (request.onboardingDeadlineAt && request.onboardingDeadlineAt.getTime() <= current.getTime()) {
    await deps.deliveryRecovery.convergeOnboardingTimeout(request.id, current);
    return {
      body: {
        status: ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalStatus,
        reason: ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalReason,
      },
    };
  }
  const db = deps.client as unknown as {
    device: { findFirst(args: { where: { serialNumber: string } }): Promise<{ id: string } | null> };
    deviceCertificate: { findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null> };
  };
  const device = await db.device.findFirst({ where: { serialNumber: request.serialNumber } });
  const certificate = device
    ? await db.deviceCertificate.findFirst({
        where: { deviceId: device.id, status: 'PENDING_CLAIM', packageCiphertext: { not: null } },
      })
    : null;
  if (!device || !certificate) return { body: { status: 'PENDING' } };
  if (certificate.packageExpiresAt && certificate.packageExpiresAt.getTime() <= current.getTime()) {
    await deps.deliveryRecovery.recoverExpiredPackage(request, certificate.id);
    return { body: { status: 'PENDING' } };
  }
  if (certificate.claimedAt !== null) {
    await deps.deliveryRecovery.recoverUnconfirmedDelivery(request, certificate.id);
    return { body: { status: 'PENDING' } };
  }
  const payload = await deps.securePackage.preparePackageDelivery(certificate.id, {
    kind: 'onboardingCsr',
    context: { requestId: request.id, serialNumber: request.serialNumber },
  });
  const pkg = parseCertificatePackage(payload);
  return {
    body: {
      status: 'APPROVED',
      deviceId: device.id,
      certificate: { certificatePem: pkg.certificatePem },
      mqtt: { endpoint: deps.mqttEndpoint },
      configuration: { heartbeatInterval: 60 },
    },
    onCommitted: async () => {
      await withTransaction(deps.client, async (tx) => {
        if (!(await deps.securePackage.confirmPackageDelivery(certificate.id, tx))) {
          throw new Error('证书包交付确认状态已变化');
        }
      });
    },
  };
}
