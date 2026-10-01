import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { authorize, runSimulation, schemaErrors, SimulatedDevice, validateConfig } from './device-simulator/core.mjs';
import { loadCredentials, MqttTransport, OfflineTransport } from './device-simulator/transport.mjs';
import { computeAuditHash } from '../contracts/mqtt/payload-normalization.ts';
const fixture = () => JSON.parse(readFileSync(new URL('../docs/dev/fixtures/qa-01-offline.json', import.meta.url)));

test('10 concurrent sessions: all topics, exact 5% duplicates / 2% delayed telemetry, replay and isolated bad Schema', async () => {
  const config = fixture();
  const transports = [];
  const receipt = await runSimulation(config, (device) => {
    const transport = new OfflineTransport(device.deviceId, config.downlinks);
    transports.push(transport);
    return transport;
  });
  assert.equal(receipt.deviceCount, 10);
  const allIds = new Set();
  for (const [index, transport] of transports.entries()) {
    assert.equal(transport.connected, false);
    assert.equal(new Set(transport.subscriptions).size, 3);
    const counts = receipt.devices[index];
    assert.deepEqual(
      [counts.duplicate, counts.reordered, counts.bad, counts.replayed, counts.notifications],
      [5, 2, 1, 1, 1],
    );
    assert.equal(new Set(transport.messages.map((m) => m.topic.split('/').at(-1))).size, 8);
    const seen = new Set();
    let duplicates = 0,
      reordered = 0,
      last = 0,
      invalid = 0;
    for (const { topic, payload, qos } of transport.messages) {
      assert.equal(qos, 1);
      authorize(transport.deviceId, topic, 'uplink');
      const type = topic.split('/').at(-1);
      const errors = schemaErrors(type, payload);
      if (errors.length) {
        invalid++;
        assert.deepEqual(
          errors.map((e) => e.path),
          ['meta.seq'],
        );
        continue;
      }
      if (payload.audit) assert.equal(payload.audit.hash, computeAuditHash(payload));
      if (type === 'telemetry') {
        if (seen.has(payload.meta.id)) {
          duplicates++;
          continue;
        }
        if (payload.meta.seq < last) reordered++;
        last = Math.max(last, payload.meta.seq);
        seen.add(payload.meta.id);
      }
      assert.ok(!allIds.has(payload.meta.id));
      allIds.add(payload.meta.id);
    }
    assert.deepEqual([duplicates, reordered, invalid, seen.size], [5, 2, 1, 100]);
    const acks = transport.messages.filter((m) => m.topic.endsWith('/ack')).map((m) => m.payload.data);
    assert.equal(acks[0].objectType, 'COMMAND');
    assert.equal(acks[0].commandId, config.downlinks[0].payload.meta.id);
    assert.deepEqual(
      acks.slice(1).map((ack) => ack.status),
      config.otaStatuses,
    );
    assert.ok(acks.slice(1).every((ack) => ack.otaTargetId === 'target-001' && !('commandId' in ack)));
  }
});

test('cross-device publish, subscribe, receive and wildcard denied', async () => {
  const transport = new OfflineTransport('QA01-DEV01');
  await transport.connect();
  await assert.rejects(transport.publish('bnx/device/QA01-DEV02/telemetry', '{}', { qos: 1 }), /TOPIC_DENIED/);
  await assert.rejects(transport.subscribe('bnx/device/QA01-DEV02/cmd'), /TOPIC_DENIED/);
  const device = new SimulatedDevice('QA01-DEV01', transport, fixture());
  await assert.rejects(device.receive('bnx/device/QA01-DEV02/cmd', {}), /TOPIC_DENIED/);
  assert.throws(() => authorize('QA01-DEV01', 'bnx/device/QA01-DEV01/+', 'downlink'));
  assert.throws(() => authorize('QA01-DEV01', 'bnx/device/QA01-DEV01/cmd', 'uplink'), /TOPIC_DENIED/);
});

