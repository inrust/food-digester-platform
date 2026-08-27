/**
 * BE-ONB-03 Handler：GET /api/v1/device/onboarding/status（框架无关）。
 *
 * 外部状态契约（内部 Provisioning 不暴露）：
 * - 申请 PENDING，或 APPROVED 但证书包尚未就绪 → { status: 'PENDING' }；
 * - 申请 REJECTED → { status: 'REJECTED', rejectReason }；
 * - APPROVED 且证书包就绪 → 一次性领取（SEC-01/DEC-003）：返回
 *   { status: 'APPROVED', deviceId, certificatePem, privateKey, mqttEndpoint, heartbeatInterval: 60 }，
 *   领取成功即销毁密文并核销 Onboarding Token（AUTH-02 markOnboardingTokenUsed）。
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
}

interface DeviceRow {
  readonly id: string;
  readonly serialNumber: string;
}

interface CertificateRow {
  readonly id: string;
  readonly deviceId: string;
  readonly status: string;
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
      const body = await resolveStatus(deps, auth);
      return {
        status: 200,
        body: { data: body, meta: { requestId: req.requestId, timestamp: now().toISOString() } },
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

async function resolveStatus(deps: OnboardingStatusHandlerDeps, auth: OnboardingAuthContext): Promise<StatusBody> {
  const request: OnboardingRequestRecord | null = await findOnboardingRequestByTokenId(deps.client, auth.tokenId);
  if (!request) throw new OnboardingApiError('NOT_FOUND', 'The requested resource was not found');

  if (request.status === 'REJECTED') {
    return { status: 'REJECTED', requestId: request.id, rejectReason: request.rejectReason };
  }
  if (request.status !== 'APPROVED') {
    return { status: 'PENDING', requestId: request.id };
  }

  // APPROVED：证书包未就绪（Provisioning 内部步骤进行中）→ 对外仍为 PENDING
  const device = await devices(deps.client).findFirst({ where: { serialNumber: auth.serialNumber } });
  const certificate = device
    ? await certificates(deps.client).findFirst({
        where: { deviceId: device.id, status: 'PENDING_CLAIM', packageCiphertext: { not: null } },
      })
    : null;
  if (!device || !certificate) {
    return { status: 'PENDING', requestId: request.id };
  }

  // 一次性领取（DEC-003）；成功后核销 Token（一次一机的"一次"）
  const payload = await deps.securePackage.claimPackage(certificate.id, { kind: 'onboardingToken', context: auth });
  const pkg = parseCertificatePackage(payload);
  await markOnboardingTokenUsed(deps.client, auth.tokenId, deps.now?.() ?? new Date());
  return {
    status: 'APPROVED',
    requestId: request.id,
    deviceId: device.id,
    certificatePem: pkg.certificatePem,
    privateKey: pkg.privateKey,
    mqttEndpoint: deps.mqttEndpoint,
    heartbeatInterval: 60,
  };
}
