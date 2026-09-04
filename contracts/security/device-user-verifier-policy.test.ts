/**
 * DEC-004 Device User 密码验证格式策略测试。
 * 运行：node --test "contracts/security/device-user-verifier-policy.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  DEVICE_USER_VERIFIER_POLICY,
  getVerifierHashBytes,
  getVerifierKdf,
  getVerifierKdfParameters,
  getVerifierMaterialFields,
  getVerifierPolicyStatus,
  getVerifierSaltBytes,
  isCloudHashReuseAllowed,
  isDistributionChannelAllowed,
  isPerUserSaltRequired,
} from './device-user-verifier-policy.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./device-user-verifier-policy.json');
const policySchema = read('./device-user-verifier-policy.schema.json');
const registerJson = read('../decisions/decision-register.json');

const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;

test('策略 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(policySchema, 'device-user-verifier-policy.schema.json', policyJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：复用云端 Hash、非独立 salt 与非法字段被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(policyJson));
    mutate(m);
    return validate(policySchema, 'device-user-verifier-policy.schema.json', m, registry);
  };
  // 复用云端密码 Hash 被拒绝（锁定 false）
  assert.ok(
    run((m) => {
      (m.separation as Record<string, unknown>).cloudHashReuse = true;
    }).some((e) => e.path === 'separation.cloudHashReuse' && e.keyword === 'enum'),
  );
  // 用途锁定 device-local-only
  assert.ok(
    run((m) => {
      (m.separation as Record<string, unknown>).purpose = 'shared';
    }).some((e) => e.path === 'separation.purpose' && e.keyword === 'enum'),
  );
  // 共享 salt 被拒绝（锁定 true）
  assert.ok(
    run((m) => {
      (m.material as Record<string, unknown>).saltPerUser = false;
    }).some((e) => e.path === 'material.saltPerUser' && e.keyword === 'enum'),
  );
  // 冻结参数允许填入（frozen 后合法）
  assert.deepEqual(
    run((m) => {
      const mat = m.material as Record<string, unknown>;
      mat.kdf = 'argon2id';
      mat.kdfParameters = { iterations: 3 };
      mat.saltBytes = 16;
      mat.hashBytes = 32;
    }),
    [],
  );
  // salt/hash 长度过小被拒绝
  assert.ok(
    run((m) => {
      (m.material as Record<string, unknown>).saltBytes = 4;
    }).some((e) => e.path === 'material.saltBytes' && e.keyword === 'minimum'),
  );
  // 缺字段与额外字段被拒绝
  assert.ok(
    run((m) => {
      delete m.pendingParameters;
    }).some((e) => e.keyword === 'required'),
  );
  assert.ok(
    run((m) => {
      m.extra = 1;
    }).some((e) => e.keyword === 'additionalProperties'),
  );
});

test('x-decision-versions 引用 DEC-004 且版本与决策登记一致', () => {
  const refs: string[] = policyJson['x-decision-versions'];
  const dec004 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-004');
  assert.ok(dec004, '决策登记必须包含 DEC-004');
  assert.ok(refs.includes(`DEC-004@${dec004.version}`), `引用必须包含 DEC-004@${dec004.version}`);
  if (dec004.status !== 'frozen') {
    assert.equal(policyJson.status, 'provisional');
    assert.ok(policyJson.policyVersion.startsWith('0.'));
  }
});

test('暂定值定性规则可执行：设备本地专用、禁复用云端 Hash、每用户 salt、仅 Sync 下发', () => {
  assert.equal(DEVICE_USER_VERIFIER_POLICY.separation.purpose, 'device-local-only');
  assert.equal(isCloudHashReuseAllowed(), false);
  assert.equal(isPerUserSaltRequired(), true);
  assert.deepEqual(getVerifierMaterialFields(), ['version', 'kdf', 'salt', 'hash']);
  assert.equal(isDistributionChannelAllowed('SYNC'), true);
  assert.equal(isDistributionChannelAllowed('REST_QUERY'), false);
  assert.equal(isDistributionChannelAllowed('MQTT'), false);
});

test('冻结参数可直接执行：Argon2id PHC、固定参数与长度', () => {
  const mat = DEVICE_USER_VERIFIER_POLICY.material;
  assert.equal(getVerifierKdf(), 'argon2id');
  assert.deepEqual(getVerifierKdfParameters(), {
    version: 19,
    memoryKib: 32768,
    iterations: 3,
    parallelism: 1,
    targetMillisecondsMin: 250,
    targetMillisecondsMax: 500,
  });
  assert.equal(getVerifierSaltBytes(), 16);
  assert.equal(getVerifierHashBytes(), 32);
  assert.equal(mat.encoding, 'phc-string');
  assert.equal(mat.wireField, 'passwordHash');
  assert.deepEqual(DEVICE_USER_VERIFIER_POLICY.pendingParameters, []);
});

test('策略消费者均为合法任务 ID 且覆盖 DEC-004 阻塞任务', () => {
  const consumers = new Set<string>();
  for (const s of [
    DEVICE_USER_VERIFIER_POLICY.separation,
    DEVICE_USER_VERIFIER_POLICY.material,
    DEVICE_USER_VERIFIER_POLICY.distribution,
  ]) {
    assert.ok(s.note.length > 0, '缺少 note');
    assert.ok(s.consumers.length > 0, '缺少 consumers');
    for (const c of s.consumers) {
      assert.ok(TASK_ID.test(c), `消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  const dec004 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-004');
  for (const task of dec004.blockingTasks as string[]) {
    assert.ok(consumers.has(task), `阻塞任务 ${task} 未被策略承接`);
  }
});

test('TS 常量与 device-user-verifier-policy.json 完全一致', () => {
  assert.equal(policyJson.policyVersion, DEVICE_USER_VERIFIER_POLICY.policyVersion);
  assert.equal(policyJson.status, DEVICE_USER_VERIFIER_POLICY.status);
  assert.equal(policyJson.separation.purpose, DEVICE_USER_VERIFIER_POLICY.separation.purpose);
  assert.equal(policyJson.separation.cloudHashReuse, DEVICE_USER_VERIFIER_POLICY.separation.cloudHashReuse);
  assert.equal(policyJson.separation.note, DEVICE_USER_VERIFIER_POLICY.separation.note);
  assert.deepEqual(policyJson.separation.consumers, [...DEVICE_USER_VERIFIER_POLICY.separation.consumers]);
  assert.deepEqual(policyJson.material.fields, [...DEVICE_USER_VERIFIER_POLICY.material.fields]);
  assert.equal(policyJson.material.kdf, DEVICE_USER_VERIFIER_POLICY.material.kdf);
  assert.deepEqual(policyJson.material.kdfParameters, DEVICE_USER_VERIFIER_POLICY.material.kdfParameters);
  assert.equal(policyJson.material.encoding, DEVICE_USER_VERIFIER_POLICY.material.encoding);
  assert.equal(policyJson.material.wireField, DEVICE_USER_VERIFIER_POLICY.material.wireField);
  assert.equal(policyJson.material.saltBytes, DEVICE_USER_VERIFIER_POLICY.material.saltBytes);
  assert.equal(policyJson.material.hashBytes, DEVICE_USER_VERIFIER_POLICY.material.hashBytes);
  assert.equal(policyJson.material.saltPerUser, DEVICE_USER_VERIFIER_POLICY.material.saltPerUser);
  assert.equal(policyJson.material.note, DEVICE_USER_VERIFIER_POLICY.material.note);
  assert.deepEqual(policyJson.material.consumers, [...DEVICE_USER_VERIFIER_POLICY.material.consumers]);
  assert.deepEqual(policyJson.distribution.channels, [...DEVICE_USER_VERIFIER_POLICY.distribution.channels]);
  assert.equal(policyJson.distribution.note, DEVICE_USER_VERIFIER_POLICY.distribution.note);
  assert.deepEqual(policyJson.distribution.consumers, [...DEVICE_USER_VERIFIER_POLICY.distribution.consumers]);
  assert.deepEqual(policyJson.pendingParameters, [...DEVICE_USER_VERIFIER_POLICY.pendingParameters]);
  assert.equal(policyJson.frozenUpgradePath, DEVICE_USER_VERIFIER_POLICY.frozenUpgradePath);
  assert.equal(getVerifierPolicyStatus(), 'frozen');
});
