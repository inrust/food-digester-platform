import { readFileSync } from 'node:fs';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { authorize } from './core.mjs';

export class OfflineTransport {
  constructor(deviceId, downlinks = []) {
    Object.assign(this, { deviceId, downlinks: structuredClone(downlinks) });
    this.connected = false;
    this.messages = [];
    this.subscriptions = [];
  }
  onMessage(handler) {
    this.handler = handler;
  }
  async connect() {
    this.connected = true;
  }
  async subscribe(topic) {
    authorize(this.deviceId, topic, 'downlink');
    this.subscriptions.push(topic);
  }
  async publish(topic, payload, options) {
    authorize(this.deviceId, topic, 'uplink');
    if (!this.connected) throw new Error('DISCONNECTED');
    this.messages.push({ topic, payload: JSON.parse(payload), qos: options.qos });
  }
  async drain() {
    for (const { type, payload } of this.downlinks.splice(0))
      await this.handler(`bnx/device/${this.deviceId}/${type}`, payload);
  }
  async close() {
    this.connected = false;
  }
}

// Read credentials only after the explicit test-environment gate. Never return/log PEM values.
export function loadCredentials(config) {
  if (config.mode !== 'mqtts' || config.environment !== 'test' || process.env.FDP_SIMULATOR_TEST_MQTT !== '1')
    throw new Error('TEST_MQTT_GATE_REQUIRED');
  const fingerprints = new Set();
  return config.devices.map((device) => {
    const url = new URL(device.endpoint);
    if (
      url.protocol !== 'mqtts:' ||
      url.username ||
      url.password ||
      !['', '/'].includes(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error('INVALID_MQTTS_ENDPOINT');
    const cert = readFileSync(device.certificatePath);
    const key = readFileSync(device.privateKeyPath);
    const ca = readFileSync(device.caPath);
    const certificate = new X509Certificate(cert);
    const privateKey = createPrivateKey(key);
    if (!certificate.checkPrivateKey(privateKey)) throw new Error('CERTIFICATE_KEY_MISMATCH');
    const identity = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('hex');
    if (fingerprints.has(identity)) throw new Error('SHARED_DEVICE_KEY');
    fingerprints.add(identity);
    return { device, cert, key, ca };
  });
}
export class MqttTransport {
  constructor(credentials, connectAsync) {
    Object.assign(this, { credentials, connectAsync });
    this.work = Promise.resolve();
  }
  onMessage(handler) {
    this.handler = handler;
  }
  async connect() {
    const { device, cert, key, ca } = this.credentials;
    this.client = await this.connectAsync(device.endpoint, {
      clientId: device.deviceId,
      cert,
      key,
      ca,
      rejectUnauthorized: true,
      protocolVersion: 4,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 10000,
    });
    this.client.on('message', (topic, bytes) => {
      this.work = this.work.then(() => this.handler(topic, JSON.parse(bytes.toString())));
      this.work.catch(() => {});
    });
    this.client.on('error', () => {
      this.failure = true;
    });
  }
  async subscribe(topic, options) {
    authorize(this.credentials.device.deviceId, topic, 'downlink');
    const grants = await this.client.subscribeAsync(topic, options);
    if (grants.some((grant) => grant.qos === 128)) throw new Error('SUBSCRIBE_DENIED');
  }
  async publish(topic, payload, options) {
    authorize(this.credentials.device.deviceId, topic, 'uplink');
    if (this.failure || !this.client?.connected) throw new Error('MQTT_DISCONNECTED');
    let timer;
    try {
      await Promise.race([
        this.client.publishAsync(topic, payload, options),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('PUBACK_TIMEOUT')), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async drain() {
    await this.work;
    if (this.failure) throw new Error('MQTT_FAILURE');
  }
  async close() {
    await this.client?.endAsync(true);
  }
}
