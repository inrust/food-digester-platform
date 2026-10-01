import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SchemaRegistry, validate } from '../../contracts/mqtt/validator.mjs';
import { buildTopic, parseTopic, UPLINK_TOPIC_TYPES, DOWNLINK_TOPIC_TYPES } from '../../contracts/mqtt/topics.ts';
import { computeAuditHash } from '../../contracts/mqtt/payload-normalization.ts';

const root = new URL('../../contracts/mqtt/', import.meta.url);
const registry = new SchemaRegistry(fileURLToPath(new URL('schemas/', root)));
const fixture = (type) => JSON.parse(readFileSync(new URL(`fixtures/${type}.fixtures.json`, root))).valid[0];
export function schemaErrors(type, payload) {
  const name = `${type}.schema.json`;
  return validate(registry.load(name).doc, name, payload, registry);
}
export function authorize(deviceId, topic, direction) {
  const parsed = parseTopic(topic);
  if (parsed.deviceId !== deviceId || parsed.direction !== direction) throw new Error('TOPIC_DENIED');
}
export function validateConfig(config) {
  if (!['offline', 'mqtts'].includes(config.mode)) throw new Error('INVALID_MODE');
  if (!Array.isArray(config.devices) || config.devices.length < 10) throw new Error('MINIMUM_10_DEVICES');
  const ids = new Set();
  for (const device of config.devices) {
    buildTopic(device.deviceId, 'heartbeat');
    if (ids.has(device.deviceId)) throw new Error('DUPLICATE_DEVICE');
    ids.add(device.deviceId);
  }
  if (!Number.isInteger(config.rounds) || config.rounds < 1 || config.rounds > 10000) throw new Error('INVALID_ROUNDS');
  if (!Number.isInteger(config.telemetrySeconds) || config.telemetrySeconds < 10 || config.telemetrySeconds > 60)
    throw new Error('INVALID_INTERVAL');
  if (
    config.disconnectRound !== undefined &&
    (!Number.isInteger(config.disconnectRound) || config.disconnectRound < 1 || config.disconnectRound >= config.rounds)
  )
    throw new Error('INVALID_DISCONNECT');
  if (
    config.injectFaults &&
    config.disconnectRound !== undefined &&
    (config.disconnectRound % 20 === 0 || [49, 0].includes(config.disconnectRound % 50))
  )
    throw new Error('FAULT_SCHEDULE_COLLISION');
  if (config.badMessage && config.badMessage.round === config.disconnectRound)
    throw new Error('FAULT_SCHEDULE_COLLISION');
  if (
    config.badMessage &&
    (!UPLINK_TOPIC_TYPES.includes(config.badMessage.type) ||
      !Number.isInteger(config.badMessage.round) ||
      config.badMessage.round < 1 ||
      config.badMessage.round > config.rounds)
  )
    throw new Error('INVALID_BAD_MESSAGE');
  if (config.commandResult && !['SUCCESS', 'FAILED'].includes(config.commandResult))
    throw new Error('INVALID_COMMAND_RESULT');
  const statuses = config.otaStatuses ?? ['DOWNLOADING', 'INSTALLING', 'SUCCEEDED'];
  const transitions = {
    NOTIFIED: ['DOWNLOADING', 'FAILED'],
    DOWNLOADING: ['INSTALLING', 'FAILED'],
    INSTALLING: ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
    SUCCEEDED: ['ROLLED_BACK'],
  };
  let previous = 'NOTIFIED';
  for (const status of statuses) {
    if (!transitions[previous]?.includes(status)) throw new Error('INVALID_OTA_SCRIPT');
    previous = status;
  }
  return config;
}

