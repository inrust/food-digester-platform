import { expect } from 'vitest';
import type { ActorContext, ClientCertIdentity } from '@fdp/auth';
import {
  createLiveImageLeaseHandlers,
  createLiveImageFrameHandler,
  createLiveImageLatestHandler,
  LiveImageLatestService,
  LiveImageFrameService,
  LiveImageLeaseError,
  LiveImageLeaseService,
} from '../src/live-image/index.js';
import type {
  LiveImageAccess,
  LiveImageAuthorizationGuard,
  LiveImageAuthorizationScope,
  LiveImageControl,
  LiveImageControlVersion,
  LiveImageFrameStore,
  LiveImageStoredFrame,
  LiveImageFrameReceipt,
  LiveImageFrameCommit,
  LiveImageLatestStore,
} from '../src/live-image/index.js';

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Models the shared/exclusive locking required of the production authority adapter. */
class ReadWriteLock {
  private readers = 0;
  private writer = false;
  private queue: { write: boolean; grant: () => void }[] = [];
  async acquire(write: boolean): Promise<() => void> {
    await new Promise<void>((grant) => {
      this.queue.push({ write, grant });
      this.drain();
    });
    return () => {
      if (write) this.writer = false;
      else this.readers--;
      this.drain();
    };
  }
  private drain(): void {
    while (!this.writer && this.queue.length) {
      const next = this.queue[0]!;
      if (next.write && this.readers) return;
      this.queue.shift();
      if (next.write) this.writer = true;
      else this.readers++;
      next.grant();
    }
  }
}

/** Detached snapshots and atomic CAS shared by independently constructed services. */
export class TestControlStore implements LiveImageFrameStore, LiveImageLatestStore {
  readonly controls = new Map<string, LiveImageControl>();
  beforeLatestSnapshot: (() => Promise<void>) | undefined;
  afterLatestSnapshot: (() => Promise<void>) | undefined;
  latestReads = 0;
  async readLatestSnapshot(deviceId: string) {
    await this.beforeLatestSnapshot?.();
    const snapshot = structuredClone({
      control: this.controls.get(deviceId) ?? null,
      frame: this.frames.get(deviceId) ?? null,
    });
    this.latestReads++;
    await this.afterLatestSnapshot?.();
    return snapshot;
  }
  readonly frames = new Map<string, LiveImageStoredFrame>();
  readonly receipts = new Map<string, LiveImageFrameReceipt>();
  beforeFrameCommit?: () => Promise<void>;
  frameConflicts = 0;
  frameWrites = 0;
  now = () => Date.parse('2026-11-06T08:00:00.000Z');
  private receiptKey(deviceId: string, streamId: string, frameId: string): string {
    return JSON.stringify([deviceId, streamId, frameId.toLowerCase()]);
  }
  async readUploadSnapshot(deviceId: string, streamId: string, frameId: string) {
    return structuredClone({
      control: this.controls.get(deviceId) ?? null,
      receipt: this.receipts.get(this.receiptKey(deviceId, streamId, frameId)) ?? null,
    });
  }
  async commitFrame(batch: LiveImageFrameCommit): Promise<boolean> {
    await this.beforeFrameCommit?.();
    if (this.frameConflicts > 0) {
      this.frameConflicts--;
      return false;
    }
    const current = this.controls.get(batch.control.deviceId);
    const now = this.now();
    if (
      !current ||
      current.revision !== batch.expected.revision ||
      current.authEpoch !== batch.expected.authEpoch ||
      !current.enabled ||
      current.customerId !== batch.frame.customerId ||
      current.streamId !== batch.frame.streamId ||
      !current.viewers.some((lease) => lease.expiresAtMs > now) ||
      Date.parse(batch.frame.expiresAt) <= now ||
      (current.latestCapturedAtMs !== null && Date.parse(batch.frame.capturedAt) <= current.latestCapturedAtMs) ||
      (current.lastNewFrameAtMs !== null && now - current.lastNewFrameAtMs < 1000)
    )
      return false;
    expect(batch.control.revision).toBe(current.revision + 1);
    expect(batch.control.authEpoch).toBe(current.authEpoch);
    const next = structuredClone(batch);
    // No await or partial writes between the checks and this atomic publication.
    this.controls.set(next.control.deviceId, next.control);
    this.frames.set(next.frame.deviceId, next.frame);
    this.receipts.set(
      this.receiptKey(next.receipt.deviceId, next.receipt.streamId, next.receipt.frameId),
      next.receipt,
    );
    this.frameWrites++;
    this.writes++;
    return true;
  }
  conflicts = 0;
  writes = 0;
  beforeCas?: () => Promise<void>;
  async readControl(deviceId: string): Promise<LiveImageControl | null> {
    return structuredClone(this.controls.get(deviceId) ?? null);
  }
  async compareAndSwap(
    deviceId: string,
    expected: LiveImageControlVersion | null,
    next: LiveImageControl,
  ): Promise<boolean> {
    await this.beforeCas?.();
    if (this.conflicts > 0) {
      this.conflicts--;
      return false;
    }
    const current = this.controls.get(deviceId);
    if (
      current
        ? !expected || current.revision !== expected.revision || current.authEpoch !== expected.authEpoch
        : expected !== null
    )
      return false;
    expect(next.deviceId).toBe(deviceId);
    expect(next.revision).toBe((current?.revision ?? 0) + 1);
    expect(next.authEpoch).toBeGreaterThanOrEqual(current?.authEpoch ?? 0);
    this.controls.set(deviceId, structuredClone(next));
    this.writes++;
    return true;
  }
}

