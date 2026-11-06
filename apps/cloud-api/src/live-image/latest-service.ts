import type { ActorContext } from '@fdp/auth';
import { CAMERA_INTERACTION_POLICY } from '@fdp/contracts/domain/camera-interaction-policy.js';
import type { LiveLatest } from '@fdp/contracts/rest/image-types.js';
import { assertLiveImageViewer, isLiveImageEligible, LiveImageLeaseError, normalizeLiveImageUuid } from './service.js';
import type { LiveImageLeaseDeps } from './service.js';
import type { LiveImageLatestStore } from './storage.js';

export interface LiveImageLatestDeps extends Omit<LiveImageLeaseDeps, 'store' | 'newStreamId'> {
  readonly store: LiveImageLatestStore;
}

const ttlMs = CAMERA_INTERACTION_POLICY.liveImage.frameTtlSeconds * 1000;

export class LiveImageLatestService {
  private readonly now: () => Date;
  constructor(private readonly deps: LiveImageLatestDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async getLatest(actor: ActorContext, deviceId: string, viewerId: string, knownFrameId?: string): Promise<LiveLatest> {
    if (!deviceId) throw new LiveImageLeaseError('VALIDATION_FAILED');
    const normalizedViewerId = normalizeLiveImageUuid(viewerId);
    const known = knownFrameId === undefined ? undefined : normalizeLiveImageUuid(knownFrameId);
    const access = { kind: 'viewer' as const, actor, deviceId };
    return this.deps.authorization.withRead(access, async (scope) => {
      assertLiveImageViewer(scope, access);
      if (!isLiveImageEligible(scope)) throw new LiveImageLeaseError('FORBIDDEN');
      const { control, frame } = await this.deps.store.readLatestSnapshot(deviceId);
      const now = this.now().getTime();
      if (control && (!control.enabled || control.deviceId !== deviceId || control.customerId !== scope.customerId)) {
        throw new LiveImageLeaseError('FORBIDDEN');
      }
      const lease = control?.viewers.find(
        (item) => item.actorId === scope.actor!.actorId && item.viewerId === normalizedViewerId,
      );
      if (!control?.streamId || !lease || !Number.isFinite(lease.expiresAtMs) || lease.expiresAtMs <= now)
        throw new LiveImageLeaseError('LIVE_VIEWER_EXPIRED');
      const waiting: LiveLatest = { state: 'WAITING_FRAME', streamId: control.streamId };
      if (
        !frame ||
        frame.deviceId !== deviceId ||
        frame.customerId !== scope.customerId ||
        frame.authEpoch !== control.authEpoch ||
        frame.streamId !== control.streamId ||
        frame.mimeType !== 'image/jpeg'
      )
        return waiting;
      const capturedAtMs = Date.parse(frame.capturedAt);
      // Conservatively enforce the original lifetime even if storage has an overlong expiry.
      const expiresAtMs = Math.min(
        Date.parse(frame.expiresAt),
        capturedAtMs + ttlMs,
        Date.parse(frame.receivedAt) + ttlMs,
      );
      if (!(expiresAtMs > now) || capturedAtMs !== control.latestCapturedAtMs) return waiting;
      const expiresAt = new Date(expiresAtMs).toISOString();
      if (known === frame.frameId.toLowerCase()) {
        return { state: 'UNCHANGED', streamId: control.streamId, frameId: frame.frameId, expiresAt };
      }
      return {
        state: 'READY',
        streamId: control.streamId,
        frameId: frame.frameId,
        capturedAt: frame.capturedAt,
        expiresAt,
        mimeType: 'image/jpeg',
        imageBase64: frame.imageBase64,
      };
    });
  }
}
