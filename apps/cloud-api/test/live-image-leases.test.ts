import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createAjv, deviceContract } from '../../../contracts/testing/device-contract.js';
import { LiveImageLeaseService } from '../src/live-image/index.js';
import { actor, cert, deferred, fixture, request } from './live-image-fixtures.js';

describe('IMG-05 leases through service and handler entry points', () => {
  test('empty device state is IDLE and does not create CONTROL', async () => {
    const f = fixture();
    expect(await f.service.getDeviceState(cert)).toEqual({ state: 'IDLE', pollIntervalMs: 5000 });
    expect(f.store.writes).toBe(0);
  });
  test('renewal preserves stream and extends owned lease; ACTIVE uses the last viewer deadline', async () => {
    const f = fixture();
    const viewer = randomUUID();
    const first = await f.service.renewViewer(actor(), 'device-1', viewer);
    f.advance(10_000);
    const renewed = await f.service.renewViewer(actor(), 'device-1', viewer);
    expect(renewed.streamId).toBe(first.streamId);
    expect(Date.parse(renewed.leaseExpiresAt) - Date.parse(first.leaseExpiresAt)).toBe(10_000);
    expect(f.store.controls.get('device-1')!.viewers).toHaveLength(1);
    expect(await f.service.getDeviceState(cert)).toMatchObject({
      state: 'ACTIVE',
      activeUntil: renewed.leaseExpiresAt,
    });
  });
  test('two service instances racing first acquisition share one stream and preserve both leases', async () => {
    const f = fixture();
    const other = new LiveImageLeaseService(f.deps);
    const [a, b] = await Promise.all([
      f.service.renewViewer(actor(), 'device-1', randomUUID()),
      other.renewViewer(actor('bob'), 'device-1', randomUUID()),
    ]);
    expect(a.streamId).toBe(b.streamId);
    expect(f.store.controls.get('device-1')!.viewers).toHaveLength(2);
    expect(f.authorization.reads).toBeGreaterThan(2);
  });
  test('same owner concurrent retry creates only one lease', async () => {
    const f = fixture();
    const viewer = randomUUID();
    const [a, b] = await Promise.all([
      f.service.renewViewer(actor(), 'device-1', viewer),
      f.service.renewViewer(actor(), 'device-1', viewer),
    ]);
    expect(a.streamId).toBe(b.streamId);
    expect(f.store.controls.get('device-1')!.viewers).toHaveLength(1);
  });
  test('owners can reuse a viewer UUID without releasing another user lease', async () => {
    const f = fixture();
    const viewer = randomUUID();
    await f.service.renewViewer(actor(), 'device-1', viewer);
    await f.service.renewViewer(actor('bob'), 'device-1', viewer);
    await f.service.releaseViewer(actor(), 'device-1', viewer);
    expect(f.store.controls.get('device-1')!.viewers.map((lease) => lease.actorId)).toEqual(['bob']);
  });
  test('last release is idempotent and next acquisition gets a fresh stream', async () => {
    const f = fixture();
    const viewer = randomUUID();
    const old = await f.service.renewViewer(actor(), 'device-1', viewer);
    await f.service.releaseViewer(actor(), 'device-1', viewer);
    await f.service.releaseViewer(actor(), 'device-1', viewer);
    expect(await f.service.getDeviceState(cert)).toMatchObject({ state: 'IDLE' });
    expect((await f.service.renewViewer(actor(), 'device-1', viewer)).streamId).not.toBe(old.streamId);
  });
  test('logical expiry works without TTL deletion and old frame watermarks reset on reopening', async () => {
    const f = fixture();
    const viewer = randomUUID();
    const old = await f.service.renewViewer(actor(), 'device-1', viewer);
    const control = f.store.controls.get('device-1')!;
    f.store.controls.set('device-1', { ...control, latestCapturedAtMs: 123, lastNewFrameAtMs: 123 });
    f.advance(30_000);
    expect(await f.service.getDeviceState(cert)).toMatchObject({ state: 'IDLE' });
    expect(f.store.controls.get('device-1')!.viewers).toHaveLength(1);
    expect((await f.service.renewViewer(actor(), 'device-1', viewer)).streamId).not.toBe(old.streamId);
    expect(f.store.controls.get('device-1')!.latestCapturedAtMs).toBeNull();
  });
  test('16 viewer limit rejects new leases but permits renewals and expired-slot reuse', async () => {
    const f = fixture();
    const viewerIds = Array.from({ length: 16 }, () => randomUUID());
    for (const id of viewerIds) await f.service.renewViewer(actor(), 'device-1', id);
    const response = await f.handlers.renewViewer(request(randomUUID()));
    expect(response.status).toBe(429);
    expect(response.headers['Retry-After']).toBe('1');
    await f.service.renewViewer(actor(), 'device-1', viewerIds[0]!);
    f.advance(30_000);
    await f.service.renewViewer(actor(), 'device-1', randomUUID());
    expect(f.store.controls.get('device-1')!.viewers).toHaveLength(1);
  });
  test('release racing another acquisition never loses the surviving viewer', async () => {
    const f = fixture();
    const first = randomUUID();
    await f.service.renewViewer(actor(), 'device-1', first);
    const next = randomUUID();
    await Promise.all([
      f.service.releaseViewer(actor(), 'device-1', first),
      f.service.renewViewer(actor('bob'), 'device-1', next),
    ]);
    expect(f.store.controls.get('device-1')!.viewers).toMatchObject([{ actorId: 'bob', viewerId: next }]);
  });
  test('CAS exhaustion fails closed with 503; subsequent request can recover', async () => {
    const f = fixture();
    f.store.conflicts = 5;
    const failed = await f.handlers.renewViewer(request(randomUUID()));
    expect(failed.status).toBe(503);
    expect(f.authorization.reads).toBe(5);
    expect(f.store.controls.size).toBe(0);
    expect((await f.handlers.renewViewer(request(randomUUID()))).status).toBe(200);
  });
  test('handler responses validate against published schemas', async () => {
    const f = fixture();
    const viewer = randomUUID();
    const renewed = await f.handlers.renewViewer(request(viewer));
    const api = JSON.parse(
      readFileSync(new URL('../../../contracts/rest/openapi.bundle.json', import.meta.url), 'utf8'),
    );
    api.$id = 'https://image-tests.local/api';
    const ajv = createAjv();
    ajv.addSchema(api);
    const schema =
      api.paths['/api/v1/admin/devices/{deviceId}/live-image/viewers/{viewerId}'].put.responses['200'].content[
        'application/json'
      ].schema;
    const validate = ajv.compile({ $ref: api.$id + schema.$ref });
    expect(validate(renewed.body), JSON.stringify(validate.errors)).toBe(true);
    expect(renewed.headers['Cache-Control']).toBe('no-store');
    const active = await f.handlers.getDeviceState({ identity: cert, requestId: 'state' });
    deviceContract.assertResponse('getDeviceLiveImageState', active);
    const released = await f.handlers.releaseViewer(request(viewer));
    expect(released.status).toBe(204);
    expect(released.body).toBeUndefined();
    deviceContract.assertResponse(
      'getDeviceLiveImageState',
      await f.handlers.getDeviceState({ identity: cert, requestId: 'idle' }),
    );
  });
});

