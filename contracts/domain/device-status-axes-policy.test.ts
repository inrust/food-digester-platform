/**
 * DEC-010 原型设备状态映射策略测试。
 * 运行：node --test "contracts/domain/device-status-axes-policy.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  DEVICE_STATUS_AXES_POLICY,
  getDeviceStatusAxes,
  getEnabledDerivationRule,
  getStatusAxesPolicyStatus,
  isEnabledDisplayAvailable,
  isEnabledDisplayDerived,
  isEnabledStoredAsField,
  isKnownStatusAxis,
  isSingleFieldStatusMixingForbidden,
} from './device-status-axes-policy.ts';
import { PolicyParameterPendingError } from '../security/certificate-package-policy.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./device-status-axes-policy.json');
const policySchema = read('./device-status-axes-policy.schema.json');
const registerJson = read('../decisions/decision-register.json');
const traceabilityYaml = readFileSync(new URL('../prototype-traceability.yaml', import.meta.url), 'utf8');

const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;

test('策略 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(policySchema, 'device-status-axes-policy.schema.json', policyJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：单字段混用、独立存储"启用"与缺失字段被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(policyJson));
    mutate(m);
    return validate(policySchema, 'device-status-axes-policy.schema.json', m, registry);
  };
  // 单字段混用被拒绝（锁定 false）
  assert.ok(run((m) => { (m.axes as Record<string, unknown>).singleFieldMixing = true; }).some((e) => e.path === 'axes.singleFieldMixing' && e.keyword === 'enum'));
  // "启用"作为存储字段被拒绝（锁定 false）
  assert.ok(run((m) => { (m.enabledDisplay as Record<string, unknown>).storedAsField = true; }).some((e) => e.path === 'enabledDisplay.storedAsField' && e.keyword === 'enum'));
  // 非派生被拒绝（锁定 true）
  assert.ok(run((m) => { (m.enabledDisplay as Record<string, unknown>).derived = false; }).some((e) => e.path === 'enabledDisplay.derived' && e.keyword === 'enum'));
  // 冻结参数允许填入（frozen 后合法）
  assert.deepEqual(run((m) => { (m.enabledDisplay as Record<string, unknown>).rule = 'lifecycle=ACTIVE && license=VALID'; }), []);
  // 缺字段与额外字段被拒绝
  assert.ok(run((m) => { delete m.axes; }).some((e) => e.keyword === 'required'));
  assert.ok(run((m) => { m.extra = 1; }).some((e) => e.keyword === 'additionalProperties'));
});

test('x-decision-versions 引用 DEC-010 且版本与决策登记一致；prototype-traceability.yaml 同步', () => {
  const refs: string[] = policyJson['x-decision-versions'];
  const dec010 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-010');
  assert.ok(dec010, '决策登记必须包含 DEC-010');
  assert.ok(refs.includes(`DEC-010@${dec010.version}`), `引用必须包含 DEC-010@${dec010.version}`);
  assert.ok(traceabilityYaml.includes(`DEC-010@${dec010.version}`), 'prototype-traceability.yaml 必须引用 DEC-010 当前登记版本');
  if (dec010.status !== 'frozen') {
    assert.equal(policyJson.status, 'provisional');
    assert.ok(policyJson.policyVersion.startsWith('0.'));
  }
});

test('暂定值定性规则可执行：四轴分离、禁单字段混用、派生原则', () => {
  assert.deepEqual(getDeviceStatusAxes(), ['connectivity', 'lifecycle', 'operational', 'license']);
  assert.equal(isKnownStatusAxis('connectivity'), true);
  assert.equal(isKnownStatusAxis('enabled'), false);
  assert.equal(isSingleFieldStatusMixingForbidden(), true);
  assert.equal(isEnabledDisplayDerived(), true);
  assert.equal(isEnabledStoredAsField(), false);
});

test('待冻结参数失败关闭：派生规则禁止臆测', () => {
  assert.equal(DEVICE_STATUS_AXES_POLICY.enabledDisplay.rule, null);
  assert.throws(
    () => getEnabledDerivationRule(),
    (e: unknown) => e instanceof PolicyParameterPendingError && (e as PolicyParameterPendingError).parameter === 'enabledDisplay.rule'
  );
  // 冻结前禁止输出 enabled 字段
  assert.equal(isEnabledDisplayAvailable(), false);
  assert.deepEqual([...DEVICE_STATUS_AXES_POLICY.pendingParameters], ['enabledDisplay.rule']);
});

test('策略消费者均为合法任务 ID 且覆盖 DEC-010 阻塞任务与关联任务', () => {
  const consumers = new Set<string>();
  for (const s of [DEVICE_STATUS_AXES_POLICY.axes, DEVICE_STATUS_AXES_POLICY.enabledDisplay]) {
    assert.ok(s.note.length > 0, '缺少 note');
    assert.ok(s.consumers.length > 0, '缺少 consumers');
    for (const c of s.consumers) {
      assert.ok(TASK_ID.test(c), `消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  const dec010 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-010');
  for (const task of dec010.blockingTasks as string[]) {
    assert.ok(consumers.has(task), `阻塞任务 ${task} 未被策略承接`);
  }
  assert.ok(consumers.has('DOM-01'), 'DOM-01（设备状态机）必须被策略承接');
  assert.ok(consumers.has('DOM-03'), 'DOM-03（状态派生）必须被策略承接');
});

test('TS 常量与 device-status-axes-policy.json 完全一致', () => {
  assert.equal(policyJson.policyVersion, DEVICE_STATUS_AXES_POLICY.policyVersion);
  assert.equal(policyJson.status, DEVICE_STATUS_AXES_POLICY.status);
  assert.deepEqual(policyJson.axes.list, [...DEVICE_STATUS_AXES_POLICY.axes.list]);
  assert.equal(policyJson.axes.singleFieldMixing, DEVICE_STATUS_AXES_POLICY.axes.singleFieldMixing);
  assert.equal(policyJson.axes.note, DEVICE_STATUS_AXES_POLICY.axes.note);
  assert.deepEqual(policyJson.axes.consumers, [...DEVICE_STATUS_AXES_POLICY.axes.consumers]);
  assert.equal(policyJson.enabledDisplay.derived, DEVICE_STATUS_AXES_POLICY.enabledDisplay.derived);
  assert.equal(policyJson.enabledDisplay.storedAsField, DEVICE_STATUS_AXES_POLICY.enabledDisplay.storedAsField);
  assert.equal(policyJson.enabledDisplay.rule, DEVICE_STATUS_AXES_POLICY.enabledDisplay.rule);
  assert.equal(policyJson.enabledDisplay.note, DEVICE_STATUS_AXES_POLICY.enabledDisplay.note);
  assert.deepEqual(policyJson.enabledDisplay.consumers, [...DEVICE_STATUS_AXES_POLICY.enabledDisplay.consumers]);
  assert.deepEqual(policyJson.pendingParameters, [...DEVICE_STATUS_AXES_POLICY.pendingParameters]);
  assert.equal(policyJson.frozenUpgradePath, DEVICE_STATUS_AXES_POLICY.frozenUpgradePath);
  assert.equal(getStatusAxesPolicyStatus(), 'provisional');
});
