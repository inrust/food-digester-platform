import type { ClientCertIdentity } from '@fdp/auth';
import { CAMERA_INTERACTION_POLICY } from '@fdp/contracts/domain/camera-interaction-policy.js';
import type { LiveFrameAccepted } from '@fdp/contracts/rest/image-types.js';
import { LiveImageLeaseError, isLiveImageEligible } from './service.js';
import type { LiveImageLeaseDeps } from './service.js';
import type { LiveImageFrameStore, LiveImageFrameReceipt, LiveImageStoredFrame, LiveImageControl } from './storage.js';
import { parseLiveImageFrame, validateLiveImageJpeg } from './frame-validation.js';

export interface LiveImageFrameDeps extends Omit<LiveImageLeaseDeps, 'store' | 'newStreamId'> {
  readonly store: LiveImageFrameStore;
}
const policy = CAMERA_INTERACTION_POLICY.liveImage;

function assertNewFrameAllowed(control: LiveImageControl, capturedAtMs: number, now: number): number {
  if (!control.viewers.some((lease) => lease.expiresAtMs > now)) throw new LiveImageLeaseError('LIVE_STREAM_INACTIVE');
  if (capturedAtMs > now + policy.maxFutureSkewSeconds * 1000) throw new LiveImageLeaseError('VALIDATION_FAILED');
  const expiresAtMs = Math.min(capturedAtMs + policy.frameTtlSeconds * 1000, now + policy.frameTtlSeconds * 1000);
  if (expiresAtMs <= now || (control.latestCapturedAtMs !== null && capturedAtMs <= control.latestCapturedAtMs)) {
    throw new LiveImageLeaseError('STALE_FRAME');
  }
  if (control.lastNewFrameAtMs !== null && now - control.lastNewFrameAtMs < policy.minUploadIntervalMs) {
    throw new LiveImageLeaseError('RATE_LIMITED');
  }
  return expiresAtMs;
}

export class LiveImageFrameService {
  private readonly now: () => Date;
  constructor(private readonly deps: LiveImageFrameDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async uploadFrame(identity: ClientCertIdentity, body: unknown): Promise<LiveFrameAccepted> {
    const parsed = parseLiveImageFrame(body);
    const { payload, capturedAtMs, requestHash } = parsed;
    const streamId = payload.streamId.toLowerCase();
    const frameId = payload.frameId.toLowerCase();
    let decoded = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await this.deps.authorization.withRead({ kind: 'device', identity }, async (scope) => {
        if (!isLiveImageEligible(scope)) throw new LiveImageLeaseError('FORBIDDEN');
        const snapshot = await this.deps.store.readUploadSnapshot(scope.deviceId, streamId, frameId);
        const control = snapshot.control;
        if (control?.enabled && control.customerId !== scope.customerId) throw new LiveImageLeaseError('FORBIDDEN');
        let now = this.now().getTime();
        if (
          !control?.enabled ||
          control.streamId !== streamId ||
          !control.viewers.some((lease) => lease.expiresAtMs > now)
        ) {
          throw new LiveImageLeaseError('LIVE_STREAM_INACTIVE');
        }
        const prior = snapshot.receipt;
        if (
          prior &&
          prior.authEpoch === control.authEpoch &&
          prior.customerId === scope.customerId &&
          prior.dedupUntilMs > now
        ) {
          if (prior.requestHash !== requestHash) throw new LiveImageLeaseError('FRAME_CONFLICT');
          return {
            saved: true,
            response: {
              frameId: prior.frameId,
              receivedAt: prior.receivedAt,
              expiresAt: prior.expiresAt,
              replayed: true,
            },
          };
        }
        assertNewFrameAllowed(control, capturedAtMs, now);
        if (!decoded) {
          validateLiveImageJpeg(parsed.jpeg);
          decoded = true;
        }
        now = this.now().getTime();
        const expiresAtMs = assertNewFrameAllowed(control, capturedAtMs, now);
        const receivedAt = new Date(now).toISOString();
        const expiresAt = new Date(expiresAtMs).toISOString();
        const frame: LiveImageStoredFrame = {
          deviceId: scope.deviceId,
          customerId: scope.customerId!,
          authEpoch: control.authEpoch,
          streamId,
          frameId: payload.frameId,
          capturedAt: payload.capturedAt,
          receivedAt,
          expiresAt,
          mimeType: 'image/jpeg',
          imageBase64: payload.imageBase64,
          ttl: Math.ceil(expiresAtMs / 1000),
        };
        const dedupUntilMs = now + policy.dedupSeconds * 1000;
        const receipt: LiveImageFrameReceipt = {
          deviceId: scope.deviceId,
          customerId: scope.customerId!,
          authEpoch: control.authEpoch,
          streamId,
          frameId: payload.frameId,
          requestHash,
          receivedAt,
          expiresAt,
          dedupUntilMs,
          ttl: Math.ceil(dedupUntilMs / 1000),
        };
        const saved = await this.deps.store.commitFrame({
          expected: control,
          control: {
            ...control,
            revision: control.revision + 1,
            latestCapturedAtMs: capturedAtMs,
            lastNewFrameAtMs: now,
          },
          frame,
          receipt,
        });
        return { saved, response: { frameId: payload.frameId, receivedAt, expiresAt, replayed: false } };
      });
      if (result.saved) return result.response;
    }
    throw new LiveImageLeaseError('TEMPORARILY_UNAVAILABLE');
  }
}
