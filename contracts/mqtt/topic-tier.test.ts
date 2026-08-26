/**
 * DEC-002 Topic Tier 标记测试。
 * 运行：node --test "contracts/mqtt/topic-tier.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  TOPIC_TIER_REGISTRY,
  TopicTierError,
  getTopicTier,
  getTopicTierSpec,
  getTopicTierStatus,
  listTopicsByTier,
  topicRequiresAudit,
} from './topic-tier.ts';
import { TOPIC_CATALOG, type TopicType } from './topics.ts';
import { SchemaRegistry, validate } from './validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const tierJson = read('./topic-tier.json');
const tierSchema = read('./topic-tier.schema.json');
const topicCatalogJson = read('./topic-catalog.json');
const registerJson = read('../decisions/decision-register.json');

const ALL_TOPICS = Object.keys(TOPIC_CATALOG) as TopicType[];
const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;
const SCHEMA_FILE: Record<TopicType, string> = {
  heartbeat: 'heartbeat',
  telemetry: 'telemetry',
  report: 'report',
  alarm: 'alarm',
  event: 'event',
  ack: 'ack',
  tamper: 'tamper',
  media: 'media',
  cmd: 'cmd',
  ota: 'ota',
  notification: 'notification',
};

test('Tier 登记 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(tierSchema, 'topic-tier.schema.json', tierJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：非法 Tier、未知 Topic 键与缺失字段被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(tierJson));
    mutate(m);
    return validate(tierSchema, 'topic-tier.schema.json', m, registry);
  };
  // 非法 Tier 枚举
  assert.ok(
    run((m) => {
      (m.topics as Record<string, Record<string, unknown>>).telemetry.tier = 'CRITICAL';
    }).some((e) => e.path === 'topics.telemetry.tier' && e.keyword === 'enum'),
  );
  // 未知 Topic 键被拒绝（封闭键集合）
  assert.ok(
    run((m) => {
      (m.topics as Record<string, unknown>).video = { tier: 'STANDARD', consumers: ['CT-03'], note: 'x' };
    }).some((e) => e.keyword === 'additionalProperties'),
  );
  // 缺少必填 Topic
  assert.ok(
    run((m) => {
      delete (m.topics as Record<string, unknown>).tamper;
    }).some((e) => e.path === 'topics' && e.keyword === 'required'),
  );
  // fallbackPolicy 必须为 deny（失败关闭）
  assert.ok(
    run((m) => {
      (m.tierPolicy as Record<string, unknown>).fallbackPolicy = 'allow';
    }).some((e) => e.keyword === 'enum'),
  );
  // status 非法枚举
  assert.ok(
    run((m) => {
      m.status = 'draft';
    }).some((e) => e.path === 'status' && e.keyword === 'enum'),
  );
});

test('x-decision-versions 引用 DEC-002 且版本与决策登记一致', () => {
  const refs: string[] = tierJson['x-decision-versions'];
  const dec002 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-002');
  assert.ok(dec002, '决策登记必须包含 DEC-002');
  assert.ok(refs.includes(`DEC-002@${dec002.version}`), `引用必须包含 DEC-002@${dec002.version}`);
  if (dec002.status !== 'frozen') {
    assert.equal(tierJson.status, 'provisional');
    assert.ok(tierJson.tierVersion.startsWith('0.'));
  }
});

test('暂定值：Telemetry/Report/Tamper 为 AUDITED，Command 及其余为 STANDARD', () => {
  assert.deepEqual(listTopicsByTier('AUDITED').sort(), ['report', 'tamper', 'telemetry']);
  assert.equal(topicRequiresAudit('telemetry'), true);
  assert.equal(topicRequiresAudit('report'), true);
  assert.equal(topicRequiresAudit('tamper'), true);
  assert.equal(topicRequiresAudit('cmd'), false);
  for (const t of ALL_TOPICS) {
    if (!['telemetry', 'report', 'tamper'].includes(t)) {
      assert.equal(getTopicTier(t), 'STANDARD', `${t} 应为 STANDARD`);
    }
  }
});

test('Tier 与 topic-catalog.json 的 payloadEnvelope 完全一致', () => {
  for (const entry of topicCatalogJson.topics) {
    const expectAudited = entry.payloadEnvelope === 'meta+audit+data';
    assert.equal(
      topicRequiresAudit(entry.type),
      expectAudited,
      `${entry.type}: Tier 与 payloadEnvelope (${entry.payloadEnvelope}) 不一致`,
    );
  }
});

test('Tier 与 11 个 MQTT Schema 的 audit 强制完全一致', () => {
  for (const t of ALL_TOPICS) {
    const schema = read(`./schemas/${SCHEMA_FILE[t]}.schema.json`);
    const required: string[] = schema.required;
    const hasAuditProp = 'audit' in schema.properties;
    if (topicRequiresAudit(t)) {
      assert.ok(required.includes('audit') && hasAuditProp, `${t}: AUDITED 必须强制 audit 字段`);
    } else {
      assert.ok(!required.includes('audit') && !hasAuditProp, `${t}: STANDARD 不得含 audit 字段`);
    }
  }
});

test('失败关闭：未知 Topic 拒绝并抛出稳定错误', () => {
  assert.throws(
    () => getTopicTier('video'),
    (e: unknown) => e instanceof TopicTierError && (e as TopicTierError).kind === 'UNKNOWN_TOPIC',
  );
  assert.throws(() => topicRequiresAudit(''), TopicTierError);
  assert.throws(() => getTopicTierSpec('CMD'), TopicTierError);
});

test('Tier 条目消费者均为合法任务 ID 且覆盖 DEC-002 阻塞任务', () => {
  const consumers = new Set<string>();
  for (const t of ALL_TOPICS) {
    const spec = getTopicTierSpec(t);
    assert.ok(spec.note.length > 0, `${t} 缺少 note`);
    assert.ok(spec.consumers.length > 0, `${t} 缺少 consumers`);
    for (const c of spec.consumers) {
      assert.ok(TASK_ID.test(c), `${t} 的消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  for (const task of registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-002').blockingTasks as string[]) {
    assert.ok(consumers.has(task), `阻塞任务 ${task} 未被任何 Tier 条目承接`);
  }
});

test('登记覆盖全部 11 个 Topic 且 TS 常量与 topic-tier.json 完全一致', () => {
  assert.deepEqual(Object.keys(tierJson.topics).sort(), [...ALL_TOPICS].sort());
  assert.equal(tierJson.tierVersion, TOPIC_TIER_REGISTRY.tierVersion);
  assert.equal(tierJson.status, TOPIC_TIER_REGISTRY.status);
  assert.equal(tierJson.tierPolicy.fallbackPolicy, TOPIC_TIER_REGISTRY.fallbackPolicy);
  assert.equal(tierJson.tierPolicy.sourceRule, TOPIC_TIER_REGISTRY.sourceRule);
  for (const t of ALL_TOPICS) {
    const json = tierJson.topics[t];
    const spec = TOPIC_TIER_REGISTRY.topics[t];
    assert.equal(spec.tier, json.tier, t);
    assert.deepEqual([...spec.consumers].sort(), [...json.consumers].sort(), t);
    assert.equal(spec.note, json.note, t);
  }
  assert.equal(getTopicTierStatus(), 'provisional');
});
