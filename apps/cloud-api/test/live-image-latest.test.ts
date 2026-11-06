import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ActorContext } from '@fdp/auth';
import type { LiveImageLeaseResponse, LiveImageStoredFrame } from '../src/live-image/index.js';
import { createAjv } from '../../../contracts/testing/device-contract.js';
import { actor, cert, deferred, fixture, request } from './live-image-fixtures.js';

const sample = JSON.parse(
  readFileSync(new URL('../../../contracts/rest/fixtures/device-images/frame-request.json', import.meta.url), 'utf8'),
);
const api = JSON.parse(readFileSync(new URL('../../../contracts/rest/openapi.bundle.json', import.meta.url), 'utf8'));
api.$id = 'https://latest-tests.local/api';
const ajv = createAjv();
ajv.addSchema(api);
const operation = api.paths['/api/v1/admin/devices/{deviceId}/live-image/latest'].get;
function assertResponse(response: LiveImageLeaseResponse): void {
  const schema = operation.responses[String(response.status)].content['application/json'].schema;
  const validate = ajv.compile({ $ref: api.$id + schema.$ref });
  expect(validate(response.body), JSON.stringify(validate.errors)).toBe(true);
  expect(response.headers['Cache-Control']).toBe('no-store');
}
async function active(withFrame = true) {
  const f = fixture();
  const viewerId = randomUUID();
  const lease = await f.service.renewViewer(actor(), 'device-1', viewerId);
  const payload = {
    ...sample,
    streamId: lease.streamId,
    frameId: randomUUID(),
    capturedAt: new Date(f.now()).toISOString(),
  };
  if (withFrame) await f.frames.uploadFrame(cert, payload);
  const read = (knownFrameId?: string) =>
    f.readLatest({
      ...request(viewerId),
      query: { viewerId, ...(knownFrameId === undefined ? {} : { knownFrameId }) },
    });
  return { ...f, lease, viewerId, payload, read };
}

function expectNoImage(response: LiveImageLeaseResponse): void {
  expect(JSON.stringify(response.body)).not.toContain('imageBase64');
}

