import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startImagePreview } from '../../admin-web/src/pages/devices/live-image-session.js';
import type { ImagePreviewState } from '../../admin-web/src/pages/devices/live-image-session.js';
import { createTestDb } from './helpers.js';
import { imageIntegrationFixture } from './device-image-integration-fixtures.js';
import {
  renewImageViewer,
  releaseImageViewer,
  readLatestImage,
} from '../../admin-web/src/pages/devices/live-image-api.js';
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
  await db.pg.exec(readFileSync(new URL('../../../packages/database/prisma/seed.sql', import.meta.url), 'utf8'));
}, 60000);
afterAll(async () => {
  await db?.prisma.$disconnect();
  await db?.pg.close();
});
const signal = () => new AbortController().signal;
test('normal frontend adapter -> JWT/CORS/Lambda -> shared frame returns UNCHANGED using the frozen query parameter', async () => {
  const f = await imageIntegrationFixture(db),
    viewer = randomUUID();
  const lease = await renewImageViewer(f.alice.api, f.deviceId, viewer, signal());
  const frame = f.frame(lease.data.streamId);
  expect((await f.device('live-image/frames', frame)).status).toBe(200);
  expect((await readLatestImage(f.alice.api, f.deviceId, viewer, signal())).data.state).toBe('READY');
  const unchanged = await readLatestImage(f.alice.api, f.deviceId, viewer, signal(), frame.frameId);
  expect(unchanged.data.state).toBe('UNCHANGED');
  expect(f.calls.at(-1)?.query).toContain('knownFrameId=');
  expect(unchanged.data).not.toHaveProperty('imageBase64');
  expect(await f.client.mediaUploadSession.count({ where: { deviceId: f.deviceId } })).toBe(0);
});

