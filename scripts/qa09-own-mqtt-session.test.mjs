import test from 'node:test';
import assert from 'node:assert/strict';
import { withFreshOwnMqttSession } from './qa09-own-mqtt-session.mjs';
test('reopens own TLS session after same-clientId negative probe and closes on failure', async () => {
  const prefix = 'qa09-1234567890abcdef';
  const devices = Array.from({ length: 10 }, (_, i) => prefix + '-' + String(i + 1).padStart(2, '0'));
  let closed = false,
    connected = false;
  const ctx = {
    receipt: {
      prefix,
      devices,
      customers: [
        { id: '11111111-1111-1111-1111-111111111111', name: prefix + '-a', suffix: 'a' },
        { id: '22222222-2222-2222-2222-222222222222', name: prefix + '-b', suffix: 'b' },
      ],
    },
    held: new Map([
      [devices[0], { cert: 'test-cert', key: 'test-key', endpoint: 'example.invalid', client: { connected: false } }],
    ]),
  };
  await assert.rejects(
    withFreshOwnMqttSession(
      ctx,
      async () => {
        assert.equal(connected, true);
        throw Error('PUBLISH_FAILED');
      },
      async (url, options) => {
        connected = true;
        assert.equal(options.clientId, devices[0]);
        assert.equal(options.rejectUnauthorized, true);
        return {
          on() {},
          async endAsync(force) {
            assert.equal(force, true);
            closed = true;
          },
        };
      },
    ),
    /PUBLISH_FAILED/,
  );
  assert.equal(closed, true);
});
test('foreign MQTT scope is rejected before connection', async () => {
  let calls = 0;
  await assert.rejects(
    withFreshOwnMqttSession(
      { receipt: { prefix: 'foreign' } },
      () => {},
      () => {
        calls++;
      },
    ),
  );
  assert.equal(calls, 0);
});
