/**
 * DEC-007 Contract 与 License 关系策略测试。
 * 运行：node --test "contracts/domain/contract-license-relation.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  CONTRACT_LICENSE_RELATION,
  doesContractCreateActivateLicense,
  doesContractUnbindRevokeLicense,
  getContractScope,
  getLicenseScope,
  getRelationPolicyStatus,
  getScopeOwner,
  isContractStatusIndependentOfLicense,
} from './contract-license-relation.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./contract-license-relation.json');
const policySchema = read('./contract-license-relation.schema.json');
const registerJson = read('../decisions/decision-register.json');
const traceabilityYaml = readFileSync(new URL('../prototype-traceability.yaml', import.meta.url), 'utf8');

const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;

test('策略 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(policySchema, 'contract-license-relation.schema.json', policyJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：联动规则反转与缺失字段被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(policyJson));
    mutate(m);
    return validate(policySchema, 'contract-license-relation.schema.json', m, registry);
  };
  // 创建自动激活被拒绝（锁定 false）
  assert.ok(run((m) => { (m.linkage as Record<string, unknown>).contractCreateActivatesLicense = true; }).some((e) => e.path === 'linkage.contractCreateActivatesLicense' && e.keyword === 'enum'));
  // 解绑自动撤销被拒绝（锁定 false）
  assert.ok(run((m) => { (m.linkage as Record<string, unknown>).contractUnbindRevokesLicense = true; }).some((e) => e.path === 'linkage.contractUnbindRevokesLicense' && e.keyword === 'enum'));
  // 状态混同展示被拒绝（锁定 true）
  assert.ok(run((m) => { (m.presentation as Record<string, unknown>).contractStatusIndependentOfLicense = false; }).some((e) => e.path === 'presentation.contractStatusIndependentOfLicense' && e.keyword === 'enum'));
  // 缺字段与额外字段被拒绝
  assert.ok(run((m) => { delete m.ownership; }).some((e) => e.keyword === 'required'));
  assert.ok(run((m) => { m.extra = 1; }).some((e) => e.keyword === 'additionalProperties'));
});

test('x-decision-versions 引用 DEC-007 且版本与决策登记一致；prototype-traceability.yaml 同步', () => {
  const refs: string[] = policyJson['x-decision-versions'];
  const dec007 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-007');
  assert.ok(dec007, '决策登记必须包含 DEC-007');
  assert.ok(refs.includes(`DEC-007@${dec007.version}`), `引用必须包含 DEC-007@${dec007.version}`);
  assert.ok(traceabilityYaml.includes(`DEC-007@${dec007.version}`), 'prototype-traceability.yaml 必须引用 DEC-007 当前登记版本');
  if (dec007.status !== 'frozen') {
    assert.equal(policyJson.status, 'provisional');
    assert.ok(policyJson.policyVersion.startsWith('0.'));
  }
});

test('暂定值定性规则可执行：职责划分、联动与展示', () => {
  assert.deepEqual(getContractScope(), ['commercial-lease-term', 'device-association']);
  assert.deepEqual(getLicenseScope(), ['device-capability-authorization']);
  assert.equal(getScopeOwner('commercial-lease-term'), 'contract');
  assert.equal(getScopeOwner('device-association'), 'contract');
  assert.equal(getScopeOwner('device-capability-authorization'), 'license');
  assert.equal(getScopeOwner('unknown-scope'), null);
  assert.equal(doesContractCreateActivateLicense(), false);
  assert.equal(doesContractUnbindRevokeLicense(), false);
  assert.equal(isContractStatusIndependentOfLicense(), true);
});

test('策略消费者均为合法任务 ID 且覆盖 DEC-007 阻塞任务与关联任务', () => {
  const consumers = new Set<string>();
  for (const s of [CONTRACT_LICENSE_RELATION.ownership, CONTRACT_LICENSE_RELATION.linkage, CONTRACT_LICENSE_RELATION.presentation]) {
    assert.ok(s.note.length > 0, '缺少 note');
    assert.ok(s.consumers.length > 0, '缺少 consumers');
    for (const c of s.consumers) {
      assert.ok(TASK_ID.test(c), `消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  const dec007 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-007');
  for (const task of dec007.blockingTasks as string[]) {
    assert.ok(consumers.has(task), `阻塞任务 ${task} 未被策略承接`);
  }
  assert.ok(consumers.has('BE-LIC-01'), 'BE-LIC-01（License 域）必须被策略承接');
  assert.ok(consumers.has('DOM-03'), 'DOM-03（Contract/License 状态机）必须被策略承接');
});

test('TS 常量与 contract-license-relation.json 完全一致', () => {
  assert.equal(policyJson.policyVersion, CONTRACT_LICENSE_RELATION.policyVersion);
  assert.equal(policyJson.status, CONTRACT_LICENSE_RELATION.status);
  assert.deepEqual(policyJson.ownership.contractScope, [...CONTRACT_LICENSE_RELATION.ownership.contractScope]);
  assert.deepEqual(policyJson.ownership.licenseScope, [...CONTRACT_LICENSE_RELATION.ownership.licenseScope]);
  assert.equal(policyJson.ownership.note, CONTRACT_LICENSE_RELATION.ownership.note);
  assert.deepEqual(policyJson.ownership.consumers, [...CONTRACT_LICENSE_RELATION.ownership.consumers]);
  assert.equal(policyJson.linkage.contractCreateActivatesLicense, CONTRACT_LICENSE_RELATION.linkage.contractCreateActivatesLicense);
  assert.equal(policyJson.linkage.contractUnbindRevokesLicense, CONTRACT_LICENSE_RELATION.linkage.contractUnbindRevokesLicense);
  assert.equal(policyJson.linkage.note, CONTRACT_LICENSE_RELATION.linkage.note);
  assert.deepEqual(policyJson.linkage.consumers, [...CONTRACT_LICENSE_RELATION.linkage.consumers]);
  assert.equal(policyJson.presentation.contractStatusIndependentOfLicense, CONTRACT_LICENSE_RELATION.presentation.contractStatusIndependentOfLicense);
  assert.equal(policyJson.presentation.note, CONTRACT_LICENSE_RELATION.presentation.note);
  assert.deepEqual(policyJson.presentation.consumers, [...CONTRACT_LICENSE_RELATION.presentation.consumers]);
  assert.deepEqual(policyJson.pendingParameters, [...CONTRACT_LICENSE_RELATION.pendingParameters]);
  assert.equal(policyJson.frozenUpgradePath, CONTRACT_LICENSE_RELATION.frozenUpgradePath);
  assert.equal(getRelationPolicyStatus(), 'provisional');
});
