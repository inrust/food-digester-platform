/**
 * BE-ONB-03 Handler：GET /api/v1/device/onboarding/status（框架无关）。
 *
 * 外部状态契约（内部 Provisioning 不暴露）：
 * - 申请 PENDING，或 APPROVED 但证书包尚未就绪 → { status: 'PENDING' }；
 * - 申请 REJECTED → { status: 'REJECTED', reason }；
 * - APPROVED 且证书包就绪 → 一次性领取（SEC-01/DEC-003）：返回
 *   { status: 'APPROVED', deviceId, certificate, mqtt, configuration }，
 *   响应提交后销毁密文并核销 Onboarding Token；提交不确定则下一次轮询撤证重签。
 *
 * 认证：AUTH-02 Onboarding Token；Token 自身绑定隐式定位申请，不要求 Query。
 */
import type { DbClient } from '@fdp/database';
import { withTransaction } from '@fdp/database';
import {
  AuthError,
  createRateLimiter,
  markOnboardingTokenUsed,
  PostgresRateLimitStore,
  SecurePackageError,
  withOnboardingAuth,
} from '@fdp/auth';
import type { ClaimProof, OnboardingAuthContext, RateLimiter, SecurePackageService } from '@fdp/auth';
import { ONBOARDING_TIMEOUT_POLICY } from '@fdp/contracts/lifecycle/onboarding-timeout-policy.js';
import { OnboardingApiError } from './errors.js';
import type { OnboardingHttpRequest, OnboardingHttpResponse } from './handler.js';
import { findOnboardingRequestByTokenId } from './repository.js';
import type { OnboardingRequestRecord } from './repository.js';
import { parseCertificatePackage } from '../provisioning/index.js';
import { createHash } from 'node:crypto';
import { inspectCsr, verifyStatusProof } from './csr-proof.js';
import { isUniqueViolation } from './repository.js';

export interface OnboardingStatusRequest extends OnboardingHttpRequest {
  readonly query?: Readonly<Record<string, string | undefined>>;
}

