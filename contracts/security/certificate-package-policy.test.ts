/**
 * DEC-003 一次性证书包领取策略测试。
 * 运行：node --test "contracts/security/certificate-package-policy.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  CERTIFICATE_PACKAGE_POLICY,
  getLossHandlingMode,
  getMaxClaims,
  getPolicyStatus,
  getRetentionSeconds,
  getStorageEncryption,
  isDestructionTrigger,
  isOneTimeClaim,
  isRepeatClaimAllowed,
} from './certificate-package-policy.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./certificate-package-policy.json');
const policySchema = read('./certificate-package-policy.schema.json');
const registerJson = read('../decisions/decision-register.json');

const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;

test('策略 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(policySchema, 'certificate-package-policy.schema.json', policyJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：非法枚举、非空待冻结参数与缺失字段被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(policyJson));
    mutate(m);
    return validate(policySchema, 'certificate-package-policy.schema.json', m, registry);
  };
  // 非 KMS 信封加密被拒绝
  assert.ok(
    run((m) => {
      (m.storage as Record<string, unknown>).encryption = 'plaintext';
    }).some((e) => e.path === 'storage.encryption' && e.keyword === 'enum'),
  );
  // 非一次性领取被拒绝
  assert.ok(
    run((m) => {
      (m.claim as Record<string, unknown>).oneTime = false;
    }).some((e) => e.path === 'claim.oneTime' && e.keyword === 'enum'),
  );
  // 成功领取后不销毁被拒绝
  assert.ok(
    run((m) => {
      (m.claim as Record<string, unknown>).destroyOnSuccessfulClaim = false;
    }).some((e) => e.path === 'claim.destroyOnSuccessfulClaim' && e.keyword === 'enum'),
  );
  // 丢失处置非 reissue 被拒绝
  assert.ok(
    run((m) => {
      (m.lossHandling as Record<string, unknown>).mode = 'recover';
    }).some((e) => e.path === 'lossHandling.mode' && e.keyword === 'enum'),
  );
  // 冻结参数允许填入整数（frozen 后合法）
  assert.deepEqual(
    run((m) => {
      (m.storage as Record<string, unknown>).retentionSeconds = 900;
      (m.claim as Record<string, unknown>).maxClaims = 1;
    }),
    [],
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

test('x-decision-versions 引用 DEC-003 且版本与决策登记一致', () => {
  const refs: string[] = policyJson['x-decision-versions'];
  const dec003 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-003');
  assert.ok(dec003, '决策登记必须包含 DEC-003');
  assert.ok(refs.includes(`DEC-003@${dec003.version}`), `引用必须包含 DEC-003@${dec003.version}`);
  if (dec003.status !== 'frozen') {
    assert.equal(policyJson.status, 'provisional');
    assert.ok(policyJson.policyVersion.startsWith('0.'));
  }
});

test('暂定值定性规则可执行：KMS 信封、一次性领取、成功即销毁、丢失重签', () => {
  assert.equal(getStorageEncryption(), 'kms-envelope');
  assert.equal(CERTIFICATE_PACKAGE_POLICY.storage.retention, 'short-term');
  assert.equal(isOneTimeClaim(), true);
  assert.equal(getLossHandlingMode(), 'reissue');
  assert.equal(isDestructionTrigger('SUCCESSFUL_CLAIM'), true);
  assert.equal(isDestructionTrigger('NEW_CERTIFICATE_FIRST_HEARTBEAT'), true);
  assert.equal(isDestructionTrigger('MANUAL_DELETE'), false);
});

test('冻结参数可直接执行：24 小时、一次成功领取、无待定参数', () => {
  assert.equal(CERTIFICATE_PACKAGE_POLICY.storage.retentionSeconds, 86400);
  assert.equal(CERTIFICATE_PACKAGE_POLICY.claim.maxClaims, 1);
  assert.equal(getRetentionSeconds(), 86400);
  assert.equal(getMaxClaims(), 1);
  assert.equal(isRepeatClaimAllowed(), false);
  assert.deepEqual(CERTIFICATE_PACKAGE_POLICY.pendingParameters, []);
});

test('策略消费者均为合法任务 ID 且覆盖 DEC-003 阻塞任务与 SEC-01', () => {
  const consumers = new Set<string>();
  const sections = [
    CERTIFICATE_PACKAGE_POLICY.storage,
    CERTIFICATE_PACKAGE_POLICY.claim,
    CERTIFICATE_PACKAGE_POLICY.lossHandling,
    CERTIFICATE_PACKAGE_POLICY.destructionTriggers,
  ];
  for (const s of sections) {
    assert.ok(s.note.length > 0, '缺少 note');
    assert.ok(s.consumers.length > 0, '缺少 consumers');
    for (const c of s.consumers) {
      assert.ok(TASK_ID.test(c), `消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  const dec003 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-003');
  for (const task of dec003.blockingTasks as string[]) {
    assert.ok(consumers.has(task), `阻塞任务 ${task} 未被策略承接`);
  }
  assert.ok(consumers.has('SEC-01'), 'SEC-01（依赖 DEC-003）必须被策略承接');
});

test('TS 常量与 certificate-package-policy.json 完全一致', () => {
  assert.equal(policyJson.policyVersion, CERTIFICATE_PACKAGE_POLICY.policyVersion);
  assert.equal(policyJson.status, CERTIFICATE_PACKAGE_POLICY.status);
  assert.equal(policyJson.storage.encryption, CERTIFICATE_PACKAGE_POLICY.storage.encryption);
  assert.equal(policyJson.storage.retention, CERTIFICATE_PACKAGE_POLICY.storage.retention);
  assert.equal(policyJson.storage.retentionSeconds, CERTIFICATE_PACKAGE_POLICY.storage.retentionSeconds);
  assert.equal(policyJson.storage.note, CERTIFICATE_PACKAGE_POLICY.storage.note);
  assert.deepEqual(policyJson.storage.consumers, [...CERTIFICATE_PACKAGE_POLICY.storage.consumers]);
  assert.equal(policyJson.claim.oneTime, CERTIFICATE_PACKAGE_POLICY.claim.oneTime);
  assert.equal(policyJson.claim.maxClaims, CERTIFICATE_PACKAGE_POLICY.claim.maxClaims);
  assert.equal(policyJson.claim.destroyOnSuccessfulClaim, CERTIFICATE_PACKAGE_POLICY.claim.destroyOnSuccessfulClaim);
  assert.equal(policyJson.claim.note, CERTIFICATE_PACKAGE_POLICY.claim.note);
  assert.deepEqual(policyJson.claim.consumers, [...CERTIFICATE_PACKAGE_POLICY.claim.consumers]);
  assert.equal(policyJson.lossHandling.mode, CERTIFICATE_PACKAGE_POLICY.lossHandling.mode);
  assert.equal(policyJson.lossHandling.note, CERTIFICATE_PACKAGE_POLICY.lossHandling.note);
  assert.deepEqual(policyJson.lossHandling.consumers, [...CERTIFICATE_PACKAGE_POLICY.lossHandling.consumers]);
  assert.deepEqual(policyJson.destructionTriggers.triggers, [
    ...CERTIFICATE_PACKAGE_POLICY.destructionTriggers.triggers,
  ]);
  assert.equal(policyJson.destructionTriggers.note, CERTIFICATE_PACKAGE_POLICY.destructionTriggers.note);
  assert.deepEqual(policyJson.destructionTriggers.consumers, [
    ...CERTIFICATE_PACKAGE_POLICY.destructionTriggers.consumers,
  ]);
  assert.deepEqual(policyJson.pendingParameters, [...CERTIFICATE_PACKAGE_POLICY.pendingParameters]);
  assert.equal(policyJson.frozenUpgradePath, CERTIFICATE_PACKAGE_POLICY.frozenUpgradePath);
  assert.equal(getPolicyStatus(), 'frozen');
});
