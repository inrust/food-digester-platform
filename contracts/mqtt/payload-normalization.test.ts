import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname } from 'node:path';
import { SchemaRegistry, validate } from './validator.mjs';
import {
  DEC013_LEGACY_COMPATIBILITY_ENDS_AT,
  PayloadNormalizationError,
  canonicalizeJson,
  computeAuditHash,
  normalizeMqttPayload,
  verifyAuditHash,
} from './payload-normalization.ts';

const policy = JSON.parse(
  readFileSync(fileURLToPath(new URL('./payload-normalization-policy.json', import.meta.url)), 'utf8'),
);
const policySchema = JSON.parse(
  readFileSync(fileURLToPath(new URL('./payload-normalization-policy.schema.json', import.meta.url)), 'utf8'),
);
const register = JSON.parse(
  readFileSync(fileURLToPath(new URL('../decisions/decision-register.json', import.meta.url)), 'utf8'),
);

test('DEC-013 策略 JSON 通过自身 Schema 且覆盖登记阻塞任务', () => {
  const registry = new SchemaRegistry(dirname(fileURLToPath(import.meta.url)));
  assert.deepEqual(validate(policySchema, 'payload-normalization-policy.schema.json', policy, registry), []);
  const decision = register.decisions.find((entry: { id: string }) => entry.id === 'DEC-013');
  assert.ok(decision);
  assert.equal(decision.status, 'frozen');
  assert.equal(decision.version, '1.0.0');
  assert.deepEqual([...policy.consumers].sort(), [...decision.blockingTasks].sort());
});

test('DEC-013 策略关键值被 Schema 锁定，篡改时失败关闭', () => {
  const registry = new SchemaRegistry(dirname(fileURLToPath(import.meta.url)));
  const mutated = structuredClone(policy);
  mutated.auditHash.coveredObject = 'data';
  const errors = validate(policySchema, 'payload-normalization-policy.schema.json', mutated, registry);
  assert.ok(errors.some((error) => error.path === 'auditHash.coveredObject' && error.keyword === 'enum'));
});

test('DEC-013 策略冻结且无待定参数', () => {
  assert.equal(policy.policyVersion, '1.0.0');
  assert.equal(policy.status, 'frozen');
  assert.deepEqual(policy['x-decision-versions'], ['DEC-013@1.0.0']);
  assert.equal(policy.legacyCompatibility.durationDays, 90);
  assert.equal(policy.legacyCompatibility.endsAt, DEC013_LEGACY_COMPATIBILITY_ENDS_AT);
  assert.deepEqual(policy.pendingParameters, []);
});

test('Heartbeat 旧嵌套结构在兼容期转换为正式扁平结构且不修改原对象', () => {
  const original = {
    meta: { id: 'HB-1', ts: '2026-09-05T00:00:00Z', seq: 1 },
    data: {
      network: { type: '4G', status: 'CONNECTED', signal: -68 },
      system: { cpuUsage: 25, memoryUsage: 40, storageUsage: 30 },
      machine: { running: true, currentMode: 'DISCHARING' },
      sensorStatus: { overall: 'NORMAL', temperature: 'NORMAL' },
    },
  };
  const normalized = normalizeMqttPayload('heartbeat', original, '2026-09-05T00:00:00Z');
  assert.deepEqual(normalized.data, {
    networkType: '4G',
    networkStatus: 'CONNECTED',
    signalStrength: -68,
    cpuUsagePct: 25,
    memoryUsagePct: 40,
    storageUsagePct: 30,
    machineRunning: true,
    machineMode: 'DISCHARGING',
    sensorOverallStatus: 'NORMAL',
    temperatureSensor: 'NORMAL',
  });
  assert.ok('network' in original.data);
});

test('Telemetry motorCurrentAmp 在兼容期转换为 currentAmp；同值并存允许、冲突失败关闭', () => {
  assert.deepEqual(normalizeMqttPayload('telemetry', { data: { motorCurrentAmp: 3.8 } }, '2026-09-05T00:00:00Z').data, {
    currentAmp: 3.8,
  });
  assert.deepEqual(
    normalizeMqttPayload('telemetry', { data: { currentAmp: 3.8, motorCurrentAmp: 3.8 } }, '2026-09-05T00:00:00Z').data,
    { currentAmp: 3.8 },
  );
  assert.throws(
    () =>
      normalizeMqttPayload('telemetry', { data: { currentAmp: 3.8, motorCurrentAmp: 4.2 } }, '2026-09-05T00:00:00Z'),
    (error: unknown) => error instanceof PayloadNormalizationError && error.code === 'LEGACY_FIELD_CONFLICT',
  );
});

test('兼容截止边界起拒绝嵌套结构、motorCurrentAmp 与 DISCHARING', () => {
  for (const [topicType, payload] of [
    ['heartbeat', { data: { network: { type: '4G' } } }],
    ['heartbeat', { data: { machineMode: 'DISCHARING' } }],
    ['telemetry', { data: { motorCurrentAmp: 3.8 } }],
  ] as const) {
    assert.throws(
      () => normalizeMqttPayload(topicType, payload, DEC013_LEGACY_COMPATIBILITY_ENDS_AT),
      (error: unknown) => error instanceof PayloadNormalizationError && error.code === 'LEGACY_FORMAT_EXPIRED',
    );
  }
});

test('RFC 8785 固定向量与 audit.hash 覆盖 {meta,data}', () => {
  const payload = {
    meta: { ts: '2026-09-04T10:00:00Z', seq: 7, id: 'TEL-DEV001-7' },
    audit: { hash: '' },
    data: { z: 0, currentAmp: 3.8, label: '设备' },
  };
  const canonical = canonicalizeJson({ meta: payload.meta, data: payload.data });
  assert.equal(
    canonical,
    '{"data":{"currentAmp":3.8,"label":"设备","z":0},"meta":{"id":"TEL-DEV001-7","seq":7,"ts":"2026-09-04T10:00:00Z"}}',
  );
  const hash = computeAuditHash(payload);
  assert.equal(hash, 'fb4471f41cd29e49797f451e97a36ece32c52953c971fbff996d541be27dcb75');
  payload.audit.hash = hash;
  assert.equal(verifyAuditHash(payload), true);
  payload.data.currentAmp = 3.9;
  assert.equal(verifyAuditHash(payload), false);
});
