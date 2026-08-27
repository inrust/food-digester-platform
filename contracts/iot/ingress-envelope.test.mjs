/**
 * BE-IOT-01 Ingress Envelope 契约测试。
 * 运行：node --test "contracts/iot/ingress-envelope.test.mjs"
 *
 * 验收基准覆盖：
 * - Envelope 保留原始 Payload（additionalProperties 平铺）且五个上下文字段必填；
 * - iotType/iotTopic 白名单与 CT-02 topic-catalog 8 个上行类型严格一致（奇偶）；
 * - 合法/非法 Fixture 通过子集校验器稳定判定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const schema = JSON.parse(readFileSync(`${DIR}/ingress-envelope.schema.json`, 'utf8'));
const fixtures = JSON.parse(readFileSync(`${DIR}/ingress-envelope.fixtures.json`, 'utf8'));
const topicCatalog = JSON.parse(readFileSync(new URL('../mqtt/topic-catalog.json', import.meta.url), 'utf8'));
const registry = new SchemaRegistry(DIR);

const UPLINK_TYPES = topicCatalog.topics.filter((t) => t.direction === 'uplink').map((t) => t.type);

test('Envelope 必填五个 iot* 上下文字段，Payload 平铺透传', () => {
  assert.deepEqual([...schema.required].sort(), [
    'iotDeviceId',
    'iotPrincipal',
    'iotReceivedAt',
    'iotTopic',
    'iotType',
  ]);
  assert.equal(schema.additionalProperties, true, '原始 Payload 必须原样保留（平铺透传）');
});

test('iotType 枚举与 topic-catalog 上行类型严格一致（8 个）', () => {
  assert.equal(UPLINK_TYPES.length, 8);
  assert.deepEqual([...schema.properties.iotType.enum].sort(), [...UPLINK_TYPES].sort());
  for (const type of UPLINK_TYPES) {
    assert.ok(schema.properties.iotTopic.pattern.includes(type), `iotTopic pattern 缺少 ${type}`);
  }
});

test('所有合法 Fixture 通过校验（含 Payload 内不可信身份字段的样本）', () => {
  fixtures.valid.forEach((payload, i) => {
    const errors = validate(schema, 'ingress-envelope.schema.json', payload, registry);
    assert.deepEqual(errors, [], `valid[${i}] 应通过: ${JSON.stringify(errors)}`);
  });
});

test('所有非法 Fixture 被稳定拒绝且错误路径正确', () => {
  for (const { name, payload, expectPath } of fixtures.invalid) {
    const errors = validate(schema, 'ingress-envelope.schema.json', payload, registry);
    assert.ok(errors.length > 0, `"${name}" 应被拒绝`);
    assert.ok(
      errors.some((e) => e.path === expectPath || e.path.startsWith(expectPath + '.')),
      `"${name}" 错误路径 ${errors.map((e) => e.path).join(',')} 中应包含 ${expectPath}`,
    );
  }
});
