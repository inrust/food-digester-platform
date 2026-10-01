import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:tls';
import { createRequire } from 'node:module';
import { connectAsync } from 'mqtt';
import { runSimulation, authorize } from './device-simulator/core.mjs';
import { loadCredentials, MqttTransport } from './device-simulator/transport.mjs';
const require = createRequire(import.meta.resolve('mqtt'));
const { parser, generate } = require('mqtt-packet');

test(
  'local TLS broker: 10 independent certificate sessions, QoS1, downlinks, reconnect and broker ACL rejection',
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa01-mtls-'));
    const previousGate = process.env.FDP_SIMULATOR_TEST_MQTT;
    const sockets = new Set();
    let peakConnections = 0;
    let server;
    const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    try {
      openssl(
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        'ca.key',
        '-out',
        'ca.pem',
        '-subj',
        '/CN=QA01-LOCAL-CA',
        '-days',
        '1',
      );
      writeFileSync(join(dir, 'server.ext'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
      const issue = (name, ext) => {
        openssl(
          'req',
          '-new',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:P-256',
          '-nodes',
          '-keyout',
          `${name}.key`,
          '-out',
          `${name}.csr`,
          '-subj',
          `/CN=${name}`,
        );
        openssl(
          'x509',
          '-req',
          '-in',
          `${name}.csr`,
          '-CA',
          'ca.pem',
          '-CAkey',
          'ca.key',
          '-CAcreateserial',
          '-out',
          `${name}.pem`,
          '-days',
          '1',
          ...(ext ? ['-extfile', ext] : []),
        );
      };
      issue('localhost', 'server.ext');
      const config = JSON.parse(readFileSync(new URL('../docs/dev/fixtures/qa-01-offline.json', import.meta.url)));
      Object.assign(config, { mode: 'mqtts', environment: 'test', rounds: 2, disconnectRound: 1, injectFaults: false });
      delete config.badMessage;
      const received = [];
      const denied = [];
      const sessions = [];
      const downlinkTypes = new Set();
      server = createServer(
        {
          key: readFileSync(join(dir, 'localhost.key')),
          cert: readFileSync(join(dir, 'localhost.pem')),
          ca: readFileSync(join(dir, 'ca.pem')),
          requestCert: true,
          rejectUnauthorized: true,
        },
        (socket) => {
          sockets.add(socket);
          peakConnections = Math.max(peakConnections, sockets.size);
          socket.on('error', () => {});
          socket.on('close', () => sockets.delete(socket));
          const identity = socket.getPeerCertificate().subject.CN;
          const p = parser();
          socket.on('data', (bytes) => p.parse(bytes));
          p.on('error', () => socket.destroy());
          const send = (packet) => socket.write(generate(packet));
          p.on('packet', (packet) => {
            if (packet.cmd === 'connect') {
              if (packet.clientId !== identity) {
                denied.push('client');
                socket.destroy();
                return;
              }
              sessions.push(identity);
              send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
            } else if (packet.cmd === 'subscribe') {
              const granted = packet.subscriptions.map(({ topic }) => {
                try {
                  authorize(identity, topic, 'downlink');
                  return 1;
                } catch {
                  denied.push(topic);
                  return 128;
                }
              });
              send({ cmd: 'suback', messageId: packet.messageId, granted });
              for (const [index, subscription] of packet.subscriptions.entries()) {
                if (granted[index] === 128) continue;
                const type = subscription.topic.split('/').at(-1);
                const downlink = config.downlinks.find((item) => item.type === type);
                downlinkTypes.add(type);
                send({
                  cmd: 'publish',
                  topic: subscription.topic,
                  payload: JSON.stringify(downlink.payload),
                  qos: 0,
                  retain: false,
                  dup: false,
                });
              }
            } else if (packet.cmd === 'publish') {
              try {
                authorize(identity, packet.topic, 'uplink');
              } catch {
                denied.push(packet.topic);
                socket.destroy();
                return;
              }
              received.push({ identity, topic: packet.topic, payload: JSON.parse(packet.payload), qos: packet.qos });
              send({ cmd: 'puback', messageId: packet.messageId });
            } else if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
            else if (packet.cmd === 'disconnect') socket.end();
          });
        },
      );
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, 'localhost', resolve);
      });
      const endpoint = `mqtts://localhost:${server.address().port}`;
      for (const device of config.devices) {
        issue(device.deviceId);
        Object.assign(device, {
          endpoint,
          certificatePath: join(dir, `${device.deviceId}.pem`),
          privateKeyPath: join(dir, `${device.deviceId}.key`),
          caPath: join(dir, 'ca.pem'),
        });
      }
      process.env.FDP_SIMULATOR_TEST_MQTT = '1';
      const credentials = loadCredentials(config);
      const receipt = await runSimulation(
        config,
        (device) =>
          new MqttTransport(
            credentials.find((item) => item.device === device),
            connectAsync,
          ),
      );
      assert.equal(receipt.status, 'PASS');
      assert.equal(new Set(sessions).size, 10);
      assert.equal(sessions.length, 20);
      assert.equal(peakConnections, 10);
      assert.equal(downlinkTypes.size, 3);
      assert.ok(received.every((item) => item.qos === 1 && item.topic.includes(`/${item.identity}/`)));
      for (const device of config.devices) {
        const acks = received.filter((item) => item.identity === device.deviceId && item.topic.endsWith('/ack'));
        assert.ok(acks.some((ack) => ack.payload.data.objectType === 'COMMAND'));
        assert.ok(
          acks.some(
            (ack) => ack.payload.data.objectType === 'OTA_TARGET' && ack.payload.data.otaTargetId === 'target-001',
          ),
        );
      }
      // Bypass simulator guard deliberately to prove this local broker independently denies another device's Topic.
      const { device, cert, key, ca } = credentials[0];
      const probe = await connectAsync(endpoint, { clientId: device.deviceId, cert, key, ca, reconnectPeriod: 0 });
      try {
        await assert.rejects(
          probe.subscribeAsync('bnx/device/QA01-DEV02/cmd', { qos: 1 }),
          (error) => error.packet?.granted[0] === 128,
        );
        const closed = new Promise((resolve) => probe.once('close', resolve));
        probe.publish('bnx/device/QA01-DEV02/telemetry', '{}', { qos: 0 });
        await closed;
        assert.ok(denied.includes('bnx/device/QA01-DEV02/telemetry'));
      } finally {
        await probe.endAsync(true);
      }
      assert.throws(
        () =>
          loadCredentials({
            ...config,
            devices: config.devices.map((d) => ({
              ...d,
              certificatePath: config.devices[0].certificatePath,
              privateKeyPath: config.devices[0].privateKeyPath,
            })),
          }),
        /SHARED_DEVICE_KEY/,
      );
      assert.throws(
        () =>
          loadCredentials({
            ...config,
            devices: [
              { ...config.devices[0], privateKeyPath: config.devices[1].privateKeyPath },
              ...config.devices.slice(1),
            ],
          }),
        /KEY_MISMATCH/,
      );
      assert.throws(
        () =>
          loadCredentials({
            ...config,
            devices: [{ ...config.devices[0], endpoint: 'mqtt://localhost' }, ...config.devices.slice(1)],
          }),
        /INVALID_MQTTS_ENDPOINT/,
      );
      if (process.env.QA01_MTLS_RECEIPT)
        writeFileSync(
          process.env.QA01_MTLS_RECEIPT,
          JSON.stringify(
            {
              task: 'QA-01',
              scope: 'LOCAL_TLS_BROKER',
              status: 'PASS',
              independentCertificates: 10,
              connectedDeviceCount: new Set(sessions).size,
              sessionsIncludingReconnect: sessions.length - 1,
              aclProbeSessions: 1,
              peakConcurrentConnections: peakConnections,
              ownTopicQoS1: true,
              subscribedDownlinks: [...downlinkTypes],
              brokerDeniedCrossDeviceSubscribe: denied.includes('bnx/device/QA01-DEV02/cmd'),
              brokerDeniedCrossDevicePublish: denied.includes('bnx/device/QA01-DEV02/telemetry'),
              sharedKeyRejected: true,
              mismatchedKeyRejected: true,
              awsTargetAcceptance: 'NOT RUN / NO RECEIPT',
            },
            null,
            2,
          ) + '\n',
        );
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      if (previousGate === undefined) delete process.env.FDP_SIMULATOR_TEST_MQTT;
      else process.env.FDP_SIMULATOR_TEST_MQTT = previousGate;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
