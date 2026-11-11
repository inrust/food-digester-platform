import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encode } from 'jpeg-js';
import { deviceContract } from '../../../contracts/testing/device-contract.js';
import { LiveImageFrameService } from '../src/live-image/index.js';
import { actor, cert, deferred, fixture } from './live-image-fixtures.js';

const sample = JSON.parse(
  readFileSync(new URL('../../../contracts/rest/fixtures/device-images/frame-request.json', import.meta.url), 'utf8'),
);
const image = Buffer.from(sample.imageBase64, 'base64');
async function active() {
  const f = fixture();
  const viewerId = randomUUID();
  const lease = await f.service.renewViewer(actor(), 'device-1', viewerId);
  const payload = {
    ...sample,
    streamId: lease.streamId,
    frameId: randomUUID(),
    capturedAt: new Date(f.now()).toISOString(),
  };
  const send = (body: unknown = payload) =>
    f.upload({ identity: cert, headers: { 'Content-Type': 'application/json' }, requestId: 'frame-test', body });
  return { ...f, viewerId, lease, payload, send };
}
function jpeg(width: number, height: number): string {
  return encode({ width, height, data: Buffer.alloc(width * height * 4, 128) }, 50).data.toString('base64');
}
function paddedImage(size: number): string {
  const parts = [image.subarray(0, 2)];
  let remaining = size - image.length;
  while (remaining > 0) {
    const segmentSize = Math.min(remaining, 65537);
    const segment = Buffer.alloc(segmentSize);
    segment.writeUInt16BE(0xfffe, 0);
    segment.writeUInt16BE(segmentSize - 2, 2);
    parts.push(segment);
    remaining -= segmentSize;
  }
  parts.push(image.subarray(2));
  return Buffer.concat(parts).toString('base64');
}

