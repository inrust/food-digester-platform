/** POST /api/v1/device/onboarding/request：无预置凭据的 CSR 申请。 */
import type { DbClient } from '@fdp/database';
import { AuthError, createRateLimiter, PostgresRateLimitStore, claimDevicePublicKey } from '@fdp/auth';
import type { RateLimiter } from '@fdp/auth';
import { inspectCsr } from './csr-proof.js';
import { parseOnboardingRequestBody } from './dto.js';
import { deviceStateNotAllowed, OnboardingApiError, serialNumberNotFound, validationFailed } from './errors.js';
import { findPendingOnboardingRequest, isUniqueViolation } from './repository.js';

export interface OnboardingHttpRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly requestId: string;
  readonly sourceIp?: string | undefined;
}

export interface OnboardingHttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly onCommitted?: (() => Promise<void>) | undefined;
}

export interface OnboardingRequestHandlerDeps {
  readonly client: DbClient;
  readonly rateLimiter?: RateLimiter;
  readonly now?: () => Date;
}

export function onboardingHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

export function createOnboardingRequestHandler(
  deps: OnboardingRequestHandlerDeps,
): (req: OnboardingHttpRequest) => Promise<OnboardingHttpResponse> {
  const now = deps.now ?? (() => new Date());
  const limiter =
    deps.rateLimiter ??
    createRateLimiter(new PostgresRateLimitStore(deps.client), { limit: 30, windowSeconds: 60 }, now);
  return async (req) => {
    try {
      if (onboardingHeader(req.headers, 'authorization') !== undefined) {
        throw new OnboardingApiError('VALIDATION_FAILED', 'Authorization is not supported for onboarding');
      }
      if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw validationFailed('The request body must be a JSON object');
      }
      const raw = req.body as Record<string, unknown>;
      if (typeof raw.csrPem !== 'string') throw validationFailed('csrPem is required');
      const { csrPem, ...fields } = raw;
      const input = parseOnboardingRequestBody(fields, now());
      const { fingerprint } = inspectCsr(csrPem);
      await limiter.assertWithinLimit(`onboarding:csr:ip:${req.sourceIp ?? 'unknown'}`);
      await limiter.assertWithinLimit(`onboarding:csr:serial:${input.serialNumber}`);

      const existing = await findPendingOnboardingRequest(deps.client, input.serialNumber);
      if (existing) {
        if (existing.publicKeyFingerprint !== fingerprint) throw new OnboardingApiError('CONFLICT');
        return { status: 200, body: { requestId: existing.id, status: 'PENDING' } };
      }
      const db = deps.client as unknown as {
        device: {
          findFirst(args: { where: { serialNumber: string } }): Promise<{ id: string; lifecycleStatus: string } | null>;
        };
        onboardingRequest: { create(args: { data: Record<string, unknown> }): Promise<{ id: string }> };
      };
      const inventory = await db.device.findFirst({ where: { serialNumber: input.serialNumber } });
      if (!inventory) throw serialNumberNotFound();
      if (inventory.lifecycleStatus !== 'PendingOnboarding') throw deviceStateNotAllowed();
      if (!(await claimDevicePublicKey(deps.client, inventory.id, fingerprint)))
        throw new OnboardingApiError('CONFLICT', 'CSR key is bound to another device');
      const data = {
        serialNumber: input.serialNumber,
        submittedBy: `DEVICE:${input.serialNumber}`,
        model: input.model,
        hardwareVersion: input.hardwareVersion,
        manufacturer: input.manufacturer,
        manufactureDate: input.manufactureDate,
        csrPem,
        publicKeyFingerprint: fingerprint,
        status: 'PENDING',
      };
      try {
        const created = await db.onboardingRequest.create({ data });
        return { status: 201, body: { requestId: created.id, status: 'PENDING' } };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const winner = await findPendingOnboardingRequest(deps.client, input.serialNumber);
        if (winner?.publicKeyFingerprint === fingerprint) {
          return { status: 200, body: { requestId: winner.id, status: 'PENDING' } };
        }
        throw new OnboardingApiError('CONFLICT');
      }
    } catch (err) {
      if (err instanceof OnboardingApiError || err instanceof AuthError) {
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
  };
}
