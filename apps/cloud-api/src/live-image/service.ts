import { randomUUID } from 'node:crypto';
import { requirePermission } from '@fdp/auth';
import type { ActorContext, ClientCertIdentity } from '@fdp/auth';
import { CAMERA_INTERACTION_POLICY } from '@fdp/contracts/domain/camera-interaction-policy.js';
import type { LiveLease, LiveState } from '@fdp/contracts/rest/image-types.js';
import type {
  LiveImageAccess,
  LiveImageAuthorizationGuard,
  LiveImageAuthorizationScope,
  LiveImageControl,
  LiveImageControlStore,
} from './storage.js';

const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  TEMPORARILY_UNAVAILABLE: 503,
} as const;

export class LiveImageLeaseError extends Error {
  override readonly name = 'LiveImageLeaseError';
  constructor(readonly code: keyof typeof ERROR_STATUS) {
    super('The request failed');
  }
  get httpStatus(): number {
    return ERROR_STATUS[this.code];
  }
}

export interface LiveImageLeaseDeps {
  readonly store: LiveImageControlStore;
  readonly authorization: LiveImageAuthorizationGuard;
  readonly now?: () => Date;
  readonly newStreamId?: () => string;
}

const policy = CAMERA_INTERACTION_POLICY.liveImage;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CAS_ATTEMPTS = 5;
const deny = () => new LiveImageLeaseError('FORBIDDEN');

function isEligible(scope: LiveImageAuthorizationScope): boolean {
  return (
    scope.featureEnabled &&
    !!scope.customerId &&
    ['Active', 'Maintenance'].includes(scope.lifecycleStatus) &&
    ['Active', 'Maintenance'].includes(scope.operationalStatus ?? '')
  );
}

function assertViewer(scope: LiveImageAuthorizationScope, access: LiveImageAccess): void {
  if (access.kind !== 'viewer') return;
  const actor = scope.actor;
  if (!actor || actor.actorId !== access.actor.actorId || scope.deviceId !== access.deviceId) throw deny();
  if (actor.actorType === 'customer' && actor.customerId !== scope.customerId) {
    throw new LiveImageLeaseError('NOT_FOUND');
  }
  requirePermission(actor, 'media:read');
}

function initialControl(deviceId: string): LiveImageControl {
  return {
    deviceId,
    customerId: null,
    revision: 0,
    authEpoch: 0,
    enabled: false,
    streamId: null,
    viewers: [],
    latestCapturedAtMs: null,
    lastNewFrameAtMs: null,
  };
}

/** Business module; production guard and shared-store adapters are mandatory dependencies. */
export class LiveImageLeaseService {
  private readonly now: () => Date;
  private readonly newStreamId: () => string;

  constructor(private readonly deps: LiveImageLeaseDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newStreamId = deps.newStreamId ?? randomUUID;
  }