describe('mandatory authorization guard and fencing', () => {
  test('fresh roles override stale actor roles, including after CAS conflict', async () => {
    const f = fixture();
    f.store.conflicts = 1;
    f.authorization.afterRead = async () => {
      await f.authorization.withExclusive('device-1', async () => {
        f.authorization.actors.set('alice', { ...actor(), roles: [] });
      });
    };
    expect((await f.handlers.renewViewer(request(randomUUID()))).status).toBe(403);
    expect(f.store.writes).toBe(0);
    expect(f.authorization.reads).toBe(2);
  });
  test('cross-tenant viewer cannot renew or release another customer lease', async () => {
    const f = fixture();
    const viewer = randomUUID();
    await f.service.renewViewer(actor(), 'device-1', viewer);
    f.authorization.actors.set('bob', actor('bob', 'customer-B'));
    expect((await f.handlers.releaseViewer(request(viewer, actor('bob')))).status).toBe(404);
    expect((await f.handlers.renewViewer(request(viewer, actor('bob')))).status).toBe(404);
    expect(f.store.controls.get('device-1')!.viewers).toHaveLength(1);
  });
  for (const change of [
    { customerId: null },
    { lifecycleStatus: 'Suspended' },
    { lifecycleStatus: 'Retired' },
    { operationalStatus: 'Suspended' },
    { operationalStatus: null },
  ]) {
    test(`current device admission rejects ${JSON.stringify(change)}`, async () => {
      const f = fixture();
      f.authorization.scope = { ...f.authorization.scope, ...change };
      expect((await f.handlers.renewViewer(request(randomUUID()))).status).toBe(change.customerId === null ? 404 : 403);
      expect((await f.handlers.getDeviceState({ identity: cert, requestId: 'state' })).status).toBe(403);
      expect(f.store.writes).toBe(0);
    });
  }
  test('certificate revocation and missing identities fail authentication', async () => {
    const f = fixture();
    f.authorization.certificateActive = false;
    expect((await f.handlers.getDeviceState({ identity: cert, requestId: 'state' })).status).toBe(401);
    expect((await f.handlers.getDeviceState({ requestId: 'state' })).status).toBe(401);
    const req = request(randomUUID());
    const { actor: _actor, ...anonymous } = req;
    expect((await f.handlers.renewViewer(anonymous)).status).toBe(401);
  });
  test('invalidation waits for an in-flight shared reader, then fences the completed lease', async () => {
    const f = fixture();
    const entered = deferred();
    const proceed = deferred();
    f.store.beforeCas = async () => {
      entered.resolve();
      await proceed.promise;
    };
    const renewing = f.service.renewViewer(actor(), 'device-1', randomUUID());
    await entered.promise;
    let done = false;
    const revoking = f.service.fenceAuthorization('device-1').then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    proceed.resolve();
    await renewing;
    await revoking;
    const control = f.store.controls.get('device-1')!;
    expect(control.enabled).toBe(false);
    expect(control.viewers).toHaveLength(0);
    expect(control.authEpoch).toBe(2);
    expect((await f.handlers.getDeviceState({ identity: cert, requestId: 'state' })).body).toMatchObject({
      data: { state: 'IDLE' },
    });
  });
  test('tenant switch after fencing starts a new epoch and stream without an enable step', async () => {
    const f = fixture();
    const viewer = randomUUID();
    const old = await f.service.renewViewer(actor(), 'device-1', viewer);
    await f.service.fenceAuthorization('device-1');
    await f.authorization.withExclusive('device-1', async () => {
      f.authorization.scope = { ...f.authorization.scope, customerId: 'customer-B' };
      f.authorization.actors.set('alice', actor('alice', 'customer-B'));
    });
    const next = await f.service.renewViewer(actor(), 'device-1', viewer);
    expect(next.streamId).not.toBe(old.streamId);
    expect(f.store.controls.get('device-1')).toMatchObject({ customerId: 'customer-B', authEpoch: 3 });
  });
  test('tenant change without fencing also fails closed on stored scope mismatch', async () => {
    const f = fixture();
    await f.service.renewViewer(actor(), 'device-1', randomUUID());
    f.authorization.scope = { ...f.authorization.scope, customerId: 'customer-B' };
    f.authorization.actors.set('alice', actor('alice', 'customer-B'));
    expect((await f.handlers.renewViewer(request(randomUUID()))).status).toBe(403);
    expect((await f.handlers.getDeviceState({ identity: cert, requestId: 'state' })).status).toBe(403);
  });
  test('unknown store/guard failures are sanitized, without process-local fallback', async () => {
    const f = fixture();
    f.store.beforeCas = async () => {
      throw new Error('SQL secret arn:aws:internal');
    };
    const failed = await f.handlers.renewViewer(request(randomUUID()));
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('secret');
    expect(f.store.controls.size).toBe(0);
  });
  test('strict path/body checks reject malformed viewer input and device-state body', async () => {
    const f = fixture();
    expect((await f.handlers.renewViewer(request('invalid'))).status).toBe(400);
    expect((await f.handlers.renewViewer({ ...request(randomUUID()), body: { customerId: 'spoof' } })).status).toBe(
      400,
    );
    expect((await f.handlers.getDeviceState({ identity: cert, requestId: 'state', body: {} })).status).toBe(400);
    expect(f.store.writes).toBe(0);
  });
});

