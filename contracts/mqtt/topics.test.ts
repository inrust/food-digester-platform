/**
 * CT-02 Topic 契约单元测试。
 * 运行：node --test "contracts/mqtt/*.test.ts"（Node >= 22.18 原生类型剥离）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TOPIC_CATALOG,
  UPLINK_TOPIC_TYPES,
  DOWNLINK_TOPIC_TYPES,
  TopicError,
  buildTopic,
  parseTopic,
  effectiveQos,
  isValidDeviceId,
  deviceTopicPermissionTemplate,
  type TopicType,
} from './topics.ts';

const CATALOG_PATH = new URL('./topic-catalog.json', import.meta.url).pathname;
const catalogJson = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

test('catalog 恰好包含 8 个上行和 3 个下行 Topic', () => {
  assert.equal(Object.keys(TOPIC_CATALOG).length, 11);
  assert.equal(UPLINK_TOPIC_TYPES.length, 8);
  assert.equal(DOWNLINK_TOPIC_TYPES.length, 3);
  assert.deepEqual(
    [...UPLINK_TOPIC_TYPES].sort(),
    ['ack', 'alarm', 'event', 'heartbeat', 'media', 'report', 'tamper', 'telemetry'].sort(),
  );
  assert.deepEqual([...DOWNLINK_TOPIC_TYPES].sort(), ['cmd', 'notification', 'ota'].sort());
});

test('11 个 Topic 的方向与 QoS 矩阵全部符合契约', () => {
  const expectations: Record<TopicType, { direction: string; specifiedQos: number; awsEffectiveQos: number }> = {
    heartbeat: { direction: 'uplink', specifiedQos: 1, awsEffectiveQos: 1 },
    telemetry: { direction: 'uplink', specifiedQos: 1, awsEffectiveQos: 1 },
    report: { direction: 'uplink', specifiedQos: 2, awsEffectiveQos: 1 },
    alarm: { direction: 'uplink', specifiedQos: 1, awsEffectiveQos: 1 },
    event: { direction: 'uplink', specifiedQos: 1, awsEffectiveQos: 1 },
    ack: { direction: 'uplink', specifiedQos: 1, awsEffectiveQos: 1 },
    tamper: { direction: 'uplink', specifiedQos: 2, awsEffectiveQos: 1 },
    media: { direction: 'uplink', specifiedQos: 1, awsEffectiveQos: 1 },
    cmd: { direction: 'downlink', specifiedQos: 2, awsEffectiveQos: 1 },
    ota: { direction: 'downlink', specifiedQos: 1, awsEffectiveQos: 1 },
    notification: { direction: 'downlink', specifiedQos: 1, awsEffectiveQos: 1 },
  };
  for (const [type, expected] of Object.entries(expectations) as [TopicType, (typeof expectations)[TopicType]][]) {
    const spec = TOPIC_CATALOG[type];
    assert.equal(spec.direction, expected.direction, `${type} 方向错误`);
    assert.equal(spec.specifiedQos, expected.specifiedQos, `${type} specifiedQos 错误`);
    assert.equal(spec.awsEffectiveQos, expected.awsEffectiveQos, `${type} awsEffectiveQos 错误`);
    assert.equal(effectiveQos(type), expected.awsEffectiveQos, `${type} effectiveQos 错误`);
  }
  // QoS 2→1 适配（ADP-002）：report/tamper/cmd 规定值必须为 2，实施值必须为 1
  for (const type of ['report', 'tamper', 'cmd'] as const) {
    assert.equal(TOPIC_CATALOG[type].specifiedQos, 2);
    assert.equal(TOPIC_CATALOG[type].awsEffectiveQos, 1);
  }
  // 其余 Topic 规定值与实施值均为 1
  for (const type of Object.keys(TOPIC_CATALOG) as TopicType[]) {
    if (!(['report', 'tamper', 'cmd'] as TopicType[]).includes(type)) {
      assert.equal(TOPIC_CATALOG[type].specifiedQos, 1, `${type} specifiedQos 应为 1`);
    }
  }
});

test('TS 常量与 topic-catalog.json 完全一致', () => {
  assert.equal(catalogJson.topicPattern, 'bnx/device/{deviceId}/{type}');
  assert.equal(catalogJson.topics.length, 11);
  for (const entry of catalogJson.topics) {
    const spec = TOPIC_CATALOG[entry.type as TopicType];
    assert.ok(spec, `catalog 中的 ${entry.type} 在 TS 常量中不存在`);
    assert.equal(spec.direction, entry.direction);
    assert.equal(spec.specifiedQos, entry.specifiedQos);
    assert.equal(spec.awsEffectiveQos, entry.awsEffectiveQos);
    assert.equal(spec.name, entry.name);
    assert.equal(spec.frequency, entry.frequency);
    assert.equal(spec.payloadEnvelope, entry.payloadEnvelope);
  }
  // 追溯引用必须包含 QoS 适配决策
  assert.ok(catalogJson['x-decision-versions'].includes('ADP-002@1.0.0'));
  assert.ok(catalogJson['x-decision-versions'].includes('DEC-015@1.0.0'));
  assert.equal(TOPIC_CATALOG.ack.frequency, '命令执行或 OTA 状态变化后');
});

test('合法 Topic 可解析出 deviceId/type/direction', () => {
  const parsed = parseTopic('bnx/device/DEV-001/telemetry');
  assert.equal(parsed.deviceId, 'DEV-001');
  assert.equal(parsed.type, 'telemetry');
  assert.equal(parsed.direction, 'uplink');
  assert.equal(parsed.spec, TOPIC_CATALOG.telemetry);

  const downlink = parseTopic('bnx/device/DEV-001/cmd');
  assert.equal(downlink.direction, 'downlink');
});

test('buildTopic 与 parseTopic 往返一致', () => {
  for (const type of Object.keys(TOPIC_CATALOG) as TopicType[]) {
    const topic = buildTopic('dev_001.A', type);
    assert.equal(topic, `bnx/device/dev_001.A/${type}`);
    const parsed = parseTopic(topic);
    assert.equal(parsed.deviceId, 'dev_001.A');
    assert.equal(parsed.type, type);
  }
});

test('未知层级和空 deviceId 被拒绝', () => {
  const reject = (topic: string, reason: TopicError['reason']) =>
    assert.throws(
      () => parseTopic(topic),
      (err: unknown) => err instanceof TopicError && err.reason === reason,
    );

  // 未知 type / 未知层级
  reject('bnx/device/DEV-001/unknown', 'UNKNOWN_TOPIC_TYPE');
  reject('bnx/device/DEV-001/', 'UNKNOWN_TOPIC_TYPE');
  // 前缀错误
  reject('esg/tenant/DEV-001/telemetry', 'INVALID_PREFIX');
  reject('bnx/thing/DEV-001/telemetry', 'INVALID_PREFIX');
  // 段数错误
  reject('bnx/device/DEV-001', 'INVALID_SEGMENT_COUNT');
  reject('bnx/device/DEV-001/telemetry/extra', 'INVALID_SEGMENT_COUNT');
  reject('', 'INVALID_SEGMENT_COUNT');
  // 空 deviceId
  reject('bnx/device//telemetry', 'EMPTY_DEVICE_ID');
  // 非法 deviceId：通配符、空白、分隔符
  reject('bnx/device/+/telemetry', 'INVALID_DEVICE_ID');
  reject('bnx/device/#/telemetry', 'INVALID_DEVICE_ID');
  reject('bnx/device/DEV 001/telemetry', 'INVALID_DEVICE_ID');
});

test('buildTopic 拒绝空和非法 deviceId', () => {
  assert.throws(
    () => buildTopic('', 'cmd'),
    (e: unknown) => e instanceof TopicError && e.reason === 'EMPTY_DEVICE_ID',
  );
  assert.throws(
    () => buildTopic('a+b', 'cmd'),
    (e: unknown) => e instanceof TopicError && e.reason === 'INVALID_DEVICE_ID',
  );
  assert.throws(
    () => buildTopic('a/b', 'cmd'),
    (e: unknown) => e instanceof TopicError && e.reason === 'INVALID_DEVICE_ID',
  );
  assert.equal(isValidDeviceId('DEV-001'), true);
  assert.equal(isValidDeviceId(''), false);
  assert.equal(isValidDeviceId('+'), false);
});

test('权限模板：设备只能发布自身上行、只能订阅自身下行', () => {
  const tmpl = deviceTopicPermissionTemplate('DEV-001');
  assert.equal(tmpl.publish.length, 8);
  assert.equal(tmpl.subscribe.length, 3);
  assert.equal(tmpl.receive.length, 3);

  // 全部限定在自身 deviceId 前缀，无通配符
  for (const topic of [...tmpl.publish, ...tmpl.subscribe, ...tmpl.receive]) {
    assert.ok(topic.startsWith('bnx/device/DEV-001/'), topic);
    assert.ok(!topic.includes('+') && !topic.includes('#'), topic);
  }
  // publish 全为上行，subscribe/receive 全为下行
  for (const topic of tmpl.publish) assert.equal(parseTopic(topic).direction, 'uplink');
  for (const topic of tmpl.subscribe) assert.equal(parseTopic(topic).direction, 'downlink');
  // 不得跨设备
  assert.ok(!tmpl.publish.some((t) => t.includes('DEV-002')));
});

test('权限模板拒绝非法 deviceId', () => {
  assert.throws(() => deviceTopicPermissionTemplate(''), TopicError);
  assert.throws(() => deviceTopicPermissionTemplate('+'), TopicError);
});
