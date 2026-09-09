/**
 * OTA 固件包签名策略测试。
 * 运行：node --test "contracts/security/ota-package-signature-policy.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { constants, verify } from 'node:crypto';
import {
  OTA_PACKAGE_SIGNATURE_POLICY,
  getOtaSignatureAlgorithm,
  getOtaSignatureEncoding,
  getOtaSignaturePayloadFields,
  getOtaSignaturePolicyStatus,
  getOtaSignatureTrustRoot,
  isEmbeddedTrustRootAllowed,
  isServerSideSignatureVerificationRequired,
  isSignatureVerificationFailClosed,
} from './ota-package-signature-policy.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./ota-package-signature-policy.json');
const policySchema = read('./ota-package-signature-policy.schema.json');
const vector = read('./fixtures/ota-signature-vector.json');

const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;

test('策略 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(policySchema, 'ota-package-signature-policy.schema.json', policyJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：跳过服务端验签、非失败关闭与内嵌信任根被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(policyJson));
    mutate(m);
    return validate(policySchema, 'ota-package-signature-policy.schema.json', m, registry);
  };
  // 跳过服务端验签被拒绝（锁定 true）
  assert.ok(
    run((m) => {
      (m.verification as Record<string, unknown>).serverSide = false;
    }).some((e) => e.path === 'verification.serverSide' && e.keyword === 'enum'),
  );
  // 非失败关闭被拒绝（锁定 true）
  assert.ok(
    run((m) => {
      (m.verification as Record<string, unknown>).failClosed = false;
    }).some((e) => e.path === 'verification.failClosed' && e.keyword === 'enum'),
  );
  // 内嵌信任根被拒绝（锁定 false）
  assert.ok(
    run((m) => {
      (m.trust as Record<string, unknown>).embeddedTrustRootAllowed = true;
    }).some((e) => e.path === 'trust.embeddedTrustRootAllowed' && e.keyword === 'enum'),
  );
  // 非带外分发被拒绝（锁定 out-of-band）
  assert.ok(
    run((m) => {
      (m.trust as Record<string, unknown>).rootDistribution = 'package-metadata';
    }).some((e) => e.path === 'trust.rootDistribution' && e.keyword === 'enum'),
  );
  assert.ok(
    run((m) => {
      (m.signature as Record<string, unknown>).algorithm = 'Ed25519';
    }).some((e) => e.path === 'signature.algorithm' && e.keyword === 'enum'),
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

test('暂定值定性规则可执行：服务端验签强制、失败关闭、载荷字段锁定、信任根带外分发', () => {
  assert.equal(isServerSideSignatureVerificationRequired(), true);
  assert.equal(isSignatureVerificationFailClosed(), true);
  assert.equal(isEmbeddedTrustRootAllowed(), false);
  assert.equal(OTA_PACKAGE_SIGNATURE_POLICY.trust.rootDistribution, 'out-of-band');
  assert.deepEqual(getOtaSignaturePayloadFields(), ['model', 'version', 'packageType', 'sha256']);
});

test('DEC-022 冻结算法、信任根类型、编码且无待定参数', () => {
  const sig = OTA_PACKAGE_SIGNATURE_POLICY.signature;
  assert.equal(getOtaSignatureAlgorithm(), 'RSASSA_PKCS1_V1_5_SHA_256');
  assert.equal(getOtaSignatureTrustRoot(), 'AWS_KMS_ASYMMETRIC_SIGNING_KEY');
  assert.equal(getOtaSignatureEncoding(), 'base64');
  assert.deepEqual(OTA_PACKAGE_SIGNATURE_POLICY.pendingParameters, []);
  assert.deepEqual(policyJson['x-decision-versions'], ['DEC-022@1.0.0']);
  assert.equal(sig.algorithm, vector.algorithm);
  assert.equal(sig.encoding, vector.encoding);
});

test('DEC-022 固定 RSA/SHA-256 测试向量可复验', () => {
  assert.equal(
    verify(
      'sha256',
      Buffer.from(vector.payload, 'utf8'),
      { key: vector.publicKeyPem, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(vector.signature, 'base64'),
    ),
    true,
  );
});

test('策略消费者均为合法任务 ID 且覆盖 BE-OTA-01', () => {
  const consumers = new Set<string>();
  for (const s of [
    OTA_PACKAGE_SIGNATURE_POLICY.verification,
    OTA_PACKAGE_SIGNATURE_POLICY.payload,
    OTA_PACKAGE_SIGNATURE_POLICY.signature,
    OTA_PACKAGE_SIGNATURE_POLICY.trust,
  ]) {
    assert.ok(s.note.length > 0, '缺少 note');
    assert.ok(s.consumers.length > 0, '缺少 consumers');
    for (const c of s.consumers) {
      assert.ok(TASK_ID.test(c), `消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  assert.ok(consumers.has('BE-OTA-01'), 'BE-OTA-01 未被策略承接');
});

test('TS 常量与 ota-package-signature-policy.json 完全一致', () => {
  assert.equal(policyJson.policyVersion, OTA_PACKAGE_SIGNATURE_POLICY.policyVersion);
  assert.equal(policyJson.status, OTA_PACKAGE_SIGNATURE_POLICY.status);
  assert.equal(policyJson.verification.serverSide, OTA_PACKAGE_SIGNATURE_POLICY.verification.serverSide);
  assert.equal(policyJson.verification.failClosed, OTA_PACKAGE_SIGNATURE_POLICY.verification.failClosed);
  assert.equal(policyJson.verification.note, OTA_PACKAGE_SIGNATURE_POLICY.verification.note);
  assert.deepEqual(policyJson.verification.consumers, [...OTA_PACKAGE_SIGNATURE_POLICY.verification.consumers]);
  assert.deepEqual(policyJson.payload.fields, [...OTA_PACKAGE_SIGNATURE_POLICY.payload.fields]);
  assert.equal(policyJson.payload.note, OTA_PACKAGE_SIGNATURE_POLICY.payload.note);
  assert.deepEqual(policyJson.payload.consumers, [...OTA_PACKAGE_SIGNATURE_POLICY.payload.consumers]);
  assert.equal(policyJson.signature.algorithm, OTA_PACKAGE_SIGNATURE_POLICY.signature.algorithm);
  assert.equal(policyJson.signature.trustRoot, OTA_PACKAGE_SIGNATURE_POLICY.signature.trustRoot);
  assert.equal(policyJson.signature.encoding, OTA_PACKAGE_SIGNATURE_POLICY.signature.encoding);
  assert.equal(policyJson.signature.note, OTA_PACKAGE_SIGNATURE_POLICY.signature.note);
  assert.deepEqual(policyJson.signature.consumers, [...OTA_PACKAGE_SIGNATURE_POLICY.signature.consumers]);
  assert.equal(policyJson.trust.rootDistribution, OTA_PACKAGE_SIGNATURE_POLICY.trust.rootDistribution);
  assert.equal(policyJson.trust.embeddedTrustRootAllowed, OTA_PACKAGE_SIGNATURE_POLICY.trust.embeddedTrustRootAllowed);
  assert.equal(policyJson.trust.note, OTA_PACKAGE_SIGNATURE_POLICY.trust.note);
  assert.deepEqual(policyJson.trust.consumers, [...OTA_PACKAGE_SIGNATURE_POLICY.trust.consumers]);
  assert.deepEqual(policyJson.pendingParameters, [...OTA_PACKAGE_SIGNATURE_POLICY.pendingParameters]);
  assert.equal(policyJson.frozenUpgradePath, OTA_PACKAGE_SIGNATURE_POLICY.frozenUpgradePath);
  assert.equal(getOtaSignaturePolicyStatus(), 'frozen');
});
