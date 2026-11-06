import { AuthError } from '@fdp/auth';
import type { ActorContext, ClientCertIdentity } from '@fdp/auth';
import type { AdminHttpRequest } from '../admin/onboarding/handler.js';
import { rejectRequestBody } from '../admin/shared/strict-object.js';
import { LiveImageLeaseError, LiveImageLeaseService } from './service.js';
import type { LiveImageLeaseDeps } from './service.js';

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

export function createLiveImageLeaseHandlers(deps: LiveImageLeaseDeps) {
  const service = new LiveImageLeaseService(deps);
  const now = deps.now ?? (() => new Date());
  const execute = async (
    requestId: string,
    work: () => Promise<unknown>,
    status = 200,
  ): Promise<LiveImageLeaseResponse> => {
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
  const actorOf = (req: AdminHttpRequest): ActorContext => {
    if (!req.actor) throw new LiveImageLeaseError('UNAUTHENTICATED');
    return req.actor;
  };
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