export interface OnboardingStatusHandlerDeps {
  readonly client: DbClient;
  readonly securePackage: SecurePackageService;
  /** 设备 MQTT 接入点（IoT Data Endpoint，部署期解析注入）。 */
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

interface DeviceRow {
  readonly id: string;
  readonly serialNumber: string;
}

interface CertificateRow {
  readonly id: string;
  readonly deviceId: string;
  readonly status: string;
  readonly claimedAt: Date | null;
  readonly packageExpiresAt: Date | null;
}

function devices(client: DbClient) {
  return (client as unknown as Record<string, unknown>).device as {
    findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
  };
}

function certificates(client: DbClient) {
  return (client as unknown as Record<string, unknown>).deviceCertificate as {
    findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null>;
  };
}

function bearerTokenOf(req: OnboardingStatusRequest): string | undefined {
  const header = req.headers.authorization ?? req.headers.Authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
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
      certificate: { certificatePem: string; privateKey?: string };
      mqtt: { endpoint: string };
      configuration: { heartbeatInterval: 60 };
    };

export function createOnboardingStatusHandler(
  deps: OnboardingStatusHandlerDeps,
): (req: OnboardingStatusRequest) => Promise<OnboardingHttpResponse> {
  const now = deps.now ?? (() => new Date());
  const sharedStore = new PostgresRateLimitStore(deps.client);
  const tokenRateLimiter = deps.rateLimiter ?? createRateLimiter(sharedStore, { limit: 30, windowSeconds: 60 });
  const ipRateLimiter = deps.rateLimiter ? undefined : createRateLimiter(sharedStore, { limit: 60, windowSeconds: 60 });
  const csrLimiter = deps.rateLimiter ?? createRateLimiter(sharedStore, { limit: 30, windowSeconds: 60 }, now);

  const guarded = withOnboardingAuth<OnboardingStatusRequest, OnboardingHttpResponse>(
    {
      client: deps.client,
      tokenOf: bearerTokenOf,
      serialNumberOf: () => undefined,
      allowImplicitSerialNumber: true,
      rateLimits: [
        { limiter: tokenRateLimiter, keyOf: (_req, fingerprint) => `onboarding:token:${fingerprint}` },
        ...(ipRateLimiter
          ? [
              {
                limiter: ipRateLimiter,
                keyOf: (req: OnboardingStatusRequest) => `onboarding:ip:${req.sourceIp ?? 'unknown'}`,
              },
            ]
          : []),
      ],
      now,
    },
    async (req, auth) => {
      const resolved = await resolveStatus(deps, auth);
      return {
        status: 200,
        body: resolved.body,
        ...(resolved.onCommitted ? { onCommitted: resolved.onCommitted } : {}),
      };
    },
  );

  return async (req) => {
    if (!bearerTokenOf(req) && req.query?.requestId) {
      try {
        const requestId = req.query.requestId;
        if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new OnboardingApiError('VALIDATION_FAILED');
        await csrLimiter.assertWithinLimit(`onboarding:status:ip:${req.sourceIp ?? 'unknown'}`);
        await csrLimiter.assertWithinLimit(`onboarding:status:request:${requestId}`);
        const db = deps.client as unknown as {
          onboardingRequest: { findFirst(args: { where: { id: string } }): Promise<OnboardingRequestRecord | null> };
          onboardingProofNonce: {
            create(args: { data: { requestId: string; nonceHash: string; expiresAt: Date } }): Promise<unknown>;
            deleteMany(args: { where: { expiresAt: { lt: Date } } }): Promise<unknown>;
          };
        };
        const request = await db.onboardingRequest.findFirst({ where: { id: requestId } });
        if (!request?.csrPem) throw new OnboardingApiError('UNAUTHENTICATED');
        const proof = {
          requestId,
          timestamp: req.headers['x-onboarding-timestamp'] ?? req.headers['X-Onboarding-Timestamp'] ?? '',
          nonce: req.headers['x-onboarding-nonce'] ?? req.headers['X-Onboarding-Nonce'] ?? '',
          signature: req.headers['x-onboarding-signature'] ?? req.headers['X-Onboarding-Signature'] ?? '',
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
        const resolved = await resolveStatus(deps, request, { requestId, serialNumber: request.serialNumber });
        return {
          status: 200,
          body: resolved.body,
          ...(resolved.onCommitted ? { onCommitted: resolved.onCommitted } : {}),
        };
      } catch (err) {
        return toErrorResponse(err, req);
      }
    }
    try {
      return await guarded(req);
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
  requestOrAuth: OnboardingRequestRecord | OnboardingAuthContext,
  csrAuth?: { requestId: string; serialNumber: string },
): Promise<ResolvedStatus> {
  const auth = csrAuth ?? (requestOrAuth as OnboardingAuthContext);
  const request: OnboardingRequestRecord | null = csrAuth
    ? (requestOrAuth as OnboardingRequestRecord)
    : await findOnboardingRequestByTokenId(deps.client, (requestOrAuth as OnboardingAuthContext).tokenId);
  if (!request) throw new OnboardingApiError('NOT_FOUND', 'The requested resource was not found');

  if (request.status === ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.internalRequestStatus) {
    return {
      body: {
        status: ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalStatus,
        reason: ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalReason,
      },
    };
  }
  if (request.status === 'REJECTED') {
    return { body: { status: 'REJECTED', reason: request.rejectReason ?? 'REJECTED' } };
  }
  if (request.status !== 'APPROVED') {
    return { body: { status: 'PENDING' } };
  }

  const current = deps.now?.() ?? new Date();
  if (request.onboardingDeadlineAt && request.onboardingDeadlineAt.getTime() <= current.getTime()) {
    await deps.deliveryRecovery.convergeOnboardingTimeout(request.id, current);
    return {
      body: {
        status: ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalStatus,
        reason: ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalReason,
      },
    };
  }

  // APPROVED：证书包未就绪（Provisioning 内部步骤进行中）→ 对外仍为 PENDING
  const device = await devices(deps.client).findFirst({ where: { serialNumber: auth.serialNumber } });
  const certificate = device
    ? await certificates(deps.client).findFirst({
        where: { deviceId: device.id, status: 'PENDING_CLAIM', packageCiphertext: { not: null } },
      })
    : null;
  if (!device || !certificate) {
    return { body: { status: 'PENDING' } };
  }

  if (certificate.packageExpiresAt && certificate.packageExpiresAt.getTime() <= current.getTime()) {
    await deps.deliveryRecovery.recoverExpiredPackage(request, certificate.id);
    return { body: { status: 'PENDING' } };
  }

  if (certificate.claimedAt !== null) {
    await deps.deliveryRecovery.recoverUnconfirmedDelivery(request, certificate.id);
    return { body: { status: 'PENDING' } };
  }

  // 第一阶段：预留并解密，密文保留到适配层确认 HTTP 响应已提交。
  const proof: ClaimProof = csrAuth
    ? { kind: 'onboardingCsr', context: csrAuth }
    : { kind: 'onboardingToken', context: auth as OnboardingAuthContext };
  const payload = await deps.securePackage.preparePackageDelivery(certificate.id, proof);
  const pkg = parseCertificatePackage(payload);
  return {
    body: {
      status: 'APPROVED',
      deviceId: device.id,
      certificate: {
        certificatePem: pkg.certificatePem,
        ...(!csrAuth && pkg.privateKey ? { privateKey: pkg.privateKey } : {}),
      },
      mqtt: { endpoint: deps.mqttEndpoint },
      configuration: { heartbeatInterval: 60 },
    },
    onCommitted: async () => {
      await withTransaction(deps.client, async (tx) => {
        const packageConfirmed = await deps.securePackage.confirmPackageDelivery(certificate.id, tx);
        if (!packageConfirmed) throw new Error('证书包交付确认状态已变化');
        if (!csrAuth) {
          const tokenUsed = await markOnboardingTokenUsed(
            tx,
            (auth as OnboardingAuthContext).tokenId,
            deps.now?.() ?? new Date(),
          );
          if (!tokenUsed) throw new Error('Onboarding Token 核销状态已变化');
        }
      });
    },
  };
}