describe('IMG-06 frame validation and receipt protocol', () => {
  test('publishes CONTROL, FRAME and receipt together with the defined deadlines', async () => {
    const f = await active();
    const response = await f.send(JSON.stringify(f.payload));
    expect(response.status).toBe(200);
    deviceContract.assertResponse('uploadDeviceLiveImageFrame', response);
    expect(response.headers['Cache-Control']).toBe('no-store');
    const frame = f.store.frames.get('device-1')!;
    expect(frame).toMatchObject({
      customerId: 'customer-A',
      authEpoch: 1,
      streamId: f.lease.streamId,
      receivedAt: '2026-11-06T08:00:00.000Z',
      expiresAt: '2026-11-06T08:00:10.000Z',
      imageBase64: sample.imageBase64,
    });
    expect(f.store.controls.get('device-1')).toMatchObject({
      revision: 2,
      latestCapturedAtMs: f.now(),
      lastNewFrameAtMs: f.now(),
    });
    expect([...f.store.receipts.values()][0]).toMatchObject({ dedupUntilMs: f.now() + 15_000 });
  });
  test('same body and reordered JSON fields replay without writes or deadline renewal', async () => {
    const f = await active();
    const first = await f.send();
    const writes = f.store.frameWrites;
    f.advance(12_000);
    const reordered = Object.fromEntries(Object.entries(f.payload).reverse());
    const replay = await f.send(JSON.stringify(reordered));
    expect(replay.body).toMatchObject({ data: { ...(first.body as any).data, replayed: true } });
    expect(f.store.frameWrites).toBe(writes);
    expect(f.store.frames.get('device-1')!.expiresAt).toBe('2026-11-06T08:00:10.000Z');
  });
  test('same ID with changed content conflicts before applying another image', async () => {
    const f = await active();
    await f.send();
    f.advance(1000);
    const response = await f.send({ ...f.payload, capturedAt: new Date(f.now()).toISOString() });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'FRAME_CONFLICT' } });
    expect(f.store.frameWrites).toBe(1);
  });
  test('expired dedup entries cannot replay an expired frame even if physically retained', async () => {
    const f = await active();
    await f.send();
    f.advance(15_000);
    const response = await f.send();
    expect(response.body).toMatchObject({ error: { code: 'STALE_FRAME' } });
    expect(f.store.receipts.size).toBe(1);
    expect(f.store.frameWrites).toBe(1);
  });
  test('enforces the one-second new-frame interval, while exact retries bypass it', async () => {
    const f = await active();
    await f.send();
    expect((await f.send()).body).toMatchObject({ data: { replayed: true } });
    f.advance(999);
    const second = { ...f.payload, frameId: randomUUID(), capturedAt: new Date(f.now()).toISOString() };
    const limited = await f.send(second);
    expect(limited.status).toBe(429);
    expect(limited.headers['Retry-After']).toBe('1');
    f.advance(1);
    expect((await f.send(second)).status).toBe(200);
    expect(f.store.frameWrites).toBe(2);
  });
  test('equal/older capture timestamps cannot replace the latest watermark', async () => {
    const f = await active();
    await f.send();
    f.advance(1000);
    for (const offset of [0, -1]) {
      const response = await f.send({
        ...f.payload,
        frameId: randomUUID(),
        capturedAt: new Date(f.now() - 1000 + offset).toISOString(),
      });
      expect(response.body).toMatchObject({ error: { code: 'STALE_FRAME' } });
    }
    expect(f.store.frameWrites).toBe(1);
  });
  test('clock skew and frame lifetime enforce their exact boundaries', async () => {
    const f = await active();
    expect((await f.send({ ...f.payload, capturedAt: new Date(f.now() + 2001).toISOString() })).status).toBe(400);
    expect((await f.send({ ...f.payload, capturedAt: new Date(f.now() - 10_000).toISOString() })).body).toMatchObject({
      error: { code: 'STALE_FRAME' },
    });
    const accepted = await f.send({ ...f.payload, capturedAt: new Date(f.now() + 2000).toISOString() });
    expect(accepted.status).toBe(200);
    expect((accepted.body as any).data.expiresAt).toBe(new Date(f.now() + 10_000).toISOString());
  });
  test('delayed delivery expires at capture plus ten seconds', async () => {
    const f = await active();
    f.advance(9000);
    const response = await f.send();
    expect((response.body as any).data.receivedAt).toBe('2026-11-06T08:00:09.000Z');
    expect((response.body as any).data.expiresAt).toBe('2026-11-06T08:00:10.000Z');
  });
  for (const patch of [
    { imageBase64: '' },
    { imageBase64: 'AB==' },
    { imageBase64: 'AAAA===' },
    { imageBase64: '-_AA' },
    { imageBase64: 'data:image/jpeg;base64,' + sample.imageBase64 },
    { imageBase64: sample.imageBase64 + '\n' },
    { imageBase64: '/9j/2Q==' },
    { mimeType: 'image/png' },
    { frameId: 'invalid' },
    { streamId: 'invalid' },
    { capturedAt: '2026-02-30T08:00:00Z' },
    { capturedAt: '2026-11-06T24:00:00Z' },
    { capturedAt: '2026-11-06T08:00:00+08:00' },
    { capturedAt: 1 },
    { customerId: 'spoof' },
  ]) {
    test(`rejects invalid frame fields ${Object.keys(patch).join(',')} ${String(Object.values(patch)[0]).slice(0, 24)}`, async () => {
      const f = await active();
      expect((await f.send({ ...f.payload, ...patch })).status).toBe(400);
      expect(f.store.frameWrites).toBe(0);
    });
  }
  test('requires all fields and rejects malformed JSON and non-object JSON', async () => {
    const f = await active();
    const { imageBase64: _image, ...missing } = f.payload;
    for (const body of [missing, '{broken', null, [], 'null', '[]', '"text"']) {
      expect((await f.send(body)).status).toBe(400);
    }
    expect(f.store.frameWrites).toBe(0);
  });
  test('rejects a truncated JPEG even with correct SOI and EOI markers', async () => {
    const f = await active();
    const truncated = Buffer.concat([image.subarray(0, 50), Buffer.from([0xff, 0xd9])]);
    expect((await f.send({ ...f.payload, imageBase64: truncated.toString('base64') })).status).toBe(400);
    expect(f.store.frameWrites).toBe(0);
  });
  test('enforces decoded dimensions and pixel budget; accepts the maximum allowed canvas', async () => {
    const f = await active();
    for (const [width, height] of [
      [1921, 1],
      [1, 1921],
      [1920, 1081],
    ]) {
      expect((await f.send({ ...f.payload, imageBase64: jpeg(width!, height!) })).status).toBe(400);
    }
    const accepted = await f.send({ ...f.payload, imageBase64: jpeg(1920, 1080) });
    expect(accepted.status).toBe(200);
  });
  test('accepts 128KiB original JPEG and rejects one extra decoded byte', async () => {
    const f = await active();
    expect((await f.send({ ...f.payload, imageBase64: paddedImage(131073) })).status).toBe(413);
    expect((await f.send({ ...f.payload, imageBase64: paddedImage(131072) })).status).toBe(200);
  });
  test('raw request size counts whitespace and accepts exactly 180KiB', async () => {
    const f = await active();
    const serialized = JSON.stringify(f.payload);
    const maximum = serialized + ' '.repeat(184320 - Buffer.byteLength(serialized));
    expect((await f.send(maximum + ' ')).status).toBe(413);
    expect((await f.send(maximum)).status).toBe(200);
  });
  test('HTTP media type and identity errors match the contract', async () => {
    const f = await active();
    const base = { identity: cert, body: f.payload, requestId: 'content-type' };
    expect((await f.upload({ ...base, headers: {} })).status).toBe(415);
    expect((await f.upload({ ...base, headers: { 'Content-Type': 'image/jpeg' } })).status).toBe(415);
    expect((await f.upload({ ...base, headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status).toBe(
      200,
    );
    expect(
      (await f.upload({ body: f.payload, requestId: 'anonymous', headers: { 'Content-Type': 'application/json' } }))
        .status,
    ).toBe(401);
  });
});

describe('IMG-06 atomic publication and authorization races', () => {
  test('simultaneous exact uploads from two instances publish once and replay once', async () => {
    const f = await active();
    const other = new LiveImageFrameService(f.deps);
    const [a, b] = await Promise.all([f.frames.uploadFrame(cert, f.payload), other.uploadFrame(cert, f.payload)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.receivedAt).toBe(b.receivedAt);
    expect(a.expiresAt).toBe(b.expiresAt);
    expect(f.store.frameWrites).toBe(1);
  });
  test('simultaneous same-ID changed requests publish one conflict-free original', async () => {
    const f = await active();
    const responses = await Promise.all([
      f.send(),
      f.send({ ...f.payload, capturedAt: new Date(f.now() + 1).toISOString() }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)?.body).toMatchObject({
      error: { code: 'FRAME_CONFLICT' },
    });
    expect(f.store.frameWrites).toBe(1);
  });
  test('per-device rate survives simultaneous different-frame uploads', async () => {
    const f = await active();
    const responses = await Promise.all([
      f.send(),
      f.send({ ...f.payload, frameId: randomUUID(), capturedAt: new Date(f.now() + 1).toISOString() }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
    expect(f.store.frameWrites).toBe(1);
  });
  test('a delayed old frame cannot overwrite a newer committed frame', async () => {
    const f = await active();
    const entered = deferred();
    const resume = deferred();
    let first = true;
    f.store.beforeFrameCommit = async () => {
      if (first) {
        first = false;
        entered.resolve();
        await resume.promise;
      }
    };
    const old = f.send();
    await entered.promise;
    f.advance(1000);
    const newer = { ...f.payload, frameId: randomUUID(), capturedAt: new Date(f.now()).toISOString() };
    expect((await f.send(newer)).status).toBe(200);
    resume.resolve();
    expect((await old).body).toMatchObject({ error: { code: 'STALE_FRAME' } });
    expect(f.store.frames.get('device-1')!.frameId).toBe(newer.frameId);
    expect(f.store.frameWrites).toBe(1);
  });
  test('last lease release winning a frame race prevents publication', async () => {
    const f = await active();
    const entered = deferred();
    const resume = deferred();
    f.store.beforeFrameCommit = async () => {
      entered.resolve();
      await resume.promise;
    };
    const uploading = f.send();
    await entered.promise;
    await f.service.releaseViewer(actor(), 'device-1', f.viewerId);
    resume.resolve();
    expect((await uploading).body).toMatchObject({ error: { code: 'LIVE_STREAM_INACTIVE' } });
    expect(f.store.frames.size).toBe(0);
    expect(f.store.receipts.size).toBe(0);
  });
  test('a committed frame is fenced by subsequent last release and new stream', async () => {
    const f = await active();
    await f.send();
    await f.service.releaseViewer(actor(), 'device-1', f.viewerId);
    expect(f.store.controls.get('device-1')!.streamId).toBeNull();
    expect(f.store.frames.get('device-1')!.streamId).toBe(f.payload.streamId);
    const next = await f.service.renewViewer(actor(), 'device-1', randomUUID());
    expect(next.streamId).not.toBe(f.payload.streamId);
    expect((await f.send()).body).toMatchObject({ error: { code: 'LIVE_STREAM_INACTIVE' } });
  });
  test('lease expiry during submission and clock advancement during retry are rechecked', async () => {
    const f = await active();
    f.store.beforeFrameCommit = async () => {
      f.advance(30_000);
    };
    expect((await f.send()).body).toMatchObject({ error: { code: 'LIVE_STREAM_INACTIVE' } });
    expect(f.store.frames.size).toBe(0);
    const g = await active();
    g.store.frameConflicts = 1;
    g.authorization.afterRead = async () => {
      g.advance(10_000);
    };
    expect((await g.send()).body).toMatchObject({ error: { code: 'STALE_FRAME' } });
    expect(g.store.frames.size).toBe(0);
  });
  test('lost acknowledgement recovers through the atomic receipt without another write', async () => {
    const f = await active();
    const commit = f.store.commitFrame.bind(f.store);
    f.store.commitFrame = async (batch) => {
      await commit(batch);
      throw new Error('reply lost');
    };
    expect((await f.send()).status).toBe(503);
    f.store.commitFrame = commit;
    expect((await f.send()).body).toMatchObject({ data: { replayed: true } });
    expect(f.store.frameWrites).toBe(1);
  });
  test('transaction failure before publication leaves all three records unchanged', async () => {
    const f = await active();
    const control = structuredClone(f.store.controls.get('device-1'));
    f.store.beforeFrameCommit = async () => {
      throw new Error('SQL secret arn:aws:internal');
    };
    const failed = await f.send();
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('secret');
    expect(f.store.controls.get('device-1')).toEqual(control);
    expect(f.store.frames.size).toBe(0);
    expect(f.store.receipts.size).toBe(0);
  });
  test('bounded CAS conflicts return 503 and allow a later request to recover', async () => {
    const f = await active();
    f.store.frameConflicts = 5;
    expect((await f.send()).status).toBe(503);
    expect(f.store.frames.size).toBe(0);
    expect((await f.send()).status).toBe(200);
  });
  test('certificate revocation between retries reauthenticates before another commit', async () => {
    const f = await active();
    f.store.frameConflicts = 1;
    f.authorization.afterRead = async () => {
      await f.service.fenceAuthorization('device-1', async () => {
        f.authorization.certificateActive = false;
      });
    };
    expect((await f.send()).status).toBe(401);
    expect(f.store.frames.size).toBe(0);
    expect(f.store.receipts.size).toBe(0);
  });
  test('revocation waits for an in-flight frame then fences new uploads and dedup replays', async () => {
    const f = await active();
    const entered = deferred();
    const resume = deferred();
    f.store.beforeFrameCommit = async () => {
      entered.resolve();
      await resume.promise;
    };
    const uploading = f.send();
    await entered.promise;
    let revoked = false;
    const revoking = f.service.fenceAuthorization('device-1').then(() => {
      revoked = true;
    });
    await Promise.resolve();
    expect(revoked).toBe(false);
    resume.resolve();
    expect((await uploading).status).toBe(200);
    await revoking;
    expect((await f.send()).status).toBe(409);
    expect(f.store.controls.get('device-1')!.authEpoch).toBe(2);
  });
  for (const change of [
    { lifecycleStatus: 'Suspended' },
    { lifecycleStatus: 'Retired' },
    { operationalStatus: 'Suspended' },
    { customerId: null },
  ]) {
    test(`fresh authorization rejects ${JSON.stringify(change)} including duplicate receipts`, async () => {
      const f = await active();
      await f.send();
      f.authorization.scope = { ...f.authorization.scope, ...change };
      expect((await f.send()).status).toBe(403);
      expect(f.store.frameWrites).toBe(1);
    });
  }
  test('new customer cannot use a previous stream or its receipt after fencing', async () => {
    const f = await active();
    await f.send();
    await f.service.fenceAuthorization('device-1', async () => {
      f.authorization.scope = { ...f.authorization.scope, customerId: 'customer-B' };
      f.authorization.actors.set('alice', actor('alice', 'customer-B'));
    });
    const next = await f.service.renewViewer(actor(), 'device-1', randomUUID());
    expect((await f.send()).body).toMatchObject({ error: { code: 'LIVE_STREAM_INACTIVE' } });
    f.advance(1000);
    expect(
      (
        await f.send({
          ...f.payload,
          streamId: next.streamId,
          frameId: randomUUID(),
          capturedAt: new Date(f.now()).toISOString(),
        })
      ).status,
    ).toBe(200);
    expect(f.store.frames.get('device-1')).toMatchObject({ customerId: 'customer-B', authEpoch: 3 });
  });
  test('no lease, expired lease or wrong stream cannot create a frame', async () => {
    const f = await active();
    expect((await f.send({ ...f.payload, streamId: randomUUID() })).status).toBe(409);
    f.advance(30_000);
    expect((await f.send()).body).toMatchObject({ error: { code: 'LIVE_STREAM_INACTIVE' } });
    expect(f.store.frameWrites).toBe(0);
  });
});

test('stream churn and authority fencing cannot bypass the per-device interval', async () => {
  const f = await active();
  await f.send();
  await f.service.releaseViewer(actor(), 'device-1', f.viewerId);
  const next = await f.service.renewViewer(actor(), 'device-1', randomUUID());
  const payload = { ...f.payload, streamId: next.streamId, frameId: randomUUID() };
  expect((await f.send(payload)).status).toBe(429);
  await f.service.fenceAuthorization('device-1');
  const reset = await f.service.renewViewer(actor(), 'device-1', randomUUID());
  expect((await f.send({ ...payload, streamId: reset.streamId })).status).toBe(429);
  f.advance(1000);
  expect(
    (await f.send({ ...payload, streamId: reset.streamId, capturedAt: new Date(f.now()).toISOString() })).status,
  ).toBe(200);
});

test('viewer role revocation fences an in-flight device retry', async () => {
  const f = await active();
  f.store.frameConflicts = 1;
  f.authorization.afterRead = async () => {
    await f.service.fenceAuthorization('device-1', async () => {
      f.authorization.actors.delete('alice');
    });
  };
  expect((await f.send()).status).toBe(409);
  expect(f.store.frameWrites).toBe(0);
});

test('a JPEG header without an entropy scan cannot be accepted as a blank image', async () => {
  const f = await active();
  const sos = image.indexOf(Buffer.from([0xff, 0xda]));
  expect(sos).toBeGreaterThan(0);
  const noScan = Buffer.concat([image.subarray(0, sos), Buffer.from([0xff, 0xd9])]);
  expect((await f.send({ ...f.payload, imageBase64: noScan.toString('base64') })).status).toBe(400);
  const fakeMarkerInComment = Buffer.from([0xff, 0xfe, 0, 6, 0xff, 0xda, 0, 0]);
  const fakeScan = Buffer.concat([noScan.subarray(0, 2), fakeMarkerInComment, noScan.subarray(2)]);
  expect((await f.send({ ...f.payload, imageBase64: fakeScan.toString('base64') })).status).toBe(400);
  expect(f.store.frameWrites).toBe(0);
});

test('replaying an older receipt never replaces the newer current frame or throttle', async () => {
  const f = await active();
  const first = await f.send();
  f.advance(1000);
  const newer = { ...f.payload, frameId: randomUUID(), capturedAt: new Date(f.now()).toISOString() };
  expect((await f.send(newer)).status).toBe(200);
  const control = structuredClone(f.store.controls.get('device-1'));
  const replay = await f.send();
  expect((replay.body as any).data).toEqual({ ...(first.body as any).data, replayed: true });
  expect(f.store.frames.get('device-1')!.frameId).toBe(newer.frameId);
  expect(f.store.controls.get('device-1')).toEqual(control);
  expect(f.store.frameWrites).toBe(2);
});