describe('IMG-07 latest image states', () => {
  test('valid viewer with no published frame receives WAITING_FRAME', async () => {
    const f = await active(false);
    const before = f.store.writes;
    const response = await f.read();
    expect(response.body).toMatchObject({ data: { state: 'WAITING_FRAME', streamId: f.lease.streamId } });
    assertResponse(response);
    expectNoImage(response);
    expect(f.store.writes).toBe(before);
  });
  test('READY returns only the public frame fields', async () => {
    const f = await active();
    const response = await f.read();
    expect(response.body).toEqual({
      data: {
        state: 'READY',
        streamId: f.lease.streamId,
        frameId: f.payload.frameId,
        capturedAt: f.payload.capturedAt,
        expiresAt: '2026-11-06T08:00:10.000Z',
        mimeType: 'image/jpeg',
        imageBase64: sample.imageBase64,
      },
      meta: { requestId: 'test-live-image', timestamp: '2026-11-06T08:00:00.000Z' },
    });
    assertResponse(response);
    for (const key of ['customerId', 'authEpoch', 'revision', 'ttl', 'receivedAt'])
      expect((response.body as any).data).not.toHaveProperty(key);
  });
  test('UNCHANGED omits pixels and capture time and preserves the original expiry', async () => {
    const f = await active();
    f.advance(1000);
    const control = structuredClone(f.store.controls.get('device-1'));
    const frame = structuredClone(f.store.frames.get('device-1'));
    const writes = f.store.writes;
    const response = await f.read(f.payload.frameId);
    expect(response.body).toMatchObject({
      data: {
        state: 'UNCHANGED',
        streamId: f.lease.streamId,
        frameId: f.payload.frameId,
        expiresAt: '2026-11-06T08:00:10.000Z',
      },
    });
    assertResponse(response);
    expectNoImage(response);
    expect((response.body as any).data).not.toHaveProperty('capturedAt');
    expect(f.store.controls.get('device-1')).toEqual(control);
    expect(f.store.frames.get('device-1')).toEqual(frame);
    expect(f.store.writes).toBe(writes);
  });
  test('an unknown knownFrameId gets READY and UUID letter case is canonicalized', async () => {
    const f = await active();
    expect((await f.read(randomUUID())).body).toMatchObject({ data: { state: 'READY' } });
    const response = await f.readLatest({
      ...request(f.viewerId),
      query: { viewerId: f.viewerId.toUpperCase(), knownFrameId: f.payload.frameId.toUpperCase() },
    });
    expect(response.body).toMatchObject({ data: { state: 'UNCHANGED' } });
    assertResponse(response);
  });
  test('expiration is checked before knownFrameId, including the exact expiry boundary', async () => {
    const f = await active();
    f.advance(9999);
    expect((await f.read(f.payload.frameId)).body).toMatchObject({ data: { state: 'UNCHANGED' } });
    f.advance(1);
    const response = await f.read(f.payload.frameId);
    expect(response.body).toMatchObject({ data: { state: 'WAITING_FRAME' } });
    expect(f.store.frames.size).toBe(1);
    assertResponse(response);
    expectNoImage(response);
  });
  test('physical frame deletion does not fall back to an earlier response', async () => {
    const f = await active();
    expect((await f.read()).body).toMatchObject({ data: { state: 'READY' } });
    f.store.frames.clear();
    const response = await f.read(f.payload.frameId);
    expect(response.body).toMatchObject({ data: { state: 'WAITING_FRAME' } });
    expectNoImage(response);
  });
  test('old FRAME retained across last release and stream reopening is invisible', async () => {
    const f = await active();
    await f.service.releaseViewer(actor(), 'device-1', f.viewerId);
    const next = await f.service.renewViewer(actor(), 'device-1', f.viewerId);
    const response = await f.read(f.payload.frameId);
    expect(response.body).toMatchObject({ data: { state: 'WAITING_FRAME', streamId: next.streamId } });
    expect(next.streamId).not.toBe(f.payload.streamId);
    expectNoImage(response);
  });
  for (const patch of [
    { deviceId: 'other-device' },
    { customerId: 'other-customer' },
    { authEpoch: 0 },
    { streamId: randomUUID() },
    { mimeType: 'image/png' },
    { expiresAt: 'invalid' },
    { capturedAt: 'invalid' },
    { receivedAt: 'invalid' },
  ]) {
    test(`stored frame mismatch returns WAITING_FRAME for ${JSON.stringify(patch)}`, async () => {
      const f = await active();
      f.store.frames.set('device-1', { ...f.store.frames.get('device-1')!, ...patch } as LiveImageStoredFrame);
      const response = await f.read(f.payload.frameId);
      expect(response.body).toMatchObject({ data: { state: 'WAITING_FRAME' } });
      assertResponse(response);
      expectNoImage(response);
    });
  }
  test('a frame which differs from the CONTROL capture watermark is not presented', async () => {
    const f = await active();
    const current = f.store.controls.get('device-1')!;
    f.store.controls.set('device-1', { ...current, latestCapturedAtMs: f.now() + 1 });
    expect((await f.read()).body).toMatchObject({ data: { state: 'WAITING_FRAME' } });
  });
  test('an overlong stored expiry cannot extend the capture or receive lifetime', async () => {
    const f = await active();
    f.store.frames.set('device-1', {
      ...f.store.frames.get('device-1')!,
      expiresAt: new Date(f.now() + 60_000).toISOString(),
    });
    const ready = await f.read();
    expect((ready.body as any).data.expiresAt).toBe('2026-11-06T08:00:10.000Z');
    f.advance(10_000);
    expect((await f.read()).body).toMatchObject({ data: { state: 'WAITING_FRAME' } });
  });
  test('snapshot port is used instead of independent CONTROL/FRAME reads', async () => {
    const f = await active();
    f.store.readControl = async () => {
      throw new Error('non-transactional read forbidden');
    };
    expect((await f.read()).body).toMatchObject({ data: { state: 'READY' } });
    expect(f.store.latestReads).toBe(1);
  });
});

