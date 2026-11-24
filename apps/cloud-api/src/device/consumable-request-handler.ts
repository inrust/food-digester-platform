import { AuthError, forbidden, verifyDeviceCertificate } from '@fdp/auth';
import type { ClientCertIdentity } from '@fdp/auth';
import { mapDbErrorToHttp, runWithContext } from '@fdp/database';
import { ConsumableError } from '@fdp/domain';
import { parseStrictObject } from '../admin/shared/strict-object.js';
import { AdminConsumableError, consumableValidationFailed } from '../consumable/errors.js';
import { parseConsumableRequestTime, parseOptionalConsumableNote } from '../consumable/request-policy.js';
import { createDeviceConsumableRequest } from '../consumable/request-service.js';
import type { ConsumableRequestDeps } from '../consumable/request-service.js';
import { isVerifiedClientVersion } from './verified-client-targets.js';

export const DEVICE_CONSUMABLE_REQUEST_PATH = '/api/v1/device/consumable-requests';

interface DeviceConsumableRequest {
  readonly identity?: ClientCertIdentity;
  readonly body?: unknown;
  readonly requestId: string;
}

export function createDeviceConsumableSubmissionHandler(
  deps: ConsumableRequestDeps & { readonly verifiedTargets: ReadonlyMap<string, string> },
) {
  const now = deps.now ?? (() => new Date());
  return async (req: DeviceConsumableRequest) => {
    const at = now();
    const meta = { requestId: req.requestId, timestamp: at.toISOString() };
    try {
      const auth = await verifyDeviceCertificate(deps.client, req.identity, { now: at });
      const body = parseStrictObject(
        req.body,
        ['schemaVersion', 'clientVersion', 'requestKey', 'consumableType', 'occurredAt', 'note'],
        consumableValidationFailed,
      );
      if (body.schemaVersion !== 1) throw consumableValidationFailed('Unsupported consumable request schemaVersion');
      if (!isVerifiedClientVersion(body.clientVersion)) throw consumableValidationFailed('clientVersion is invalid');
      if (deps.verifiedTargets.get(auth.deviceId) !== body.clientVersion) {
        throw forbidden('This device and client version are not enabled for consumable requests');
      }
      if (typeof body.requestKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(body.requestKey)) {
        throw consumableValidationFailed('requestKey is invalid');
      }
      const occurredAt = parseConsumableRequestTime(body.occurredAt);
      if (occurredAt === null) throw consumableValidationFailed('occurredAt must be a valid UTC timestamp');
      if (typeof body.consumableType !== 'string') throw consumableValidationFailed('consumableType is required');
      if (typeof body.note === 'string' && body.note.length > 500) {
        throw consumableValidationFailed('note must not exceed 500 characters');
      }
      const input = {
        schemaVersion: 1 as const,
        requestKey: body.requestKey,
        consumableType: body.consumableType,
        occurredAt,
        note: parseOptionalConsumableNote(body.note, 'note'),
      };
      const result = await runWithContext(
        {
          requestId: req.requestId,
          actorId: auth.deviceId,
          actorRole: 'DEVICE',
          ...(auth.customerId !== null ? { customerId: auth.customerId } : {}),
        },
        () => createDeviceConsumableRequest({ client: deps.client, now: () => at }, auth, input),
      );
      return {
        status: result.outcome === 'CREATED' ? 201 : 200,
        body: {
          data: { requestKey: input.requestKey, requestId: result.view.requestId, outcome: result.outcome },
          meta,
        },
      };
    } catch (err) {
      if (err instanceof AuthError || err instanceof AdminConsumableError) {
        return {
          status: err.httpStatus,
          body: { error: { code: err.code, message: err.message, requestId: req.requestId } },
        };
      }
      if (err instanceof ConsumableError) {
        return {
          status: 400,
          body: { error: { code: 'VALIDATION_FAILED', message: 'Unknown consumable type', requestId: req.requestId } },
        };
      }
      const mapped = mapDbErrorToHttp(err);
      return {
        status: mapped.status,
        body: { error: { code: mapped.code, message: 'The request failed', requestId: req.requestId } },
      };
    }
  };
}
