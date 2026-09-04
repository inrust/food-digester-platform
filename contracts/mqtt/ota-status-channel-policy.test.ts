import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OTA_STATUS_CHANNEL_POLICY, canTransitionOtaStatus, isOtaWireStatus } from './ota-status-channel-policy.ts';

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const json = read('./ota-status-channel-policy.json');
const register = read('../decisions/decision-register.json');
const topics = read('./topic-catalog.json');
const ack = read('./schemas/ack.schema.json');

test('DEC-015 策略冻结、可追溯且覆盖全部阻塞任务', () => {
  const decision = register.decisions.find((item: { id: string }) => item.id === 'DEC-015');
  assert.equal(decision.status, 'frozen');
  assert.equal(decision.version, '1.0.0');
  assert.ok(json['x-decision-versions'].includes('DEC-015@1.0.0'));
  assert.deepEqual(new Set(json.consumers), new Set(decision.blockingTasks));
  assert.deepEqual(json.pendingParameters, []);
});

test('唯一通道为既有 ACK；Topic 总数和 IoT 权限面不扩大', () => {
  assert.equal(OTA_STATUS_CHANNEL_POLICY.channel.topicType, 'ack');
  assert.equal(OTA_STATUS_CHANNEL_POLICY.channel.newTopicAllowed, false);
  assert.equal(OTA_STATUS_CHANNEL_POLICY.channel.iotJobsStatusAllowed, false);
  assert.equal(topics.topics.length, 11);
  assert.equal(topics.topics.filter((item: { direction: string }) => item.direction === 'uplink').length, 8);
  assert.ok(!topics.topics.some((item: { type: string }) => item.type === 'ota/status'));
});

test('ACK 判别字段、关联键和 OTA 状态与冻结策略一致', () => {
  assert.deepEqual(ack.properties.data.required, ['objectType']);
  assert.deepEqual(ack.properties.data.properties.objectType.enum, ['COMMAND', 'OTA_TARGET']);
  assert.deepEqual(ack.properties.data.properties.status.enum, [...OTA_STATUS_CHANNEL_POLICY.otaStatuses]);
  assert.ok(ack['x-decision-versions'].includes('DEC-015@1.0.0'));
});

test('状态机只允许冻结的单向迁移；相同状态幂等', () => {
  for (const status of OTA_STATUS_CHANNEL_POLICY.otaStatuses) assert.equal(isOtaWireStatus(status), true);
  assert.equal(canTransitionOtaStatus('NOTIFIED', 'DOWNLOADING'), true);
  assert.equal(canTransitionOtaStatus('DOWNLOADING', 'INSTALLING'), true);
  assert.equal(canTransitionOtaStatus('INSTALLING', 'SUCCEEDED'), true);
  assert.equal(canTransitionOtaStatus('SUCCEEDED', 'ROLLED_BACK'), true);
  assert.equal(canTransitionOtaStatus('INSTALLING', 'INSTALLING'), true);
  assert.equal(canTransitionOtaStatus('NOTIFIED', 'SUCCEEDED'), false);
  assert.equal(canTransitionOtaStatus('FAILED', 'DOWNLOADING'), false);
});

test('TS 常量与 JSON 策略完全一致', () => {
  assert.equal(json.policyVersion, OTA_STATUS_CHANNEL_POLICY.policyVersion);
  assert.equal(json.status, OTA_STATUS_CHANNEL_POLICY.status);
  assert.deepEqual(json.channel, OTA_STATUS_CHANNEL_POLICY.channel);
  assert.deepEqual(json.discriminator, OTA_STATUS_CHANNEL_POLICY.discriminator);
  assert.deepEqual(json.otaStatuses, [...OTA_STATUS_CHANNEL_POLICY.otaStatuses]);
  assert.deepEqual(json.transitions, OTA_STATUS_CHANNEL_POLICY.transitions);
  assert.deepEqual(json.idempotency, OTA_STATUS_CHANNEL_POLICY.idempotency);
  assert.deepEqual(json.consumers, [...OTA_STATUS_CHANNEL_POLICY.consumers]);
});
