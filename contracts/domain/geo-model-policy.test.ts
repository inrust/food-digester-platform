/**
 * DEC-011 Region/Subregion/Site 模型策略测试。
 * 运行：node --test "contracts/domain/geo-model-policy.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  GEO_MODEL_POLICY,
  doesDeviceStoreGeoTruth,
  getDeviceAssociationTarget,
  getGeoHierarchy,
  getGeoPolicyStatus,
  getSiteGeoAttributes,
  isSiteGeoAttribute,
} from './geo-model-policy.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./geo-model-policy.json');
const policySchema = read('./geo-model-policy.schema.json');
const registerJson = read('../decisions/decision-register.json');
const traceabilityYaml = readFileSync(new URL('../prototype-traceability.yaml', import.meta.url), 'utf8');

const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;

test('策略 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(policySchema, 'geo-model-policy.schema.json', policyJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：设备地域真值与缺失字段被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(policyJson));
    mutate(m);
    return validate(policySchema, 'geo-model-policy.schema.json', m, registry);
  };
  // 设备保存地域真值被拒绝（锁定 false）
  assert.ok(
    run((m) => {
      (m.geoAttributes as Record<string, unknown>).deviceStoresGeoTruth = true;
    }).some((e) => e.path === 'geoAttributes.deviceStoresGeoTruth' && e.keyword === 'enum'),
  );
  // 缺字段与额外字段被拒绝
  assert.ok(
    run((m) => {
      delete m.hierarchy;
    }).some((e) => e.keyword === 'required'),
  );
  assert.ok(
    run((m) => {
      m.extra = 1;
    }).some((e) => e.keyword === 'additionalProperties'),
  );
});

test('x-decision-versions 引用 DEC-011 且版本与决策登记一致；prototype-traceability.yaml 同步', () => {
  const refs: string[] = policyJson['x-decision-versions'];
  const dec011 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-011');
  assert.ok(dec011, '决策登记必须包含 DEC-011');
  assert.ok(refs.includes(`DEC-011@${dec011.version}`), `引用必须包含 DEC-011@${dec011.version}`);
  assert.ok(
    traceabilityYaml.includes(`DEC-011@${dec011.version}`),
    'prototype-traceability.yaml 必须引用 DEC-011 当前登记版本',
  );
  if (dec011.status !== 'frozen') {
    assert.equal(policyJson.status, 'provisional');
    assert.ok(policyJson.policyVersion.startsWith('0.'));
  }
});

test('冻结值定性规则可执行：层级链、Site 属性、设备仅关联 Site', () => {
  assert.deepEqual(getGeoHierarchy(), ['customer', 'site', 'device']);
  assert.deepEqual(getSiteGeoAttributes(), ['region', 'subregion']);
  assert.equal(isSiteGeoAttribute('region'), true);
  assert.equal(isSiteGeoAttribute('subregion'), true);
  assert.equal(isSiteGeoAttribute('country'), false);
  assert.equal(getDeviceAssociationTarget(), 'site');
  assert.equal(doesDeviceStoreGeoTruth(), false);
});

test('策略消费者均为合法任务 ID 且覆盖 DEC-011 阻塞任务', () => {
  const consumers = new Set<string>();
  for (const s of [GEO_MODEL_POLICY.hierarchy, GEO_MODEL_POLICY.geoAttributes]) {
    assert.ok(s.note.length > 0, '缺少 note');
    assert.ok(s.consumers.length > 0, '缺少 consumers');
    for (const c of s.consumers) {
      assert.ok(TASK_ID.test(c), `消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  const dec011 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-011');
  for (const task of dec011.blockingTasks as string[]) {
    assert.ok(consumers.has(task), `阻塞任务 ${task} 未被策略承接`);
  }
});

test('TS 常量与 geo-model-policy.json 完全一致', () => {
  assert.equal(policyJson.policyVersion, GEO_MODEL_POLICY.policyVersion);
  assert.equal(policyJson.status, GEO_MODEL_POLICY.status);
  assert.deepEqual(policyJson.hierarchy.chain, [...GEO_MODEL_POLICY.hierarchy.chain]);
  assert.equal(policyJson.hierarchy.note, GEO_MODEL_POLICY.hierarchy.note);
  assert.deepEqual(policyJson.hierarchy.consumers, [...GEO_MODEL_POLICY.hierarchy.consumers]);
  assert.deepEqual(policyJson.geoAttributes.siteAttributes, [...GEO_MODEL_POLICY.geoAttributes.siteAttributes]);
  assert.equal(policyJson.geoAttributes.deviceStoresGeoTruth, GEO_MODEL_POLICY.geoAttributes.deviceStoresGeoTruth);
  assert.equal(policyJson.geoAttributes.note, GEO_MODEL_POLICY.geoAttributes.note);
  assert.deepEqual(policyJson.geoAttributes.consumers, [...GEO_MODEL_POLICY.geoAttributes.consumers]);
  assert.deepEqual(policyJson.pendingParameters, [...GEO_MODEL_POLICY.pendingParameters]);
  assert.equal(policyJson.frozenUpgradePath, GEO_MODEL_POLICY.frozenUpgradePath);
  assert.equal(getGeoPolicyStatus(), 'frozen');
});