describe('IMG-07 viewer admission and authority', () => {
  test('missing CONTROL or viewer lease returns LIVE_VIEWER_EXPIRED', async () => {
    const f = await active();
    const absent = await f.readLatest({ ...request(randomUUID()), query: { viewerId: randomUUID() } });
    expect(absent.status).toBe(409);
    expect(absent.body).toMatchObject({ error: { code: 'LIVE_VIEWER_EXPIRED' } });
    assertResponse(absent);
    expectNoImage(absent);
    f.store.controls.clear();
    expect((await f.read()).status).toBe(409);
  });
  test('one expired page cannot borrow another page lease', async () => {
    const f = await active();
    f.advance(20_000);
    const bobId = randomUUID();
    await f.service.renewViewer(actor('bob'), 'device-1', bobId);
    f.advance(9000);
    await f.frames.uploadFrame(cert, {
      ...f.payload,
      frameId: randomUUID(),
      capturedAt: new Date(f.now()).toISOString(),
    });
    f.advance(1000);
    const expired = await f.read();
    expect(expired.status).toBe(409);
    expectNoImage(expired);
    expect((await f.readLatest({ ...request(bobId, actor('bob')), query: { viewerId: bobId } })).body).toMatchObject({
      data: { state: 'READY' },
    });
  });
  test('viewerId is owned by actor as well as device', async () => {
    const f = await active();
    const stolen = await f.readLatest({ ...request(f.viewerId, actor('bob')), query: { viewerId: f.viewerId } });
    expect(stolen.status).toBe(409);
    expectNoImage(stolen);
    await f.service.renewViewer(actor('bob'), 'device-1', f.viewerId);
    expect(
      (await f.readLatest({ ...request(f.viewerId, actor('bob')), query: { viewerId: f.viewerId } })).body,
    ).toMatchObject({ data: { state: 'READY' } });
  });
  test('current permissions override stale request roles before reading storage', async () => {
    const f = await active();
    f.authorization.actors.set('alice', { ...actor(), roles: [] });
    const response = await f.read(f.payload.frameId);
    expect(response.status).toBe(403);
    assertResponse(response);
    expectNoImage(response);
    expect(f.store.latestReads).toBe(0);
  });
  test('cross-customer scope is not replaced by query input', async () => {
    const f = await active();
    f.authorization.actors.set('bob', actor('bob', 'customer-B'));
    const response = await f.readLatest({
      ...request(f.viewerId, actor('bob')),
      query: { viewerId: f.viewerId, customerId: 'customer-A' },
    });
    expect(response.status).toBe(404);
    expectNoImage(response);
    expect(f.store.latestReads).toBe(0);
  });
  test('an authorized platform viewer still needs their own valid lease', async () => {
    const f = await active();
    const admin: ActorContext = {
      ...actor('admin'),
      actorType: 'platform',
      customerId: null,
      roles: ['PlatformSuperAdmin'],
    };
    f.authorization.actors.set('admin', admin);
    expect((await f.readLatest({ ...request(f.viewerId, admin), query: { viewerId: f.viewerId } })).status).toBe(409);
    const id = randomUUID();
    await f.service.renewViewer(admin, 'device-1', id);
    expect((await f.readLatest({ ...request(id, admin), query: { viewerId: id } })).body).toMatchObject({
      data: { state: 'READY' },
    });
  });
  for (const change of [
    { featureEnabled: false },
    { lifecycleStatus: 'Suspended' },
    { lifecycleStatus: 'Retired' },
    { operationalStatus: 'Suspended' },
    { customerId: null },
  ]) {
    test(`current device admission rejects ${JSON.stringify(change)}`, async () => {
      const f = await active();
      f.authorization.scope = { ...f.authorization.scope, ...change };
      const response = await f.read();
      expect(response.status).toBe(change.customerId === null ? 404 : 403);
      expectNoImage(response);
      expect(f.store.latestReads).toBe(0);
    });
  }
  for (const change of [{ enabled: false }, { customerId: 'customer-B' }, { deviceId: 'device-2' }]) {
    test(`stored CONTROL mismatch denies ${JSON.stringify(change)}`, async () => {
      const f = await active();
      f.store.controls.set('device-1', { ...f.store.controls.get('device-1')!, ...change });
      const response = await f.read();
      expect(response.status).toBe(403);
      expectNoImage(response);
    });
  }
  test('invalid request fields, missing actor and disallowed body are rejected', async () => {
    const f = await active();
    for (const query of [
      {},
      { viewerId: 'invalid' },
      { viewerId: f.viewerId, knownFrameId: '' },
      { viewerId: f.viewerId, knownFrameId: 'invalid' },
      { viewerId: [f.viewerId] },
    ]) {
      expect((await f.readLatest({ ...request(f.viewerId), query: query as any })).status).toBe(400);
    }
    const { actor: _actor, ...anonymous } = request(f.viewerId);
    expect((await f.readLatest({ ...anonymous, query: { viewerId: f.viewerId } })).status).toBe(401);
    expect((await f.readLatest({ ...request(f.viewerId), body: {}, query: { viewerId: f.viewerId } })).status).toBe(
      400,
    );
    expect((await f.readLatest({ ...request(f.viewerId), params: {}, query: { viewerId: f.viewerId } })).status).toBe(
      400,
    );
    expect(f.store.latestReads).toBe(0);
  });
  test('unknown device and revoked identity fail before storage', async () => {
    const f = await active();
    expect(
      (await f.readLatest({ ...request(f.viewerId), params: { deviceId: 'unknown' }, query: { viewerId: f.viewerId } }))
        .status,
    ).toBe(404);
    f.authorization.actors.delete('alice');
    expect((await f.read()).status).toBe(401);
    expect(f.store.latestReads).toBe(0);
  });
  test('snapshot failure produces a sanitized 503 and no previous-frame fallback', async () => {
    const f = await active();
    await f.read();
    f.store.beforeLatestSnapshot = async () => {
      throw new Error('SQL secret arn:aws:internal');
    };
    const failed = await f.read();
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('secret');
    assertResponse(failed);
    expectNoImage(failed);
  });
});