test('invalid configuration, OTA transitions and test credential gate fail closed', () => {
  for (const change of [
    { telemetrySeconds: 9 },
    { telemetrySeconds: 61 },
    { rounds: 0 },
    { mode: 'production' },
    { devices: fixture().devices.slice(0, 9) },
    { otaStatuses: ['SUCCEEDED'] },
    { commandResult: 'OK' },
    { disconnectRound: 100 },
    { badMessage: { round: 101, type: 'telemetry' } },
  ])
    assert.throws(() => validateConfig({ ...fixture(), ...change }));
  assert.throws(
    () => validateConfig({ ...fixture(), devices: Array(10).fill({ deviceId: 'SAME' }) }),
    /DUPLICATE_DEVICE/,
  );
  assert.throws(
    () => loadCredentials({ ...fixture(), mode: 'mqtts', environment: 'production' }),
    /TEST_MQTT_GATE_REQUIRED/,
  );
});

test('scripted failed command, missing target mapping and illegal downlink do not generate mixed ACK', async () => {
  const config = fixture();
  config.commandResult = 'FAILED';
  const transport = new OfflineTransport('QA01-DEV01');
  await transport.connect();
  const device = new SimulatedDevice('QA01-DEV01', transport, config);
  await device.receive('bnx/device/QA01-DEV01/cmd', config.downlinks[0].payload);
  assert.equal(transport.messages[0].payload.data.result, 'FAILED');
  await assert.rejects(
    device.receive('bnx/device/QA01-DEV01/ota', {
      ...config.downlinks[1].payload,
      meta: { ...config.downlinks[1].payload.meta, id: 'OTA-UNKNOWN' },
    }),
    /MAPPING_REQUIRED/,
  );
  await assert.rejects(device.receive('bnx/device/QA01-DEV01/cmd', {}), /INVALID_DOWNLINK/);
});

test('all sessions close when one transport fails; no successful receipt', async () => {
  const transports = [];
  await assert.rejects(
    runSimulation(fixture(), (device) => {
      const transport = new OfflineTransport(device.deviceId);
      transports.push(transport);
      if (transports.length === 1)
        transport.publish = async () => {
          throw new Error('network failed');
        };
      return transport;
    }),
    /SIMULATION_FAILED/,
  );
  assert.ok(transports.every((transport) => !transport.connected));
});

test('MQTT adapter rejects SUBACK denial and connection failures', async () => {
  const transport = new MqttTransport({ device: { deviceId: 'QA01-DEV01' } }, async () => ({
    on() {},
    subscribeAsync: async () => [{ qos: 128 }],
    endAsync: async () => {},
  }));
  await transport.connect();
  await assert.rejects(transport.subscribe('bnx/device/QA01-DEV01/cmd', { qos: 1 }), /SUBSCRIBE_DENIED/);
  await assert.rejects(transport.publish('bnx/device/QA01-DEV01/ack', '{}', { qos: 1 }), /MQTT_DISCONNECTED/);
});

test('CLI creates offline receipt and refuses ungated mqtts before reading credential paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa01-cli-'));
  try {
    const configPath = join(dir, 'config.json');
    const receiptPath = join(dir, 'receipt.json');
    writeFileSync(configPath, JSON.stringify(fixture()));
    const cli = (...args) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-device-simulator.mjs', ...args], {
        encoding: 'utf8',
        env: { ...process.env, FDP_SIMULATOR_TEST_MQTT: '' },
      });
    const successful = cli(configPath, receiptPath);
    assert.equal(successful.status, 0);
    assert.equal(JSON.parse(readFileSync(receiptPath)).deviceCount, 10);
    const config = fixture();
    config.mode = 'mqtts';
    config.environment = 'test';
    for (const device of config.devices)
      Object.assign(device, {
        endpoint: 'mqtts://localhost:8883',
        certificatePath: '/NONEXISTENT-SENSITIVE-CERT',
        privateKeyPath: '/NONEXISTENT-SENSITIVE-KEY',
      });
    writeFileSync(configPath, JSON.stringify(config));
    const denied = cli(configPath, join(dir, 'denied.json'));
    assert.equal(denied.status, 1);
    assert.equal(existsSync(join(dir, 'denied.json')), false);
    assert.ok(!denied.stderr.includes('SENSITIVE'));
    assert.equal(cli().status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