test('viewer UUID spelling is canonicalized consistently for renew and release', async () => {
  const f = fixture();
  const id = randomUUID();
  const first = await f.service.renewViewer(actor(), 'device-1', id);
  const renewed = await f.service.renewViewer(actor(), 'device-1', id.toUpperCase());
  expect(renewed.streamId).toBe(first.streamId);
  expect(f.store.controls.get('device-1')!.viewers).toHaveLength(1);
  await f.service.releaseViewer(actor(), 'device-1', id.toUpperCase());
  expect(await f.service.getDeviceState(cert)).toMatchObject({ state: 'IDLE' });
});

test('failed authority mutation leaves the old stream closed and a fresh lease can recover', async () => {
  const f = fixture();
  const id = randomUUID();
  const old = await f.service.renewViewer(actor(), 'device-1', id);
  await expect(
    f.service.fenceAuthorization('device-1', async () => {
      expect(f.store.controls.get('device-1')!.enabled).toBe(false);
      throw new Error('authority transaction rolled back');
    }),
  ).rejects.toThrow('authority transaction rolled back');
  expect(await f.service.getDeviceState(cert)).toMatchObject({ state: 'IDLE' });
  await f.service.releaseViewer(actor(), 'device-1', id);
  expect(f.store.controls.get('device-1')!.enabled).toBe(false);
  const next = await f.service.renewViewer(actor(), 'device-1', id);
  expect(next.streamId).not.toBe(old.streamId);
});

