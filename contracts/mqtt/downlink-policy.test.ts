/**
 * DEC-006 下行消息 meta.seq 与幂等键策略测试。
 * 运行：node --test "contracts/mqtt/downlink-policy.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  DOWNLINK_POLICY,
  getCommandIdempotencyKey,
  getDownlinkPolicyStatus,
  isDownlinkMetaSeqRequired,
  isUplinkMetaSeqRequired,
} from './downlink-policy.ts';
import { SchemaRegistry, validate } from './validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./downlink-policy.json');
const policySchema = read('./downlink-policy.schema.json');
const registerJson = read('../decisions/decision-register.json');
const commonSchema = read('./schemas/common.schema.json');

const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;
const DOWNLINK_SCHEMAS = ['cmd', 'notification', 'ota'];
const UPLINK_SCHEMAS = ['telemetry', 'report', 'tamper', 'alarm', 'event', 'ack', 'media', 'heartbeat'];

test('策略 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(policySchema, 'downlink-policy.schema.json', policyJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：非法取值与缺失字段被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(policyJson));
    mutate(m);
    return validate(policySchema, 'downlink-policy.schema.json', m, registry);
  };
  // 上行 seq 锁定 required
  assert.ok(run((m) => { (m.sequencing as Record<string, unknown>).uplinkMetaSeq = 'optional'; }).some((e) => e.path === 'sequencing.uplinkMetaSeq' && e.keyword === 'enum'));
  // Command 幂等键锁定 meta.id
  assert.ok(run((m) => { (m.idempotency as Record<string, unknown>).commandKey = 'meta.seq'; }).some((e) => e.path === 'idempotency.commandKey' && e.keyword === 'enum'));
  // 冻结后 downlinkMetaSeq 允许改 required（合法演进）
  assert.deepEqual(run((m) => { (m.sequencing as Record<string, unknown>).downlinkMetaSeq = 'required'; }), []);
  // 缺字段与额外字段被拒绝
  assert.ok(run((m) => { delete m.migration; }).some((e) => e.keyword === 'required'));
  assert.ok(run((m) => { m.extra = 1; }).some((e) => e.keyword === 'additionalProperties'));
});

test('x-decision-versions 引用 DEC-006 且版本与决策登记一致', () => {
  const refs: string[] = policyJson['x-decision-versions'];
  const dec006 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-006');
  assert.ok(dec006, '决策登记必须包含 DEC-006');
  assert.ok(refs.includes(`DEC-006@${dec006.version}`), `引用必须包含 DEC-006@${dec006.version}`);
  if (dec006.status !== 'frozen') {
    assert.equal(policyJson.status, 'provisional');
    assert.ok(policyJson.policyVersion.startsWith('0.'));
  }
});

test('暂定值可执行：V1 下行 seq 可选、上行必填、Command 以 meta.id 幂等', () => {
  assert.equal(isDownlinkMetaSeqRequired(), false);
  assert.equal(isUplinkMetaSeqRequired(), true);
  assert.equal(getCommandIdempotencyKey(), 'meta.id');
});

test('策略与 common.schema.json 一致：下行 metaBase 不要求 seq、id 必填；上行 metaSeq 要求 seq', () => {
  const metaBase = commonSchema.$defs.metaBase;
  const metaSeq = commonSchema.$defs.metaSeq;
  if (isDownlinkMetaSeqRequired()) {
    assert.ok(metaBase.required.includes('seq'), '策略要求下行 seq 时 metaBase 必须 required seq');
  } else {
    assert.ok(!metaBase.required.includes('seq'), '策略下行 seq 可选时 metaBase 不得 required seq');
  }
  assert.ok(metaBase.required.includes('id'), 'Command 以 meta.id 幂等要求 metaBase 必填 id');
  assert.ok(metaSeq.allOf.some((s: { required?: string[] }) => s.required?.includes('seq')), 'metaSeq 必须 required seq');
});

test('下行/上行 Schema 的 meta 引用与策略一致', () => {
  const dec006 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-006');
  for (const type of DOWNLINK_SCHEMAS) {
    const schema = read(`./schemas/${type}.schema.json`);
    assert.equal(schema.properties.meta.$ref, 'common.schema.json#/$defs/metaBase', `${type} 必须引用 metaBase（seq 可选）`);
    assert.ok(schema['x-decision-versions'].includes(`DEC-006@${dec006.version}`), `${type} 必须引用 DEC-006@${dec006.version}`);
  }
  for (const type of UPLINK_SCHEMAS) {
    const schema = read(`./schemas/${type}.schema.json`);
    assert.equal(schema.properties.meta.$ref, 'common.schema.json#/$defs/metaSeq', `${type} 必须引用 metaSeq（seq 必填）`);
  }
  // common.schema.json 自身必须引用 DEC-006 当前版本
  assert.ok(commonSchema['x-decision-versions'].includes(`DEC-006@${dec006.version}`), 'common.schema.json 必须引用 DEC-006 当前登记版本');
});

test('策略消费者均为合法任务 ID 且覆盖 DEC-006 阻塞任务', () => {
  const consumers = new Set<string>();
  for (const s of [DOWNLINK_POLICY.sequencing, DOWNLINK_POLICY.idempotency, DOWNLINK_POLICY.migration]) {
    assert.ok(s.note.length > 0, '缺少 note');
    assert.ok(s.consumers.length > 0, '缺少 consumers');
    for (const c of s.consumers) {
      assert.ok(TASK_ID.test(c), `消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  const dec006 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-006');
  for (const task of dec006.blockingTasks as string[]) {
    assert.ok(consumers.has(task), `阻塞任务 ${task} 未被策略承接`);
  }
});

test('TS 常量与 downlink-policy.json 完全一致', () => {
  assert.equal(policyJson.policyVersion, DOWNLINK_POLICY.policyVersion);
  assert.equal(policyJson.status, DOWNLINK_POLICY.status);
  assert.equal(policyJson.sequencing.downlinkMetaSeq, DOWNLINK_POLICY.sequencing.downlinkMetaSeq);
  assert.equal(policyJson.sequencing.uplinkMetaSeq, DOWNLINK_POLICY.sequencing.uplinkMetaSeq);
  assert.equal(policyJson.sequencing.note, DOWNLINK_POLICY.sequencing.note);
  assert.deepEqual(policyJson.sequencing.consumers, [...DOWNLINK_POLICY.sequencing.consumers]);
  assert.equal(policyJson.idempotency.commandKey, DOWNLINK_POLICY.idempotency.commandKey);
  assert.equal(policyJson.idempotency.note, DOWNLINK_POLICY.idempotency.note);
  assert.deepEqual(policyJson.idempotency.consumers, [...DOWNLINK_POLICY.idempotency.consumers]);
  assert.equal(policyJson.migration.onFrozenChange, DOWNLINK_POLICY.migration.onFrozenChange);
  assert.equal(policyJson.migration.note, DOWNLINK_POLICY.migration.note);
  assert.deepEqual(policyJson.migration.consumers, [...DOWNLINK_POLICY.migration.consumers]);
  assert.deepEqual(policyJson.pendingParameters, [...DOWNLINK_POLICY.pendingParameters]);
  assert.equal(policyJson.frozenUpgradePath, DOWNLINK_POLICY.frozenUpgradePath);
  assert.equal(getDownlinkPolicyStatus(), 'provisional');
});