  private async update<T>(
    access: LiveImageAccess,
    change: (
      current: LiveImageControl,
      scope: LiveImageAuthorizationScope,
      now: number,
    ) => { next: LiveImageControl; value: T },
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const result = await this.deps.authorization.withRead(access, async (scope) => {
        assertViewer(scope, access);
        if (!isEligible(scope)) throw deny();
        const stored = await this.deps.store.readControl(scope.deviceId);
        if (stored && (!stored.enabled || stored.customerId !== scope.customerId)) throw deny();
        const current = stored ?? {
          ...initialControl(scope.deviceId),
          customerId: scope.customerId,
          authEpoch: 1,
          enabled: true,
        };
        const { next, value } = change(current, scope, this.now().getTime());
        const saved = await this.deps.store.compareAndSwap(scope.deviceId, stored, {
          ...next,
          revision: current.revision + 1,
        });
        return { saved, value };
      });
      if (result.saved) return result.value;
      // A conflict requires a fresh guard, clock, snapshot and lease calculation.
    }
    throw new LiveImageLeaseError('TEMPORARILY_UNAVAILABLE');
  }

  async renewViewer(actor: ActorContext, deviceId: string, viewerId: string): Promise<LiveLease> {
    const normalizedViewerId = this.normalizeViewerId(deviceId, viewerId);
    return this.update({ kind: 'viewer', actor, deviceId }, (current, scope, now) => {
      const viewers = current.viewers.filter((lease) => lease.expiresAtMs > now);
      const owned = viewers.find(
        (lease) => lease.actorId === scope.actor!.actorId && lease.viewerId === normalizedViewerId,
      );
      if (!owned && viewers.length >= policy.maxViewersPerDevice) throw new LiveImageLeaseError('RATE_LIMITED');
      const streamId = viewers.length > 0 ? current.streamId! : this.newStreamId();
      const expiresAtMs = now + policy.leaseSeconds * 1000;
      const others = viewers.filter((lease) => lease !== owned);
      const next: LiveImageControl = {
        ...current,
        streamId,
        viewers: [...others, { actorId: scope.actor!.actorId, viewerId: normalizedViewerId, expiresAtMs }],
        latestCapturedAtMs: viewers.length === 0 ? null : current.latestCapturedAtMs,
        lastNewFrameAtMs: viewers.length === 0 ? null : current.lastNewFrameAtMs,
      };
      return {
        next,
        value: {
          streamId,
          leaseExpiresAt: new Date(expiresAtMs).toISOString(),
          renewAfterSeconds: 10,
          readIntervalMs: 2000,
        },
      };
    });
  }

  async releaseViewer(actor: ActorContext, deviceId: string, viewerId: string): Promise<void> {
    const normalizedViewerId = this.normalizeViewerId(deviceId, viewerId);
    await this.update({ kind: 'viewer', actor, deviceId }, (current, scope, now) => {
      const viewers = current.viewers.filter(
        (lease) =>
          lease.expiresAtMs > now && !(lease.actorId === scope.actor!.actorId && lease.viewerId === normalizedViewerId),
      );
      return {
        next: {
          ...current,
          viewers,
          streamId: viewers.length ? current.streamId : null,
          latestCapturedAtMs: viewers.length ? current.latestCapturedAtMs : null,
          lastNewFrameAtMs: viewers.length ? current.lastNewFrameAtMs : null,
        },
        value: undefined,
      };
    });
  }

  async getDeviceState(identity: ClientCertIdentity): Promise<LiveState> {
    return this.deps.authorization.withRead({ kind: 'device', identity }, async (scope) => {
      if (!isEligible(scope)) throw deny();
      const current = await this.deps.store.readControl(scope.deviceId);
      if (current && (!current.enabled || current.customerId !== scope.customerId)) throw deny();
      const now = this.now().getTime();
      const leases = current?.viewers.filter((lease) => lease.expiresAtMs > now) ?? [];
      if (!current?.streamId || leases.length === 0) return { state: 'IDLE', pollIntervalMs: 5000 };
      return {
        state: 'ACTIVE',
        pollIntervalMs: 5000,
        streamId: current.streamId,
        activeUntil: new Date(Math.max(...leases.map((lease) => lease.expiresAtMs))).toISOString(),
        uploadIntervalMs: 2000,
        maxImageBytes: 131072,
      };
    });
  }

  /** Trusted writer hook. The guard keeps its exclusive lock through the authority mutation. */
  async fenceAuthorization(
    deviceId: string,
    action: 'invalidate',
    changeAuthority?: () => Promise<void>,
  ): Promise<void>;
  async fenceAuthorization(deviceId: string, action: 'reset'): Promise<void>;
  async fenceAuthorization(
    deviceId: string,
    action: 'invalidate' | 'reset',
    changeAuthority?: () => Promise<void>,
  ): Promise<void> {
    await this.deps.authorization.withExclusive(deviceId, async (scope) => {
      if (scope.deviceId !== deviceId) throw deny();
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
        const stored = await this.deps.store.readControl(deviceId);
        const current = stored ?? initialControl(deviceId);
        const next: LiveImageControl = {
          ...initialControl(deviceId),
          customerId: scope.customerId,
          revision: current.revision + 1,
          authEpoch: current.authEpoch + 1,
          enabled: action === 'reset' && isEligible(scope),
        };
        if (await this.deps.store.compareAndSwap(deviceId, stored, next)) {
          await changeAuthority?.();
          return;
        }
      }
      throw new LiveImageLeaseError('TEMPORARILY_UNAVAILABLE');
    });
  }

  private normalizeViewerId(deviceId: string, viewerId: string): string {
    if (!deviceId || !UUID.test(viewerId)) throw new LiveImageLeaseError('VALIDATION_FAILED');
    return viewerId.toLowerCase();
  }
}
