/**
 * DEC-008 耗材正式名称、数据来源与阈值策略测试。
 * 运行：node --test "contracts/domain/consumables-policy.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  CONSUMABLES_POLICY,
  UnknownConsumableTypeError,
  getConsumableDataSource,
  getConsumableDisplayName,
  getConsumableStaleAfterHours,
  getConsumableThreshold,
  getConsumableTypeCodes,
  getConsumablesPolicyStatus,
  isCloudPercentageDerivationAllowed,
  isKnownConsumableType,
} from './consumables-policy.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./consumables-policy.json');
const policySchema = read('./consumables-policy.schema.json');
const registerJson = read('../decisions/decision-register.json');
const traceabilityYaml = readFileSync(new URL('../prototype-traceability.yaml', import.meta.url), 'utf8');

const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;

test('策略 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(policySchema, 'consumables-policy.schema.json', policyJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：数据来源篡改与缺失字段被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(policyJson));
    mutate(m);
    return validate(policySchema, 'consumables-policy.schema.json', m, registry);
  };
  // 云端臆测百分比被拒绝（锁定 false）
  assert.ok(
    run((m) => {
      (m.dataSource as Record<string, unknown>).cloudDerivedPercentage = true;
    }).some((e) => e.path === 'dataSource.cloudDerivedPercentage' && e.keyword === 'enum'),
  );
  // 数据来源锁定 device-reported-only
  assert.ok(
    run((m) => {
      (m.dataSource as Record<string, unknown>).mode = 'cloud-computed';
    }).some((e) => e.path === 'dataSource.mode' && e.keyword === 'enum'),
  );
  // 冻结参数允许填入（frozen 后合法）
  assert.deepEqual(
    run((m) => {
      const d = m.display as Record<string, Record<string, unknown>>;
      d.names.CARBON_FILTER = '碳滤网';
      d.names.BIO_ADDITIVE = '生物添加剂';
      d.thresholds.CARBON_FILTER = 20;
      d.thresholds.BIO_ADDITIVE = 15;
    }),
    [],
  );
  assert.ok(
    run((m) => {
      const d = m.display as Record<string, Record<string, unknown>>;
      d.thresholds.CARBON_FILTER = 10;
    }).some((e) => e.path === 'display.thresholds.CARBON_FILTER' && e.keyword === 'enum'),
  );
  // 缺字段与额外字段被拒绝
  assert.ok(
    run((m) => {
      delete m.display;
    }).some((e) => e.keyword === 'required'),
  );
  assert.ok(
    run((m) => {
      m.extra = 1;
    }).some((e) => e.keyword === 'additionalProperties'),
  );
});

test('x-decision-versions 引用 DEC-008 且版本与决策登记一致；prototype-traceability.yaml 同步', () => {
  const refs: string[] = policyJson['x-decision-versions'];
  const dec008 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-008');
  assert.ok(dec008, '决策登记必须包含 DEC-008');
  assert.ok(refs.includes(`DEC-008@${dec008.version}`), `引用必须包含 DEC-008@${dec008.version}`);
  assert.ok(
    traceabilityYaml.includes(`DEC-008@${dec008.version}`),
    'prototype-traceability.yaml 必须引用 DEC-008 当前登记版本',
  );
  if (dec008.status !== 'frozen') {
    assert.equal(policyJson.status, 'provisional');
    assert.ok(policyJson.policyVersion.startsWith('0.'));
  }
});

test('冻结值定性规则可执行：封闭类型集合、仅设备上报、禁云端臆测', () => {
  assert.deepEqual(getConsumableTypeCodes(), ['CARBON_FILTER', 'BIO_ADDITIVE']);
  assert.equal(isKnownConsumableType('CARBON_FILTER'), true);
  assert.equal(isKnownConsumableType('BIO_ADDITIVE'), true);
  assert.equal(isKnownConsumableType('FILTER'), false);
  assert.equal(getConsumableDataSource(), 'device-reported-only');
  assert.equal(isCloudPercentageDerivationAllowed(), false);
});

test('冻结参数可执行：正式名称、阈值和 24 小时过期规则', () => {
  assert.equal(getConsumableDisplayName('CARBON_FILTER'), '碳滤网');
  assert.equal(getConsumableDisplayName('BIO_ADDITIVE'), '生物添加剂');
  assert.equal(getConsumableThreshold('CARBON_FILTER'), 20);
  assert.equal(getConsumableThreshold('BIO_ADDITIVE'), 15);
  assert.equal(getConsumableStaleAfterHours(), 24);
  // 未知类型优先失败关闭
  assert.throws(
    () => getConsumableDisplayName('FILTER'),
    (e: unknown) => e instanceof UnknownConsumableTypeError,
  );
  assert.throws(
    () => getConsumableThreshold('FILTER'),
    (e: unknown) => e instanceof UnknownConsumableTypeError,
  );
  assert.deepEqual(CONSUMABLES_POLICY.pendingParameters, []);
});

test('策略消费者均为合法任务 ID 且覆盖 DEC-008 阻塞任务', () => {
  const consumers = new Set<string>();
  for (const s of [
    CONSUMABLES_POLICY.types,
    CONSUMABLES_POLICY.dataSource,
    CONSUMABLES_POLICY.display,
    CONSUMABLES_POLICY.freshness,
  ]) {
    assert.ok(s.note.length > 0, '缺少 note');
    assert.ok(s.consumers.length > 0, '缺少 consumers');
    for (const c of s.consumers) {
      assert.ok(TASK_ID.test(c), `消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  const dec008 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-008');
  for (const task of dec008.blockingTasks as string[]) {
    assert.ok(consumers.has(task), `阻塞任务 ${task} 未被策略承接`);
  }
});

test('TS 常量与 consumables-policy.json 完全一致', () => {
  assert.equal(policyJson.policyVersion, CONSUMABLES_POLICY.policyVersion);
  assert.equal(policyJson.status, CONSUMABLES_POLICY.status);
  assert.deepEqual(policyJson.types.codes, [...CONSUMABLES_POLICY.types.codes]);
  assert.equal(policyJson.types.note, CONSUMABLES_POLICY.types.note);
  assert.deepEqual(policyJson.types.consumers, [...CONSUMABLES_POLICY.types.consumers]);
  assert.equal(policyJson.dataSource.mode, CONSUMABLES_POLICY.dataSource.mode);
  assert.equal(policyJson.dataSource.cloudDerivedPercentage, CONSUMABLES_POLICY.dataSource.cloudDerivedPercentage);
  assert.equal(policyJson.dataSource.note, CONSUMABLES_POLICY.dataSource.note);
  assert.deepEqual(policyJson.dataSource.consumers, [...CONSUMABLES_POLICY.dataSource.consumers]);
  assert.deepEqual(policyJson.display.names, CONSUMABLES_POLICY.display.names);
  assert.deepEqual(policyJson.display.thresholds, CONSUMABLES_POLICY.display.thresholds);
  assert.equal(policyJson.display.note, CONSUMABLES_POLICY.display.note);
  assert.deepEqual(policyJson.display.consumers, [...CONSUMABLES_POLICY.display.consumers]);
  assert.equal(policyJson.freshness.staleAfterHours, CONSUMABLES_POLICY.freshness.staleAfterHours);
  assert.equal(policyJson.freshness.note, CONSUMABLES_POLICY.freshness.note);
  assert.deepEqual(policyJson.freshness.consumers, [...CONSUMABLES_POLICY.freshness.consumers]);
  assert.deepEqual(policyJson.pendingParameters, [...CONSUMABLES_POLICY.pendingParameters]);
  assert.equal(policyJson.frozenUpgradePath, CONSUMABLES_POLICY.frozenUpgradePath);
  assert.equal(getConsumablesPolicyStatus(), 'frozen');
});
