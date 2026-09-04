import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const policy = read('./archive-source-policy.json');
const schema = read('./archive-envelope.schema.json');
const register = read('../decisions/decision-register.json');

test('DEC-016 已冻结且策略覆盖全部阻塞任务', () => {
  const decision = register.decisions.find((item) => item.id === 'DEC-016');
  assert.equal(decision.status, 'frozen');
  assert.equal(decision.version, '1.0.0');
  assert.ok(policy['x-decision-versions'].includes('DEC-016@1.0.0'));
  assert.deepEqual(new Set(policy.consumers), new Set(decision.blockingTasks));
  assert.deepEqual(policy.pendingParameters, []);
});

test('三类来源使用独立 Envelope 与互斥前缀', () => {
  assert.deepEqual(Object.keys(policy.classes), ['MQTT_RAW', 'DOMAIN_EVENT', 'OPERATION_RECORD']);
  assert.match(policy.classes.MQTT_RAW.prefix, /^raw\//);
  assert.match(policy.classes.DOMAIN_EVENT.prefix, /^domain\//);
  assert.match(policy.classes.OPERATION_RECORD.prefix, /^operations\//);
  assert.equal(new Set(Object.values(policy.classes).map((item) => item.prefix.split('/')[0])).size, 3);
  assert.equal(policy.rules.mixedEnvelopeAllowed, false);
});

test('License/OTA 禁止伪装为 MQTT 原文，OTA 记录类型封闭', () => {
  assert.deepEqual(policy.classes.MQTT_RAW.forbiddenSources, ['license', 'ota']);
  assert.deepEqual(policy.classes.DOMAIN_EVENT.sources, ['license']);
  assert.deepEqual(policy.classes.OPERATION_RECORD.sources, ['ota']);
  assert.deepEqual(policy.classes.OPERATION_RECORD.recordTypes, ['PUBLICATION', 'RESULT']);
  assert.equal(policy.rules.otaResultSource, 'DEC-015_ACK_OTA_TARGET');
});

test('归档 Envelope 判别字段和版本固定', () => {
  assert.deepEqual(schema.properties.archiveClass.enum, ['MQTT_RAW', 'DOMAIN_EVENT', 'OPERATION_RECORD']);
  assert.equal(schema.properties.envelopeVersion.const, policy.envelopeVersion);
  assert.ok(schema.required.includes('archiveClass'));
  assert.equal(schema.oneOf.length, 3);
});
