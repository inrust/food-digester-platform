import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { contractHandler } from '../../../contracts/testing/device-contract.js';
import { LiveImageLeaseError } from '../src/live-image/index.js';
import { actor, cert, fixture } from './live-image-fixtures.js';

const sample = JSON.parse(
  readFileSync(new URL('../../../contracts/rest/fixtures/device-images/frame-request.json', import.meta.url), 'utf8'),
);
async function setup() {
  const f = fixture();
  const lease = await f.service.renewViewer(actor(), 'device-1', randomUUID());
  return {
    ...f,
    state: contractHandler('getDeviceLiveImageState', f.handlers.getDeviceState),
    uploadFrame: contractHandler('uploadDeviceLiveImageFrame', f.upload),
    request: {
      identity: cert,
      requestId: 'img20-contract',
      headers: { 'Content-Type': 'application/json' },
      body: { ...sample, streamId: lease.streamId, frameId: randomUUID(), capturedAt: new Date(f.now()).toISOString() },
    },
  };
}

test('IMG-20 device preview contracts check real successful, invalid and unauthenticated handler responses', async () => {
  const f = await setup();
  const stateRequest = { identity: cert, requestId: 'img20-state' };
  expect((await f.state(stateRequest)).status).toBe(200);
  expect((await f.state({ ...stateRequest, body: {} })).status).toBe(400);
  expect((await f.state({ requestId: stateRequest.requestId })).status).toBe(401);
  expect((await f.uploadFrame(f.request)).status).toBe(200);
  expect((await f.uploadFrame({ ...f.request, body: {} })).status).toBe(400);
  expect(
    (await f.uploadFrame({ requestId: f.request.requestId, headers: f.request.headers, body: f.request.body })).status,
  ).toBe(401);
  expect((await f.uploadFrame({ ...f.request, headers: { 'Content-Type': 'image/jpeg' } })).status).toBe(415);
  expect(
    (await f.uploadFrame({ ...f.request, body: { ...f.request.body, imageBase64: 'A'.repeat(200000) } })).status,
  ).toBe(413);
});

// Inject faults at the authorization port, never fabricate an HTTP response. Native adapter
// behavior is tested separately; these cases enforce every declared error/status/header mapping.
for (const [code, status] of [
  ['FORBIDDEN', 403],
  ['NOT_FOUND', 404],
  ['LIVE_STREAM_INACTIVE', 409],
  ['RATE_LIMITED', 429],
  ['TEMPORARILY_UNAVAILABLE', 503],
] as const) {
  test(`IMG-20 device preview handlers preserve ${code} under authority faults`, async () => {
    const f = await setup();
    f.authorization.withRead = async () => {
      throw new LiveImageLeaseError(code);
    };
    expect((await f.state({ identity: cert, requestId: 'img20-state' })).status).toBe(status);
    expect((await f.uploadFrame(f.request)).status).toBe(status);
  });
}