export class SimulatedDevice {
  constructor(deviceId, transport, config, now = () => new Date()) {
    Object.assign(this, { deviceId, transport, config, now });
    this.runId = randomUUID().slice(0, 8).toUpperCase();
    this.sequences = new Map();
    this.pending = [];
    this.stats = { published: 0, duplicate: 0, reordered: 0, bad: 0, replayed: 0, notifications: 0 };
  }
  payload(type, data) {
    const payload = structuredClone(fixture(type));
    const seq = (this.sequences.get(type) ?? 0) + 1;
    this.sequences.set(type, seq);
    payload.meta = {
      id: `${type.toUpperCase()}-${this.runId}-${seq}`,
      ts: this.now().toISOString(),
      seq,
      schemaVer: '1.0',
    };
    if (data) payload.data = data;
    if (payload.audit) payload.audit.hash = computeAuditHash(payload);
    if (schemaErrors(type, payload).length) throw new Error(`INVALID_GENERATED_${type}`);
    return payload;
  }
  async publish(type, payload) {
    const topic = buildTopic(this.deviceId, type);
    authorize(this.deviceId, topic, 'uplink');
    await this.transport.publish(topic, JSON.stringify(payload), { qos: 1 });
    this.stats.published++;
  }
  async connect() {
    await this.transport.connect();
    for (const type of DOWNLINK_TOPIC_TYPES) {
      const topic = buildTopic(this.deviceId, type);
      authorize(this.deviceId, topic, 'downlink');
      await this.transport.subscribe(topic, { qos: 1 });
    }
  }
  async receive(topic, payload) {
    authorize(this.deviceId, topic, 'downlink');
    const { type } = parseTopic(topic);
    if (schemaErrors(type, payload).length) throw new Error('INVALID_DOWNLINK');
    if (type === 'notification') {
      this.stats.notifications++;
      return;
    }
    if (type === 'cmd') {
      await this.publish(
        'ack',
        this.payload('ack', {
          objectType: 'COMMAND',
          commandId: payload.meta.id,
          command: payload.data.command,
          result: this.config.commandResult ?? 'SUCCESS',
          executeTimeMs: 20,
        }),
      );
    } else {
      const targetId = this.config.otaTargets?.[payload.meta.id];
      if (!targetId) throw new Error('OTA_TARGET_MAPPING_REQUIRED');
      for (const status of this.config.otaStatuses ?? ['DOWNLOADING', 'INSTALLING', 'SUCCEEDED']) {
        await this.publish('ack', this.payload('ack', { objectType: 'OTA_TARGET', otaTargetId: targetId, status }));
      }
    }
  }
  async run(sleep) {
    try {
      await this.connect();
      for (const type of UPLINK_TOPIC_TYPES.filter((type) => type !== 'telemetry' && type !== 'ack'))
        await this.publish(type, this.payload(type));
      for (let round = 1; round <= this.config.rounds; round++) {
        const payload = this.payload('telemetry');
        if (round === this.config.disconnectRound) {
          await this.transport.drain?.();
          await this.transport.close();
          this.pending.push(payload);
        } else {
          if (this.pending.length) {
            await this.connect();
            for (const buffered of this.pending.splice(0)) {
              await this.publish('telemetry', buffered);
              this.stats.replayed++;
            }
          }
          if (this.config.injectFaults && round % 50 === 49 && round < this.config.rounds) {
            this.held = payload;
          } else {
            await this.publish('telemetry', payload);
            if (this.held) {
              await this.publish('telemetry', this.held);
              this.held = undefined;
              this.stats.reordered++;
            }
          }
          if (this.config.injectFaults && round % 20 === 0) {
            await this.publish('telemetry', payload);
            this.stats.duplicate++;
          }
        }
        if (this.config.badMessage?.round === round) {
          const type = this.config.badMessage.type;
          const bad = this.payload(type);
          bad.meta.seq = 'invalid';
          // Deliberately preserve a valid audit hash so the failure isolates Schema validation.
          if (bad.audit) bad.audit.hash = computeAuditHash(bad);
          if (!schemaErrors(type, bad).length) throw new Error('BAD_MESSAGE_NOT_INVALID');
          await this.publish(type, bad);
          this.stats.bad++;
        }
        if (
          round !== this.config.disconnectRound &&
          Math.floor(((round - 1) * this.config.telemetrySeconds) / 60) >
            Math.floor((Math.max(0, round - 2) * this.config.telemetrySeconds) / 60)
        )
          await this.publish('heartbeat', this.payload('heartbeat'));
        if (round < this.config.rounds) await sleep(this.config.telemetrySeconds * 1000);
      }
      await this.transport.drain?.();
      return this.stats;
    } finally {
      await this.transport.close();
    }
  }
}
export async function runSimulation(config, factory, sleep = async () => {}) {
  validateConfig(config);
  const devices = config.devices.map((device) => new SimulatedDevice(device.deviceId, factory(device), config));
  for (const device of devices) device.transport.onMessage?.((topic, payload) => device.receive(topic, payload));
  const results = await Promise.allSettled(devices.map((device) => device.run(sleep)));
  if (results.some((result) => result.status === 'rejected')) throw new Error('SIMULATION_FAILED');
  return {
    task: 'QA-01',
    mode: config.mode,
    status: 'PASS',
    deviceCount: devices.length,
    rounds: config.rounds,
    telemetrySeconds: config.telemetrySeconds,
    targetAcceptance: 'NOT RUN / NO RECEIPT',
    devices: devices.map((device) => ({ deviceId: device.deviceId, ...device.stats })),
  };
}