test('authorization write callback completes before new reads enter the guard', async () => {
  const f = fixture();
  const entered = deferred();
  const resume = deferred();
  const invalidation = f.service.fenceAuthorization('device-1', async () => {
    entered.resolve();
    await resume.promise;
    f.authorization.certificateActive = false;
  });
  await entered.promise;
  let finished = false;
  const query = f.handlers.getDeviceState({ identity: cert, requestId: 'state' }).then((response) => {
    finished = true;
    return response;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  resume.resolve();
  await invalidation;
  expect((await query).status).toBe(401);
});

test('CAS retry uses the new clock and starts a new stream after expiry', async () => {
  const f = fixture();
  const first = await f.service.renewViewer(actor('bob'), 'device-1', randomUUID());
  f.store.conflicts = 1;
  f.authorization.afterRead = async () => {
    f.advance(31_000);
  };
  const second = await f.service.renewViewer(actor(), 'device-1', randomUUID());
  expect(second.streamId).not.toBe(first.streamId);
  expect(second.leaseExpiresAt).toBe('2026-11-06T08:01:01.000Z');
  expect(f.store.controls.get('device-1')!.viewers).toHaveLength(1);
});

test('two acquisitions racing the last available slot respect the device-wide limit', async () => {
  const f = fixture();
  for (let index = 0; index < 15; index++) await f.service.renewViewer(actor(), 'device-1', randomUUID());
  const responses = await Promise.all([
    f.handlers.renewViewer(request(randomUUID())),
    f.handlers.renewViewer(request(randomUUID(), actor('bob'))),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
  expect(f.store.controls.get('device-1')!.viewers).toHaveLength(16);
});

test('an acquisition committing before a racing release survives the stale release retry', async () => {
  const f = fixture();
  const first = randomUUID();
  const next = randomUUID();
  await f.service.renewViewer(actor(), 'device-1', first);
  await Promise.all([
    f.service.renewViewer(actor('bob'), 'device-1', next),
    f.service.releaseViewer(actor(), 'device-1', first),
  ]);
  expect(f.store.controls.get('device-1')!.viewers).toMatchObject([{ actorId: 'bob', viewerId: next }]);
  expect(await f.service.getDeviceState(cert)).toMatchObject({ state: 'ACTIVE' });
});