export const actor = (id = 'alice', customerId = 'customer-A'): ActorContext => ({
  actorId: id,
  username: id,
  actorType: 'customer',
  roles: ['CustomerViewer'],
  customerId,
  tokenUse: 'access',
});
export const cert: ClientCertIdentity = { clientCertPem: 'test-certificate' };

export class TestAuthorization implements LiveImageAuthorizationGuard {
  readonly lock = new ReadWriteLock();
  scope: LiveImageAuthorizationScope = {
    deviceId: 'device-1',
    customerId: 'customer-A',
    lifecycleStatus: 'Active',
    operationalStatus: 'Active',
  };
  readonly actors = new Map<string, ActorContext>([
    ['alice', actor()],
    ['bob', actor('bob')],
  ]);
  certificateActive = true;
  reads = 0;
  afterRead: (() => Promise<void>) | undefined;

  async withRead<T>(access: LiveImageAccess, work: (scope: LiveImageAuthorizationScope) => Promise<T>): Promise<T> {
    const release = await this.lock.acquire(false);
    let result: T;
    try {
      this.reads++;
      if (access.kind === 'device') {
        if (!this.certificateActive || access.identity.clientCertPem !== cert.clientCertPem)
          throw new LiveImageLeaseError('UNAUTHENTICATED');
        result = await work(structuredClone(this.scope));
      } else {
        const fresh = this.actors.get(access.actor.actorId);
        if (!fresh) throw new LiveImageLeaseError('UNAUTHENTICATED');
        if (access.deviceId !== this.scope.deviceId) throw new LiveImageLeaseError('NOT_FOUND');
        result = await work({ ...structuredClone(this.scope), actor: structuredClone(fresh) });
      }
    } finally {
      release();
    }
    const hook = this.afterRead;
    this.afterRead = undefined;
    await hook?.();
    return result;
  }
  async withExclusive<T>(deviceId: string, work: (scope: LiveImageAuthorizationScope) => Promise<T>): Promise<T> {
    const release = await this.lock.acquire(true);
    try {
      if (deviceId !== this.scope.deviceId) throw new LiveImageLeaseError('NOT_FOUND');
      return await work(structuredClone(this.scope));
    } finally {
      release();
    }
  }
}

export function fixture() {
  const store = new TestControlStore();
  const authorization = new TestAuthorization();
  let clock = Date.parse('2026-11-06T08:00:00.000Z');
  store.now = () => clock;
  const deps = { store, authorization, now: () => new Date(clock) };
  return {
    store,
    authorization,
    deps,
    service: new LiveImageLeaseService(deps),
    handlers: createLiveImageLeaseHandlers(deps),
    frames: new LiveImageFrameService(deps),
    upload: createLiveImageFrameHandler(deps),
    latest: new LiveImageLatestService(deps),
    readLatest: createLiveImageLatestHandler(deps),
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
export const request = (viewerId: string, who = actor()) => ({
  actor: who,
  headers: {},
  requestId: 'test-live-image',
  params: { deviceId: 'device-1', viewerId },
});
