import type { ActorContext, ClientCertIdentity } from '@fdp/auth';

export type {
  LiveImageViewerLease,
  LiveImageControl,
  LiveImageControlVersion,
  LiveImageControlStore,
  LiveImageStoredFrame,
  LiveImageFrameReceipt,
  LiveImageUploadSnapshot,
  LiveImageFrameCommit,
  LiveImageFrameStore,
  LiveImageLatestSnapshot,
  LiveImageLatestStore,
} from '@fdp/domain';

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
