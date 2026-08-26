/**
 * DEC-012 原型角色映射策略测试。
 * 运行：node --test "contracts/domain/role-mapping-policy.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  ROLE_MAPPING_POLICY,
  arePrototypeCheckboxesReadonly,
  getRoleMappingPolicyStatus,
  getRoleUiName,
  getSystemRoles,
  isKnownSystemRole,
  isPermissionMatrixFixed,
  mapPrototypeRole,
  roleHasAwsResourceAccess,
} from './role-mapping-policy.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./role-mapping-policy.json');
const policySchema = read('./role-mapping-policy.schema.json');
const registerJson = read('../decisions/decision-register.json');
const traceabilityYaml = readFileSync(new URL('../prototype-traceability.yaml', import.meta.url), 'utf8');

const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;

test('策略 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(policySchema, 'role-mapping-policy.schema.json', policyJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：AWS 授权、矩阵可编辑与缺失字段被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(policyJson));
    mutate(m);
    return validate(policySchema, 'role-mapping-policy.schema.json', m, registry);
  };
  // Operator 授予 AWS 资源权限被拒绝（锁定 false）
  assert.ok(run((m) => { (m.awsPermissions as Record<string, unknown>).operatorGetsAwsResourceAccess = true; }).some((e) => e.path === 'awsPermissions.operatorGetsAwsResourceAccess' && e.keyword === 'enum'));
  // 权限矩阵可编辑被拒绝（锁定 true）
  assert.ok(run((m) => { (m.matrix as Record<string, unknown>).permissionMatrixFixed = false; }).some((e) => e.path === 'matrix.permissionMatrixFixed' && e.keyword === 'enum'));
  // 复选框可编辑被拒绝（锁定 true）
  assert.ok(run((m) => { (m.matrix as Record<string, unknown>).prototypeCheckboxesReadonly = false; }).some((e) => e.path === 'matrix.prototypeCheckboxesReadonly' && e.keyword === 'enum'));
  // 缺字段与额外字段被拒绝
  assert.ok(run((m) => { delete m.roleMappings; }).some((e) => e.keyword === 'required'));
  assert.ok(run((m) => { m.extra = 1; }).some((e) => e.keyword === 'additionalProperties'));
});

test('x-decision-versions 引用 DEC-012 且版本与决策登记一致；prototype-traceability.yaml 同步', () => {
  const refs: string[] = policyJson['x-decision-versions'];
  const dec012 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-012');
  assert.ok(dec012, '决策登记必须包含 DEC-012');
  assert.ok(refs.includes(`DEC-012@${dec012.version}`), `引用必须包含 DEC-012@${dec012.version}`);
  assert.ok(traceabilityYaml.includes(`DEC-012@${dec012.version}`), 'prototype-traceability.yaml 必须引用 DEC-012 当前登记版本');
  if (dec012.status !== 'frozen') {
    assert.equal(policyJson.status, 'provisional');
    assert.ok(policyJson.policyVersion.startsWith('0.'));
  }
});

test('暂定值定性规则可执行：封闭映射、界面名、AWS 权限与矩阵规则', () => {
  const admin = mapPrototypeRole('平台管理员');
  assert.deepEqual(admin, { prototypeRole: '平台管理员', systemRole: 'PlatformSuperAdmin', uiName: '平台管理员' });
  const operator = mapPrototypeRole('运维人员');
  assert.deepEqual(operator, { prototypeRole: '运维人员', systemRole: 'PlatformOperator', uiName: '设备操作员' });
  assert.equal(mapPrototypeRole('客户管理员'), null);
  assert.equal(getRoleUiName('PlatformOperator'), '设备操作员');
  assert.equal(getRoleUiName('PlatformSuperAdmin'), '平台管理员');
  assert.equal(getRoleUiName('Unknown'), null);
  assert.deepEqual(getSystemRoles(), ['PlatformSuperAdmin', 'PlatformOperator']);
  assert.equal(isKnownSystemRole('PlatformOperator'), true);
  assert.equal(isKnownSystemRole('TenantAdmin'), false);
  assert.equal(roleHasAwsResourceAccess('PlatformOperator'), false);
  assert.equal(roleHasAwsResourceAccess('Unknown'), false);
  assert.equal(isPermissionMatrixFixed(), true);
  assert.equal(arePrototypeCheckboxesReadonly(), true);
});

test('策略消费者均为合法任务 ID 且覆盖 DEC-012 阻塞任务', () => {
  const consumers = new Set<string>();
  for (const s of [ROLE_MAPPING_POLICY.roleMappings, ROLE_MAPPING_POLICY.awsPermissions, ROLE_MAPPING_POLICY.matrix]) {
    assert.ok(s.note.length > 0, '缺少 note');
    assert.ok(s.consumers.length > 0, '缺少 consumers');
    for (const c of s.consumers) {
      assert.ok(TASK_ID.test(c), `消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  const dec012 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-012');
  for (const task of dec012.blockingTasks as string[]) {
    assert.ok(consumers.has(task), `阻塞任务 ${task} 未被策略承接`);
  }
});

test('TS 常量与 role-mapping-policy.json 完全一致', () => {
  assert.equal(policyJson.policyVersion, ROLE_MAPPING_POLICY.policyVersion);
  assert.equal(policyJson.status, ROLE_MAPPING_POLICY.status);
  assert.deepEqual(policyJson.roleMappings.mappings, [...ROLE_MAPPING_POLICY.roleMappings.mappings]);
  assert.equal(policyJson.roleMappings.note, ROLE_MAPPING_POLICY.roleMappings.note);
  assert.deepEqual(policyJson.roleMappings.consumers, [...ROLE_MAPPING_POLICY.roleMappings.consumers]);
  assert.equal(policyJson.awsPermissions.operatorGetsAwsResourceAccess, ROLE_MAPPING_POLICY.awsPermissions.operatorGetsAwsResourceAccess);
  assert.equal(policyJson.awsPermissions.note, ROLE_MAPPING_POLICY.awsPermissions.note);
  assert.deepEqual(policyJson.awsPermissions.consumers, [...ROLE_MAPPING_POLICY.awsPermissions.consumers]);
  assert.equal(policyJson.matrix.permissionMatrixFixed, ROLE_MAPPING_POLICY.matrix.permissionMatrixFixed);
  assert.equal(policyJson.matrix.prototypeCheckboxesReadonly, ROLE_MAPPING_POLICY.matrix.prototypeCheckboxesReadonly);
  assert.equal(policyJson.matrix.note, ROLE_MAPPING_POLICY.matrix.note);
  assert.deepEqual(policyJson.matrix.consumers, [...ROLE_MAPPING_POLICY.matrix.consumers]);
  assert.deepEqual(policyJson.pendingParameters, [...ROLE_MAPPING_POLICY.pendingParameters]);
  assert.equal(policyJson.frozenUpgradePath, ROLE_MAPPING_POLICY.frozenUpgradePath);
  assert.equal(getRoleMappingPolicyStatus(), 'provisional');
});
