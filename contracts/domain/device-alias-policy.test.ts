import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEVICE_ALIAS_POLICY } from './device-alias-policy.ts';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const json = read('./device-alias-policy.json');
const register = read('../decisions/decision-register.json');
const adminApi = read('../rest/admin-device-api.json');

test('DEC-019 alias 策略已冻结且无待定参数', () => {
  const decision = register.decisions.find((item: { id: string }) => item.id === 'DEC-019');
  assert.equal(decision.status, 'frozen');
  assert.equal(decision.version, '1.0.0');
  assert.deepEqual(json['x-decision-versions'], ['DEC-019@1.0.0']);
  assert.deepEqual(json.pendingParameters, []);
});

test('TS、JSON 与 Admin Device OpenAPI 使用同一 alias 规则', () => {
  for (const key of Object.keys(DEVICE_ALIAS_POLICY) as Array<keyof typeof DEVICE_ALIAS_POLICY>) {
    assert.deepEqual(json[key], DEVICE_ALIAS_POLICY[key]);
  }
  assert.ok(adminApi.info['x-decision-versions'].includes('DEC-019@1.0.0'));
  const alias = adminApi.components.schemas.DeviceMetadataUpdate.properties.alias;
  assert.equal(alias.minLength, DEVICE_ALIAS_POLICY.minimumLength);
  assert.equal(alias.maxLength, DEVICE_ALIAS_POLICY.maximumLength);
  assert.equal(alias['x-unicode-normalization'], DEVICE_ALIAS_POLICY.unicodeNormalization);
  assert.equal(alias['x-case-sensitivity'], DEVICE_ALIAS_POLICY.caseSensitivity);
});
