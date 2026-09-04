/**
 * BE-ONB-03 Handler：GET /api/v1/device/onboarding/status（框架无关）。
 *
 * 外部状态契约（内部 Provisioning 不暴露）：
 * - 申请 PENDING，或 APPROVED 但证书包尚未就绪 → { status: 'PENDING' }；
 * - 申请 REJECTED → { status: 'REJECTED', rejectReason }；
 * - APPROVED 且证书包就绪 → 一次性领取（SEC-01/DEC-003）：返回
 *   { status: 'APPROVED', deviceId, certificatePem, privateKey, mqttEndpoint, heartbeatInterval: 60 }，
 *   响应提交后销毁密文并核销 Onboarding Token；提交不确定则下一次轮询撤证重签。
 *
 * 认证：AUTH-02 Onboarding Token（Bearer + query.serialNumber 绑定校验）。
 */
import type { DbClient } from '@fdp/database';
import {
  AuthError,
  createRateLimiter,
  InMemoryRateLimitStore,
  markOnboardingTokenUsed,
  SecurePackageError,
  withOnboardingAuth,
} from '@fdp/auth';
import type { OnboardingAuthContext, RateLimiter, SecurePackageService } from '@fdp/auth';
import { ONBOARDING_TIMEOUT_POLICY } from '@fdp/contracts/lifecycle/onboarding-timeout-policy.js';
import { OnboardingApiError } from './errors.js';
import type { OnboardingHttpRequest, OnboardingHttpResponse } from './handler.js';
import { findOnboardingRequestByTokenId } from './repository.js';
import type { OnboardingRequestRecord } from './repository.js';
import { parseCertificatePackage } from '../provisioning/index.js';

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
  | { status: 'PENDING'; requestId: string }
  | { status: 'REJECTED'; requestId: string; rejectReason: string | null }
  | {
      status: 'APPROVED';
      requestId: string;
      deviceId: string;
      certificatePem: string;
      privateKey: string;
      mqttEndpoint: string;
      heartbeatInterval: 60;
    };

export function createOnboardingStatusHandler(
  deps: OnboardingStatusHandlerDeps,
): (req: OnboardingStatusRequest) => Promise<OnboardingHttpResponse> {
  const now = deps.now ?? (() => new Date());
  const rateLimiter =
    deps.rateLimiter ?? createRateLimiter(new InMemoryRateLimitStore(), { limit: 30, windowSeconds: 60 });

  const guarded = withOnboardingAuth<OnboardingStatusRequest, OnboardingHttpResponse>(
    {
      client: deps.client,
      tokenOf: bearerTokenOf,
      serialNumberOf: (req) => req.query?.serialNumber,
      rateLimiter,
      now,
    },
    async (req, auth) => {
      const resolved = await resolveStatus(deps, auth);
      return {
        status: 200,
        body: { data: resolved.body, meta: { requestId: req.requestId, timestamp: now().toISOString() } },
        ...(resolved.onCommitted ? { onCommitted: resolved.onCommitted } : {}),
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

interface ResolvedStatus {
  readonly body: StatusBody;
  readonly onCommitted?: () => Promise<void>;
}

async function resolveStatus(deps: OnboardingStatusHandlerDeps, auth: OnboardingAuthContext): Promise<ResolvedStatus> {
  const request: OnboardingRequestRecord | null = await findOnboardingRequestByTokenId(deps.client, auth.tokenId);
  if (!request) throw new OnboardingApiError('NOT_FOUND', 'The requested resource was not found');

  if (request.status === ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.internalRequestStatus) {
    return {
      body: {
        status: ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalStatus,
        requestId: request.id,
        rejectReason: ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalReason,
      },
    };
  }
  if (request.status === 'REJECTED') {
    return { body: { status: 'REJECTED', requestId: request.id, rejectReason: request.rejectReason } };
  }
  if (request.status !== 'APPROVED') {
    return { body: { status: 'PENDING', requestId: request.id } };
  }

  const current = deps.now?.() ?? new Date();
  if (request.onboardingDeadlineAt && request.onboardingDeadlineAt.getTime() <= current.getTime()) {
    return {
      body: {
        status: ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalStatus,
        requestId: request.id,
        rejectReason: ONBOARDING_TIMEOUT_POLICY.timeoutDisposition.externalReason,
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
    return { body: { status: 'PENDING', requestId: request.id } };
  }

  if (certificate.packageExpiresAt && certificate.packageExpiresAt.getTime() <= current.getTime()) {
    await deps.securePackage.destroyPackage(certificate.id);
    await deps.deliveryRecovery.recoverExpiredPackage(request, certificate.id);
    return { body: { status: 'PENDING', requestId: request.id } };
  }

  if (certificate.claimedAt !== null) {
    await deps.deliveryRecovery.recoverUnconfirmedDelivery(request, certificate.id);
    return { body: { status: 'PENDING', requestId: request.id } };
  }

  // 第一阶段：预留并解密，密文保留到适配层确认 HTTP 响应已提交。
  const payload = await deps.securePackage.preparePackageDelivery(certificate.id, {
    kind: 'onboardingToken',
    context: auth,
  });
  const pkg = parseCertificatePackage(payload);
  return {
    body: {
      status: 'APPROVED',
      requestId: request.id,
      deviceId: device.id,
      certificatePem: pkg.certificatePem,
      privateKey: pkg.privateKey,
      mqttEndpoint: deps.mqttEndpoint,
      heartbeatInterval: 60,
    },
    onCommitted: async () => {
      await deps.securePackage.confirmPackageDelivery(certificate.id);
      await markOnboardingTokenUsed(deps.client, auth.tokenId, deps.now?.() ?? new Date());
    },
  };
}
