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