describe('IMG-07 transactional snapshot races', () => {
  test('publication before the snapshot returns the new frame with its own CONTROL', async () => {
    const f = await active();
    const entered = deferred();
    const resume = deferred();
    f.store.beforeLatestSnapshot = async () => {
      entered.resolve();
      await resume.promise;
    };
    const reading = f.read();
    await entered.promise;
    f.advance(1000);
    const next = { ...f.payload, frameId: randomUUID(), capturedAt: new Date(f.now()).toISOString() };
    await f.frames.uploadFrame(cert, next);
    resume.resolve();
    expect((await reading).body).toMatchObject({
      data: { state: 'READY', frameId: next.frameId, capturedAt: next.capturedAt },
    });
  });
  test('publication after a snapshot cannot mix a new FRAME with an old CONTROL', async () => {
    const f = await active();
    const entered = deferred();
    const resume = deferred();
    f.store.afterLatestSnapshot = async () => {
      entered.resolve();
      await resume.promise;
    };
    const reading = f.read();
    await entered.promise;
    f.advance(1000);
    const next = { ...f.payload, frameId: randomUUID(), capturedAt: new Date(f.now()).toISOString() };
    await f.frames.uploadFrame(cert, next);
    resume.resolve();
    expect((await reading).body).toMatchObject({ data: { state: 'READY', frameId: f.payload.frameId } });
    expect((await f.read()).body).toMatchObject({ data: { state: 'READY', frameId: next.frameId } });
  });
  test('release before snapshot denies the read even though physical FRAME remains', async () => {
    const f = await active();
    const entered = deferred();
    const resume = deferred();
    f.store.beforeLatestSnapshot = async () => {
      entered.resolve();
      await resume.promise;
    };
    const reading = f.read();
    await entered.promise;
    await f.service.releaseViewer(actor(), 'device-1', f.viewerId);
    resume.resolve();
    const response = await reading;
    expect(response.status).toBe(409);
    expectNoImage(response);
    expect(f.store.frames.size).toBe(1);
  });
  test('a read serialized before release may finish; all subsequent reads reject the released page', async () => {
    const f = await active();
    const entered = deferred();
    const resume = deferred();
    f.store.afterLatestSnapshot = async () => {
      entered.resolve();
      await resume.promise;
    };
    const reading = f.read();
    await entered.promise;
    await f.service.releaseViewer(actor(), 'device-1', f.viewerId);
    resume.resolve();
    expect((await reading).body).toMatchObject({ data: { state: 'READY' } });
    expect((await f.read()).status).toBe(409);
  });
  test('frame or viewer expiring during snapshot I/O is checked using the completion clock', async () => {
    const f = await active();
    f.store.afterLatestSnapshot = async () => {
      f.advance(10_000);
    };
    expect((await f.read(f.payload.frameId)).body).toMatchObject({ data: { state: 'WAITING_FRAME' } });
    const g = await active();
    g.store.afterLatestSnapshot = async () => {
      g.advance(30_000);
    };
    expect((await g.read()).status).toBe(409);
  });
  test('revocation waits for the active read, then denies later reads despite valid cached frame', async () => {
    const f = await active();
    const entered = deferred();
    const resume = deferred();
    f.store.afterLatestSnapshot = async () => {
      entered.resolve();
      await resume.promise;
    };
    const reading = f.read();
    await entered.promise;
    let done = false;
    const revoking = f.service
      .fenceAuthorization('device-1', 'invalidate', async () => {
        f.authorization.actors.set('alice', { ...actor(), roles: [] });
      })
      .then(() => {
        done = true;
      });
    await Promise.resolve();
    expect(done).toBe(false);
    resume.resolve();
    expect((await reading).body).toMatchObject({ data: { state: 'READY' } });
    await revoking;
    const denied = await f.read();
    expect(denied.status).toBe(403);
    expectNoImage(denied);
  });
  test('a read queued behind revocation refreshes authority before looking up the frame', async () => {
    const f = await active();
    const entered = deferred();
    const resume = deferred();
    const revoking = f.service.fenceAuthorization('device-1', 'invalidate', async () => {
      entered.resolve();
      await resume.promise;
      f.authorization.actors.delete('alice');
    });
    await entered.promise;
    let finished = false;
    const reading = f.read().then((response) => {
      finished = true;
      return response;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    resume.resolve();
    await revoking;
    const denied = await reading;
    expect(denied.status).toBe(401);
    expectNoImage(denied);
    expect(f.store.latestReads).toBe(0);
  });
  test('tenant and epoch changes discard old images and old viewer leases on reopening', async () => {
    const f = await active();
    await f.read();
    await f.service.fenceAuthorization('device-1', 'invalidate', async () => {
      f.authorization.scope = { ...f.authorization.scope, customerId: 'customer-B' };
      f.authorization.actors.set('alice', actor('alice', 'customer-B'));
    });
    await f.service.fenceAuthorization('device-1', 'reset');
    expect((await f.read()).status).toBe(409);
    const lease = await f.service.renewViewer(actor(), 'device-1', f.viewerId);
    const waiting = await f.read(f.payload.frameId);
    expect(waiting.body).toMatchObject({ data: { state: 'WAITING_FRAME', streamId: lease.streamId } });
    expectNoImage(waiting);
    f.advance(1000);
    const next = {
      ...f.payload,
      streamId: lease.streamId,
      frameId: randomUUID(),
      capturedAt: new Date(f.now()).toISOString(),
    };
    await f.frames.uploadFrame(cert, next);
    expect((await f.read()).body).toMatchObject({
      data: { state: 'READY', frameId: next.frameId, streamId: lease.streamId },
    });
  });
});

test('non-finite stored lease deadlines cannot authorize image access', async () => {
  for (const deadline of [NaN, Infinity, -Infinity]) {
    const f = await active();
    const control = f.store.controls.get('device-1')!;
    f.store.controls.set('device-1', {
      ...control,
      viewers: control.viewers.map((lease) => ({ ...lease, expiresAtMs: deadline })),
    });
    const response = await f.read();
    expect(response.status).toBe(409);
    expectNoImage(response);
  }
});
