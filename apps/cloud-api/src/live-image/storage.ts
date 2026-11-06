import type { ActorContext, ClientCertIdentity } from '@fdp/auth';

export interface LiveImageViewerLease {
  readonly actorId: string;
  readonly viewerId: string;
  readonly expiresAtMs: number;
}

/** CONTROL has no TTL. Revisions and authorization epochs must never be recycled. */
export interface LiveImageControl {
  readonly deviceId: string;
  readonly customerId: string | null;
  readonly revision: number;
  readonly authEpoch: number;
  readonly enabled: boolean;
  readonly streamId: string | null;
  readonly viewers: readonly LiveImageViewerLease[];
  readonly latestCapturedAtMs: number | null;
  readonly lastNewFrameAtMs: number | null;
}

export interface LiveImageControlVersion {
  readonly revision: number;
  readonly authEpoch: number;
}

/** Shared across instances. Reads are strongly consistent and return detached snapshots. */
export interface LiveImageControlStore {
  readControl(deviceId: string): Promise<LiveImageControl | null>;
  /**
   * Atomically replace CONTROL only if both revision and authEpoch still match.
   * null means create-if-absent. Return false only on a conditional conflict;
   * transport/authorization/corruption failures must throw. No in-memory fallback.
   * Replacement revision is previous+1 (or 1), epoch must not decrease.
   */
  compareAndSwap(
    deviceId: string,
    expected: LiveImageControlVersion | null,
    replacement: LiveImageControl,
  ): Promise<boolean>;
}

export type LiveImageAccess =
  | { readonly kind: 'viewer'; readonly actor: ActorContext; readonly deviceId: string }
  | { readonly kind: 'device'; readonly identity: ClientCertIdentity };

/** Refreshed under the authorization lock, never constructed from business JSON. */
export interface LiveImageAuthorizationScope {
  readonly deviceId: string;
  readonly customerId: string | null;
  readonly lifecycleStatus: string;
  readonly operationalStatus: string | null;
  readonly featureEnabled: boolean;
  readonly actor?: ActorContext;
}

export interface LiveImageAuthorizationGuard {
  /**
   * Authenticate again under the actor/device shared locks, check visibility,
   * certificate status and current roles, and hold locks through awaited work.
   * Role/config/lifecycle/assignment writers must use the matching exclusive lock.
   */
  withRead<T>(access: LiveImageAccess, work: (scope: LiveImageAuthorizationScope) => Promise<T>): Promise<T>;
  /**
   * Internal trusted write integration only. Hold the exclusive lock and refresh
   * scope through work, including the authority-mutation callback in the same
   * transaction. Bound external I/O and lock waits with adapter deadlines.
   * Invalidate before an authority mutation can commit;
   * explicit reset is allowed only after rechecking the authoritative state.
   */
  withExclusive<T>(deviceId: string, work: (scope: LiveImageAuthorizationScope) => Promise<T>): Promise<T>;
}