async function viewing(f: Awaited<ReturnType<typeof imageIntegrationFixture>>) {
  const a = randomUUID(),
    b = randomUUID();
  const [one, two] = await Promise.all([
    renewImageViewer(f.alice.api, f.deviceId, a, signal()),
    renewImageViewer(f.bob.api, f.deviceId, b, signal()),
  ]);
  expect(one.data.streamId).toBe(two.data.streamId);
  return { a, b, stream: one.data.streamId };
}
test('two HTTP viewers share a frame; one release survives and last release racing upload cannot resurrect it', async () => {
  const f = await imageIntegrationFixture(db),
    v = await viewing(f),
    frame = f.frame(v.stream);
  expect((await f.device('live-image/frames', frame)).status).toBe(200);
  await releaseImageViewer(f.alice.api, f.deviceId, v.a);
  expect((await readLatestImage(f.bob.api, f.deviceId, v.b, signal())).data.state).toBe('READY');
  await expect(readLatestImage(f.bob.api, f.deviceId, v.a, signal())).rejects.toMatchObject({ status: 409 });
  f.advance(2000);
  const [upload] = await Promise.all([
    f.device('live-image/frames', f.frame(v.stream)),
    releaseImageViewer(f.bob.api, f.deviceId, v.b),
  ]);
  expect([200, 409]).toContain(upload.status);
  expect((await f.device('live-image/state')).body.data.state).toBe('IDLE');
  await expect(readLatestImage(f.bob.api, f.deviceId, v.b, signal())).rejects.toMatchObject({
    status: 409,
    code: 'LIVE_VIEWER_EXPIRED',
  });
  const next = await renewImageViewer(f.bob.api, f.deviceId, randomUUID(), signal());
  expect(next.data.streamId).not.toBe(v.stream);
  expect((await f.device('live-image/frames', f.frame(v.stream))).status).toBe(409);
});
test('concurrent duplicates publish once; throttle, stale frame and expiry use the normal device/latest routes', async () => {
  const f = await imageIntegrationFixture(db),
    v = await viewing(f),
    frame = f.frame(v.stream);
  const duplicate = await Promise.all([f.device('live-image/frames', frame), f.device('live-image/frames', frame)]);
  expect(duplicate.map((r) => r.status)).toEqual([200, 200]);
  expect(duplicate.map((r) => r.body.data.replayed).sort()).toEqual([false, true]);
  expect(f.store.frameWrites).toBe(1);
  expect(new Set(duplicate.map((r) => r.body.data.expiresAt)).size).toBe(1);
  expect(
    (await f.device('live-image/frames', { ...frame, capturedAt: new Date(f.now().getTime() + 1).toISOString() })).body
      .error.code,
  ).toBe('FRAME_CONFLICT');
  f.advance(500);
  const throttled = await f.device('live-image/frames', f.frame(v.stream));
  expect(throttled.status).toBe(429);
  expect(throttled.headers['Retry-After']).toBe('1');
  f.advance(1500);
  const fresh = f.frame(v.stream);
  expect((await f.device('live-image/frames', fresh)).status).toBe(200);
  expect((await f.device('live-image/frames', { ...frame, frameId: randomUUID() })).body.error.code).toBe(
    'STALE_FRAME',
  );
  f.advance(10000);
  expect((await readLatestImage(f.alice.api, f.deviceId, v.a, signal())).data.state).toBe('WAITING_FRAME');
  f.advance(18000);
  await expect(readLatestImage(f.alice.api, f.deviceId, v.a, signal())).rejects.toMatchObject({
    code: 'LIVE_VIEWER_EXPIRED',
  });
});
test('storage exception yields safe HTTP 503 without partial frame; identical retry recovers with original deadline', async () => {
  const f = await imageIntegrationFixture(db),
    v = await viewing(f),
    frame = f.frame(v.stream);
  const original = f.store.commitFrame.bind(f.store);
  let fail = true;
  f.store.commitFrame = async (batch) => {
    if (fail) throw new Error('private database secret');
    return original(batch);
  };
  const first = await f.device('live-image/frames', frame);
  expect(first.status).toBe(503);
  expect(JSON.stringify(first.body)).not.toContain('secret');
  expect(f.store.frames.has(f.deviceId)).toBe(false);
  expect(f.store.receipts.size).toBe(0);
  expect((await readLatestImage(f.bob.api, f.deviceId, v.b, signal())).data.state).toBe('WAITING_FRAME');
  fail = false;
  f.advance(2000);
  const retry = await f.device('live-image/frames', frame);
  expect(retry.status).toBe(200);
  expect(retry.body.data.expiresAt).toBe(new Date(Date.parse(frame.capturedAt) + 10000).toISOString());
  expect((await readLatestImage(f.bob.api, f.deviceId, v.b, signal())).data.state).toBe('READY');
});
test.each(['role', 'account', 'suspend', 'retire'] as const)(
  'authoritative %s write invalidates old HTTP viewers and frames',
  async (kind) => {
    const f = await imageIntegrationFixture(db),
      v = await viewing(f);
    expect((await f.device('live-image/frames', f.frame(v.stream))).status).toBe(200);
    const epoch = f.store.controls.get(f.deviceId)!.authEpoch;
    if (kind === 'role') await f.client.userRole.deleteMany({ where: { userId: f.alice.id } });
    if (kind === 'account') await f.client.user.update({ where: { id: f.alice.id }, data: { status: 'DISABLED' } });
    if (kind === 'suspend')
      await f.client.deviceLatestState.update({
        where: { deviceId: f.deviceId },
        data: { operationalStatus: 'Suspended' },
      });
    if (kind === 'retire')
      await f.client.device.update({ where: { id: f.deviceId }, data: { lifecycleStatus: 'Retired' } });
    expect(f.store.controls.get(f.deviceId)!.authEpoch).toBeGreaterThan(epoch);
    expect(f.store.controls.get(f.deviceId)!.viewers).toEqual([]);
    await expect(readLatestImage(f.alice.api, f.deviceId, v.a, signal())).rejects.toMatchObject(
      kind === 'account' ? { name: 'UnauthenticatedError' } : { status: 403 },
    );
    expect((await f.device('live-image/frames', f.frame(v.stream))).status).toBe(
      kind === 'role' || kind === 'account' ? 409 : 403,
    );
    if (kind === 'suspend') {
      await f.client.deviceLatestState.update({
        where: { deviceId: f.deviceId },
        data: { operationalStatus: 'Active' },
      });
      expect((await f.device('live-image/state')).body.data.state).toBe('IDLE');
      const id = randomUUID(),
        fresh = await renewImageViewer(f.bob.api, f.deviceId, id, signal());
      expect(fresh.data.streamId).not.toBe(v.stream);
      expect((await readLatestImage(f.bob.api, f.deviceId, id, signal())).data.state).toBe('WAITING_FRAME');
    }
  },
);
test('customer migration rejects old JWT scope and old stream but new owner can open a fresh stream', async () => {
  const f = await imageIntegrationFixture(db),
    v = await viewing(f),
    other = `c-${randomUUID()}`;
  await f.client.customer.create({ data: { id: other, name: 'New customer' } });
  await f.client.device.update({ where: { id: f.deviceId }, data: { customerId: other } });
  await expect(readLatestImage(f.alice.api, f.deviceId, v.a, signal())).rejects.toMatchObject({ status: 404 });
  const next = await f.viewer('new-owner', other),
    id = randomUUID();
  const lease = await renewImageViewer(next.api, f.deviceId, id, signal());
  expect(lease.data.streamId).not.toBe(v.stream);
  expect((await f.device('live-image/frames', f.frame(v.stream))).status).toBe(409);
  expect((await f.device('live-image/frames', f.frame(lease.data.streamId))).status).toBe(200);
});
test('certificate revocation closes preview and denies archive issuance and MQTT before any business receipt', async () => {
  const f = await imageIntegrationFixture(db),
    v = await viewing(f);
  await f.client.deviceCertificate.update({ where: { id: f.certId }, data: { status: 'REVOKED', revokedAt: f.now() } });
  expect((await f.device('live-image/state')).status).toBe(401);
  expect((await f.device('live-image/frames', f.frame(v.stream))).status).toBe(401);
  expect((await f.device('media/upload-sessions', f.declaration('EVENT', 'EVT-REVOKED'))).status).toBe(401);
  expect((await f.ingest([f.source('EVENT', 'EVT-REVOKED')])).batchItemFailures).toEqual([]);
  expect(f.quarantine.send).toHaveBeenCalledOnce();
  expect(await f.client.ingestionReceipt.count({ where: { deviceId: f.deviceId } })).toBe(0);
});
test('actual page engine clears on real 503, recovers a fresh viewer/stream, then stops on database role revocation', async () => {
  const f = await imageIntegrationFixture(db),
    states: ImagePreviewState[] = [];
  const stop = startImagePreview({ api: f.alice.api, deviceId: f.deviceId, onState: (state) => states.push(state) });
  try {
    await vi.waitFor(() => expect(f.store.controls.get(f.deviceId)?.streamId).toBeTruthy());
    const previous = f.store.controls.get(f.deviceId)!.streamId!;
    expect((await f.device('live-image/frames', f.frame(previous))).status).toBe(200);
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('ready'), { timeout: 4000 });
    vi.spyOn(f.store, 'readLatestSnapshot').mockRejectedValueOnce(new Error('private storage details'));
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('recovering'), { timeout: 4000 });
    expect(states.at(-1)).not.toHaveProperty('frame');
    await vi.waitFor(
      () => {
        expect(f.store.controls.get(f.deviceId)?.streamId).not.toBe(previous);
        expect(states.at(-1)?.status).toBe('waiting');
      },
      { timeout: 4000 },
    );
    const next = f.store.controls.get(f.deviceId)!.streamId!;
    f.advance(2000);
    expect((await f.device('live-image/frames', f.frame(previous))).status).toBe(409);
    expect((await f.device('live-image/frames', f.frame(next))).status).toBe(200);
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('ready'), { timeout: 4000 });
    await f.client.userRole.deleteMany({ where: { userId: f.alice.id } });
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe('error'), { timeout: 4000 });
    expect(states.at(-1)).not.toHaveProperty('frame');
    expect(f.store.controls.get(f.deviceId)!.viewers).toEqual([]);
    const calls = f.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(f.calls).toHaveLength(calls);
  } finally {
    stop();
  }
}, 20000);
test('in-flight authorized read drains before the authority write; later HTTP reads deny and new owner viewer never sees the old frame', async () => {
  const f = await imageIntegrationFixture(db),
    v = await viewing(f);
  expect((await f.device('live-image/frames', f.frame(v.stream))).status).toBe(200);
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.store.afterLatestSnapshot = async () => {
    started();
    await held;
  };
  const pending = readLatestImage(f.alice.api, f.deviceId, v.a, signal());
  await entered;
  let committed = false;
  const revoke = f.client.userRole.deleteMany({ where: { userId: f.alice.id } }).then(() => {
    committed = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(committed).toBe(false);
  } finally {
    f.store.afterLatestSnapshot = undefined;
    release();
  }
  expect((await pending).data.state).toBe('READY');
  await revoke;
  await expect(readLatestImage(f.alice.api, f.deviceId, v.a, signal())).rejects.toMatchObject({ status: 403 });
  const viewer = randomUUID(),
    next = await renewImageViewer(f.bob.api, f.deviceId, viewer, signal());
  expect(next.data.streamId).not.toBe(v.stream);
  expect((await readLatestImage(f.bob.api, f.deviceId, viewer, signal())).data.state).toBe('WAITING_FRAME');
});
