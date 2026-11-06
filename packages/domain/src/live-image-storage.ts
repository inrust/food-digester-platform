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
  /** Device-wide throttle survives stream and authorization changes. */
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

export interface LiveImageStoredFrame {
  readonly deviceId: string;
  readonly customerId: string;
  readonly authEpoch: number;
  readonly streamId: string;
  readonly frameId: string;
  readonly capturedAt: string;
  readonly receivedAt: string;
  readonly expiresAt: string;
  readonly mimeType: 'image/jpeg';
  readonly imageBase64: string;
  /** Epoch seconds for physical collection only. */
  readonly ttl: number;
}

export interface LiveImageFrameReceipt {
  readonly deviceId: string;
  readonly customerId: string;
  readonly authEpoch: number;
  readonly streamId: string;
  readonly frameId: string;
  readonly requestHash: string;
  readonly receivedAt: string;
  readonly expiresAt: string;
  readonly dedupUntilMs: number;
  readonly ttl: number;
}

export interface LiveImageUploadSnapshot {
  readonly control: LiveImageControl | null;
  readonly receipt: LiveImageFrameReceipt | null;
}

export interface LiveImageFrameCommit {
  readonly expected: LiveImageControlVersion;
  readonly control: LiveImageControl;
  readonly frame: LiveImageStoredFrame;
  readonly receipt: LiveImageFrameReceipt;
}

export interface LiveImageFrameStore extends LiveImageControlStore {
  /** Transactional snapshot, keyed by device + canonical stream UUID + canonical frame UUID. */
  readUploadSnapshot(deviceId: string, streamId: string, frameId: string): Promise<LiveImageUploadSnapshot>;
  /**
   * One all-or-nothing operation: conditionally update CONTROL and put FRAME/DEDUP.
   * Check revision/epoch, customer, stream, enabled, unexpired viewers, timestamp
   * watermark and per-device rate together. Use a fresh adapter submission clock
   * to reject expired leases/frames. Bound transaction I/O by the lease/frame deadlines.
   * Every frame/receipt write advances CONTROL revision; no separate best-effort writes.
   * false is a conditional conflict or expired deadline; all other failures throw.
   */
  commitFrame(commit: LiveImageFrameCommit): Promise<boolean>;
}

export interface LiveImageLatestSnapshot {
  readonly control: LiveImageControl | null;
  readonly frame: LiveImageStoredFrame | null;
}

/** Read-only port: CONTROL and FRAME must come from one transactional snapshot. */
export interface LiveImageLatestStore {
  /**
   * Return detached records from the same serialization point, never independent
   * eventually consistent reads. Physical TTL presence does not imply visibility.
   * Transport/authorization/corruption failures throw; no cached-frame fallback.
   */
  readLatestSnapshot(deviceId: string): Promise<LiveImageLatestSnapshot>;
}
