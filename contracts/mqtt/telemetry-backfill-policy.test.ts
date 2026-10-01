import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageTimeWithinWindow, TELEMETRY_BACKFILL_POLICY } from './telemetry-backfill-policy.ts';
const received = Date.parse('2026-10-01T02:00:00Z');
for (const [name, age, allowed] of [
  ['current', 0, true],
  ['past 300s', 300, true],
  ['past 301s', 301, true],
  ['past 24h inclusive', 86400, true],
  ['past 24h plus 1ms', 86400.001, false],
  ['future 300s inclusive', -300, true],
  ['future 300s plus 1ms', -300.001, false],
] as const)
  test(`Telemetry ${name}`, () =>
    assert.equal(messageTimeWithinWindow('telemetry', received - age * 1000, received, 300), allowed));
test('other topics retain symmetric 300-second tolerance', () => {
  for (const topic of ['heartbeat', 'ack', 'report', 'alarm', 'event', 'tamper', 'media']) {
    assert.equal(messageTimeWithinWindow(topic, received - 300000, received, 300), true);
    assert.equal(messageTimeWithinWindow(topic, received - 300001, received, 300), false);
    assert.equal(messageTimeWithinWindow(topic, received + 300001, received, 300), false);
  }
});
test('configured tolerance affects future bound but cannot enlarge Telemetry history', () => {
  assert.equal(messageTimeWithinWindow('telemetry', received - 86400001, received, 100000), false);
  assert.equal(messageTimeWithinWindow('telemetry', received + 60001, received, 60), false);
  assert.equal(TELEMETRY_BACKFILL_POLICY.maxPastAgeSeconds, 86400);
});
test('invalid numeric policy inputs fail closed', () => {
  for (const input of [NaN, Infinity]) assert.equal(messageTimeWithinWindow('telemetry', received, input, 300), false);
  assert.equal(messageTimeWithinWindow('telemetry', received, received, -1), false);
});
