import { AuthError } from '@fdp/auth';
import type { ActorContext, ClientCertIdentity } from '@fdp/auth';
import type { AdminHttpRequest } from '../admin/onboarding/handler.js';
import { rejectRequestBody } from '../admin/shared/strict-object.js';
import { LiveImageLeaseError, LiveImageLeaseService } from './service.js';
import type { LiveImageLeaseDeps } from './service.js';
import { LiveImageFrameService } from './frame-service.js';
import type { LiveImageFrameDeps } from './frame-service.js';
import { LiveImageLatestService } from './latest-service.js';
import type { LiveImageLatestDeps } from './latest-service.js';

export interface LiveImageLeaseResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}
export interface LiveImageDeviceStateRequest {
  readonly identity?: ClientCertIdentity;
  readonly body?: unknown;
  readonly requestId: string;
}

function createLiveImageResponder(now: () => Date) {
  return async (requestId: string, work: () => Promise<unknown>, status = 200): Promise<LiveImageLeaseResponse> => {
    const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
    try {
      const data = await work();
      return {
        status,
        headers,
        body: status === 204 ? undefined : { data, meta: { requestId, timestamp: now().toISOString() } },
      };
    } catch (error) {
      const known = error instanceof AuthError || error instanceof LiveImageLeaseError;
      const code = known ? error.code : 'TEMPORARILY_UNAVAILABLE';
      const httpStatus = known ? error.httpStatus : 503;
      if (httpStatus === 429) headers['Retry-After'] = '1';
      return { status: httpStatus, headers, body: { error: { code, message: 'The request failed', requestId } } };
    }
  };
}

function actorOf(req: AdminHttpRequest): ActorContext {
  if (!req.actor) throw new LiveImageLeaseError('UNAUTHENTICATED');
  return req.actor;
}

export function createLiveImageLeaseHandlers(deps: LiveImageLeaseDeps) {
  const service = new LiveImageLeaseService(deps);
  const execute = createLiveImageResponder(deps.now ?? (() => new Date()));
  const bodyError = () => new LiveImageLeaseError('VALIDATION_FAILED');
  return {
    renewViewer: (req: AdminHttpRequest) =>
      execute(req.requestId, async () => {
        const actor = actorOf(req);
        rejectRequestBody(req.body, bodyError);
        return service.renewViewer(actor, req.params?.deviceId ?? '', req.params?.viewerId ?? '');
      }),
    releaseViewer: (req: AdminHttpRequest) =>
      execute(
        req.requestId,
        async () => {
          const actor = actorOf(req);
          rejectRequestBody(req.body, bodyError);
          await service.releaseViewer(actor, req.params?.deviceId ?? '', req.params?.viewerId ?? '');
        },
        204,
      ),
    getDeviceState: (req: LiveImageDeviceStateRequest) =>
      execute(req.requestId, async () => {
        if (!req.identity?.clientCertPem) throw new LiveImageLeaseError('UNAUTHENTICATED');
        rejectRequestBody(req.body, bodyError);
        return service.getDeviceState(req.identity);
      }),
  };
}

export interface LiveImageFrameRequest extends LiveImageDeviceStateRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export function createLiveImageFrameHandler(deps: LiveImageFrameDeps) {
  const service = new LiveImageFrameService(deps);
  const execute = createLiveImageResponder(deps.now ?? (() => new Date()));
  return (req: LiveImageFrameRequest): Promise<LiveImageLeaseResponse> =>
    execute(req.requestId, async () => {
      if (!req.identity?.clientCertPem) throw new LiveImageLeaseError('UNAUTHENTICATED');
      const contentType = Object.entries(req.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
      if (contentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        throw new LiveImageLeaseError('UNSUPPORTED_MEDIA_TYPE');
      }
      return service.uploadFrame(req.identity, req.body);
    });
}

export function createLiveImageLatestHandler(deps: LiveImageLatestDeps) {
  const service = new LiveImageLatestService(deps);
  const execute = createLiveImageResponder(deps.now ?? (() => new Date()));
  return (req: AdminHttpRequest): Promise<LiveImageLeaseResponse> =>
    execute(req.requestId, async () => {
      const actor = actorOf(req);
      rejectRequestBody(req.body, () => new LiveImageLeaseError('VALIDATION_FAILED'));
      return service.getLatest(actor, req.params?.deviceId ?? '', req.query?.viewerId ?? '', req.query?.knownFrameId);
    });
}
