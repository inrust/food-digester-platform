import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeMqttConnect, oldMqttDenial } from './qa09-bounded-mqtt-connect.mjs';
const options = { rejectUnauthorized: true, reconnectPeriod: 0 };
function fake(event) {
  const c = new EventEmitter();
  c.end = () => {
    c.ended = true;
  };
  if (event) queueMicrotask(() => c.emit(event));
  return c;
}
test('Close without error settles and closes its owned client instead of leaving top-level await unresolved', async () => {
  let c;
  const r = await observeMqttConnect(() => (c = fake('close')), 'mqtts://test', options, 30);
  assert.equal(r.outcome, 'CLOSED_BEFORE_CONNACK');
  assert.equal(c.ended, true);
  assert.throws(() => oldMqttDenial(r.outcome, 'ACTIVE', true));
  assert.throws(() => oldMqttDenial(r.outcome, 'INACTIVE', false));
  assert.equal(oldMqttDenial(r.outcome, 'INACTIVE', true), 'NO_CONNACK_WITH_INACTIVE_CERT_AND_ADJACENT_VALID_CONTROL');
});
test('Missing all MQTT events reaches a hard deadline and never proves old certificate rejection', async () => {
  const r = await observeMqttConnect(() => fake(), 'mqtts://test', options, 5);
  assert.equal(r.outcome, 'DEADLINE_WITHOUT_CONNECTION_PROOF');
  assert.throws(() => oldMqttDenial(r.outcome, 'INACTIVE', true));
});
test('An actual connect is a positive control and cannot be counted as denied', async () => {
  const r = await observeMqttConnect(() => fake('connect'), 'mqtts://test', options, 30);
  assert.equal(r.outcome, 'CONNECTED');
  assert.throws(() => oldMqttDenial(r.outcome, 'INACTIVE', true));
  r.client.end(true);
  assert.throws(() => observeMqttConnect(() => fake(), 'mqtts://test', { ...options, rejectUnauthorized: false }));
});
