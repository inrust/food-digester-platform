import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFixtureFrames } from './qa09-db-log-frames.mjs';
test('CloudWatch 250000-character fragments reassemble exact source-bound metadata without accepting truncation or another frame', () => {
  const value = {
    kind: 'fdp-qa09-ten-device-db/v1',
    prefix: 'qa09-1234567890abcdef',
    buildId: 'own-build',
    sourceHash: 'a'.repeat(64),
    records: 'abcdef'.repeat(110000),
  };
  const encoded = JSON.stringify(value) + '\n';
  const events = [
    { message: '[Container] BUILD' },
    ...Array.from({ length: Math.ceil(encoded.length / 250000) }, (_, i) => ({
      message: encoded.slice(i * 250000, (i + 1) * 250000),
    })),
    { message: '[Container] Complete' },
  ];
  assert.deepEqual(decodeFixtureFrames(events), [value]);
  assert.throws(() => decodeFixtureFrames(events.slice(0, -2)), /FIXTURE_FRAME_TRUNCATED/);
  assert.throws(() => decodeFixtureFrames([events[1], events[1]]), /FIXTURE_FRAME_INTERRUPTED/);
  assert.throws(() => decodeFixtureFrames([{ message: encoded + 'x'.repeat(9 * 1024 * 1024) }]), /FIXTURE_LOG_LIMIT/);
  assert.deepEqual(decodeFixtureFrames([{ message: JSON.stringify({ kind: 'other' }) }]), []);
});

test('large fixture observations round-trip through bounded gzip without losing metadata', async () => {
  const { encodeFixtureFrame } = await import('./qa09-ten-device-db.mjs');
  const frame = {
    kind: 'fdp-qa09-ten-device-db/v1',
    prefix: 'qa09-1234567890abcdef',
    sourceHash: 'a'.repeat(64),
    buildId: 'own-build',
    action: 'observe',
    gate: 'PASS',
    records: Array.from({ length: 950 }, (_, i) => ({
      id: i,
      status: 'PUBLISHED',
      payload: 'historical-telemetry'.repeat(40),
    })),
  };
  const encoded = encodeFixtureFrame(frame);
  assert.equal(JSON.parse(encoded).kind, 'fdp-qa09-ten-device-db/gzip-v1');
  assert.ok(encoded.length < JSON.stringify(frame).length / 10);
  assert.deepEqual(decodeFixtureFrames([{ message: encoded.slice(0, 100) }, { message: encoded.slice(100) }]), [frame]);
  assert.equal(JSON.parse(encodeFixtureFrame({ kind: frame.kind, gate: 'PASS' })).kind, frame.kind);
});

test('compressed fixture frames reject corruption, noncanonical data and decompression bombs', async () => {
  const { encodeFixtureFrame } = await import('./qa09-ten-device-db.mjs');
  const { gzipSync } = await import('node:zlib');
  const frame = JSON.parse(encodeFixtureFrame({ kind: 'fdp-qa09-ten-device-db/v1', records: 'x'.repeat(70000) }));
  const decode = (value) => decodeFixtureFrames([{ message: JSON.stringify(value) }]);
  assert.throws(() => decode({ ...frame, sha256: '0'.repeat(64) }), /FIXTURE_FRAME_DIGEST_MISMATCH/);
  assert.throws(() => decode({ ...frame, rawBytes: frame.rawBytes - 1 }), /FIXTURE_FRAME_DIGEST_MISMATCH/);
  assert.throws(() => decode({ ...frame, payloadBase64: frame.payloadBase64 + '!' }), /FIXTURE_FRAME_ENCODING/);
  assert.throws(
    () => decode({ ...frame, rawBytes: 1, payloadBase64: gzipSync(Buffer.alloc(9 * 1024 * 1024)).toString('base64') }),
    /FIXTURE_FRAME_ENCODING/,
  );
  assert.throws(
    () => encodeFixtureFrame({ kind: 'fdp-qa09-ten-device-db/v1', records: 'x'.repeat(9 * 1024 * 1024) }),
    /FIXTURE_FRAME_LIMIT/,
  );
});

test('compressed metadata still requires the exact expected source/build/action binding', async () => {
  const { encodeFixtureFrame } = await import('./qa09-ten-device-db.mjs');
  const { readVerifiedFixtureFrame } = await import('./qa09-db-frame-wait.mjs');
  const frame = {
    kind: 'fdp-qa09-ten-device-db/v1',
    prefix: 'qa09-1234567890abcdef',
    sourceHash: 'b'.repeat(64),
    buildId: 'own-build',
    action: 'observe',
    gate: 'PASS',
    records: 'x'.repeat(70000),
  };
  await assert.rejects(
    () =>
      readVerifiedFixtureFrame(async () => ({ events: [{ message: encodeFixtureFrame(frame) }] }), {
        ...frame,
        sourceHash: 'a'.repeat(64),
      }),
    /FIXTURE_RESULT_NOT_VERIFIED/,
  );
});
