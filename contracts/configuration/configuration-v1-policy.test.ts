import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';
import { CONFIGURATION_V1_POLICY } from './configuration-v1-policy.ts';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const json = read('./configuration-v1-policy.json');
const schema = read('./configuration-v1-policy.schema.json');
const register = read('../decisions/decision-register.json');
const adminApi = read('../rest/admin-configuration-api.json');
const syncApi = read('../rest/device-sync-api.json');

test('DEC-018 策略结构有效、已冻结且覆盖全部阻塞任务', () => {
  assert.deepEqual(
    validate(schema, 'configuration/configuration-v1-policy.schema.json', json, new SchemaRegistry('.')),
    [],
  );
  const decision = register.decisions.find((item: { id: string }) => item.id === 'DEC-018');
  assert.equal(decision.status, 'frozen');
  assert.equal(decision.version, '1.0.0');
  assert.deepEqual(json['x-decision-versions'], ['DEC-018@1.0.0']);
  assert.deepEqual(new Set(json.consumers), new Set(decision.blockingTasks));
  assert.deepEqual(json.pendingParameters, []);
});

test('V1 只允许四字段，范围、单位、默认值与冻结值一致', () => {
  assert.deepEqual(Object.keys(json.fields), [
    'heartbeatInterval',
    'telemetryInterval',
    'cameraRefreshInterval',
    'temperatureThreshold',
  ]);
  assert.deepEqual(json.fields, CONFIGURATION_V1_POLICY.fields);
  assert.equal(json.snapshotMode, 'FULL');
  assert.equal(json.unknownFieldDisposition, 'REJECT');
});

test('Admin Configuration 与 Device Sync OpenAPI 逐字段匹配统一策略', () => {
  for (const apiSchema of [
    adminApi.components.schemas.ConfigurationPayload,
    syncApi.components.schemas.SyncConfiguration,
  ]) {
    assert.equal(apiSchema.additionalProperties, false);
    assert.deepEqual(new Set(apiSchema.required), new Set(Object.keys(json.fields)));
    for (const [name, field] of Object.entries(json.fields) as [
      string,
      { type: string; unit: string; minimum: number; maximum: number; default: number },
    ][]) {
      assert.deepEqual(
        {
          type: apiSchema.properties[name].type,
          unit: apiSchema.properties[name]['x-unit'],
          minimum: apiSchema.properties[name].minimum,
          maximum: apiSchema.properties[name].maximum,
          default: apiSchema.properties[name].default,
        },
        {
          type: field.type,
          unit: field.unit,
          minimum: field.minimum,
          maximum: field.maximum,
          default: field.default,
        },
      );
    }
    for (const excluded of json.excludedCandidateFields) assert.ok(!(excluded in apiSchema.properties));
  }
});

test('TS 常量与 JSON 策略一致', () => {
  assert.equal(json.policyVersion, CONFIGURATION_V1_POLICY.policyVersion);
  assert.equal(json.status, CONFIGURATION_V1_POLICY.status);
  assert.equal(json.snapshotMode, CONFIGURATION_V1_POLICY.snapshotMode);
  assert.equal(json.unknownFieldDisposition, CONFIGURATION_V1_POLICY.unknownFieldDisposition);
  assert.deepEqual(json.fields, CONFIGURATION_V1_POLICY.fields);
  assert.deepEqual(json.excludedCandidateFields, [...CONFIGURATION_V1_POLICY.excludedCandidateFields]);
  assert.deepEqual(json.consumers, [...CONFIGURATION_V1_POLICY.consumers]);
});
