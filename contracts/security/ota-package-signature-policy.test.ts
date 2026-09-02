/**
 * OTA 固件包签名策略测试。
 * 运行：node --test "contracts/security/ota-package-signature-policy.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
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
import { PolicyParameterPendingError } from './certificate-package-policy.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./ota-package-signature-policy.json');
const policySchema = read('./ota-package-signature-policy.schema.json');

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
  // 冻结参数允许填入（frozen 后合法）
  assert.deepEqual(
    run((m) => {
      const sig = m.signature as Record<string, unknown>;
      sig.algorithm = 'Ed25519';
      sig.trustRoot = 'kms:alias/fdp-ota-signing';
      sig.encoding = 'base64';
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

test('暂定值定性规则可执行：服务端验签强制、失败关闭、载荷字段锁定、信任根带外分发', () => {
  assert.equal(isServerSideSignatureVerificationRequired(), true);
  assert.equal(isSignatureVerificationFailClosed(), true);
  assert.equal(isEmbeddedTrustRootAllowed(), false);
  assert.equal(OTA_PACKAGE_SIGNATURE_POLICY.trust.rootDistribution, 'out-of-band');
  assert.deepEqual(getOtaSignaturePayloadFields(), ['model', 'version', 'packageType', 'sha256']);
});

test('待冻结参数失败关闭：禁止臆测签名算法/信任根/编码默认值', () => {
  const sig = OTA_PACKAGE_SIGNATURE_POLICY.signature;
  assert.equal(sig.algorithm, null);
  assert.equal(sig.trustRoot, null);
  assert.equal(sig.encoding, null);
  const pendingCases: Array<[() => unknown, string]> = [
    [getOtaSignatureAlgorithm, 'signature.algorithm'],
    [getOtaSignatureTrustRoot, 'signature.trustRoot'],
    [getOtaSignatureEncoding, 'signature.encoding'],
  ];
  for (const [fn, param] of pendingCases) {
    assert.throws(
      fn,
      (e: unknown) =>
        e instanceof PolicyParameterPendingError && (e as PolicyParameterPendingError).parameter === param,
    );
  }
  assert.deepEqual([...OTA_PACKAGE_SIGNATURE_POLICY.pendingParameters].sort(), [
    'signature.algorithm',
    'signature.encoding',
    'signature.trustRoot',
  ]);
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
  assert.equal(getOtaSignaturePolicyStatus(), 'provisional');
});
