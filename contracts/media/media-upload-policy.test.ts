/**
 * Media 上传策略测试。
 * 运行：node --test "contracts/media/media-upload-policy.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  MEDIA_UPLOAD_POLICY,
  getDailyUploadQuotaPerDevice,
  getDownloadUrlTtlSeconds,
  getMaxSizeKb,
  getMediaTypes,
  getMediaUploadPolicyStatus,
  getObjectKeyPattern,
  getUploadUrlTtlSeconds,
  isClientProvidedKeyAllowed,
} from './media-upload-policy.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./media-upload-policy.json');
const policySchema = read('./media-upload-policy.schema.json');
const mediaMqttSchema = read('../mqtt/schemas/media.schema.json');

const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;

test('策略 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(policySchema, 'media-upload-policy.schema.json', policyJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：客户端指定 Key、篡改冻结 TTL/配额与缺失字段被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(policyJson));
    mutate(m);
    return validate(policySchema, 'media-upload-policy.schema.json', m, registry);
  };
  // 允许客户端指定 Key 被拒绝（锁定 false）
  assert.ok(
    run((m) => {
      (m.objectKey as Record<string, unknown>).clientProvidedKeyAllowed = true;
    }).some((e) => e.path === 'objectKey.clientProvidedKeyAllowed' && e.keyword === 'enum'),
  );
  // 篡改 Key 模板被拒绝（锁定模板）
  assert.ok(
    run((m) => {
      (m.objectKey as Record<string, unknown>).pattern = 'uploads/{anything}';
    }).some((e) => e.path === 'objectKey.pattern' && e.keyword === 'enum'),
  );
  // 任意 TTL 漂移被拒绝（不仅是范围越界）
  assert.ok(
    run((m) => {
      (m.limits as Record<string, unknown>).uploadUrlTtlSeconds = 901;
    }).some((e) => e.path === 'limits.uploadUrlTtlSeconds' && e.keyword === 'enum'),
  );
  // 任意配额漂移被拒绝
  assert.ok(
    run((m) => {
      (m.limits as Record<string, unknown>).dailyUploadQuotaPerDevice = 99;
    }).some((e) => e.path === 'limits.dailyUploadQuotaPerDevice' && e.keyword === 'enum'),
  );
  assert.ok(
    run((m) => {
      m.status = 'provisional';
    }).some((e) => e.path === 'status' && e.keyword === 'enum'),
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

test('锁定规则：mediaTypes 与 CT-03 media.schema.json 枚举一致；客户端不得指定 Key', () => {
  const schemaTypes = mediaMqttSchema.properties.data.properties.mediaType.enum;
  assert.deepEqual([...getMediaTypes()].sort(), [...schemaTypes].sort());
  assert.equal(isClientProvidedKeyAllowed(), false);
  assert.equal(getObjectKeyPattern(), 'media/{customerId}/{deviceId}/{sessionId}/{fileName}');
});

test('DEC-024 冻结值可执行且无待定参数', () => {
  assert.equal(getMediaUploadPolicyStatus(), 'frozen');
  assert.equal(getMaxSizeKb('IMAGE'), 10240);
  assert.equal(getMaxSizeKb('VIDEO'), 204800);
  assert.equal(getDailyUploadQuotaPerDevice(), 100);
  assert.equal(getUploadUrlTtlSeconds(), 900);
  assert.equal(getDownloadUrlTtlSeconds(), 900);
  assert.deepEqual(MEDIA_UPLOAD_POLICY.pendingParameters, []);
  assert.ok(policyJson['x-decision-versions'].includes('DEC-024@1.0.0'));
});

test('TS 常量与 media-upload-policy.json 完全一致', () => {
  assert.equal(policyJson.policyVersion, MEDIA_UPLOAD_POLICY.policyVersion);
  assert.equal(policyJson.status, MEDIA_UPLOAD_POLICY.status);
  assert.deepEqual(policyJson.mediaTypes, [...MEDIA_UPLOAD_POLICY.mediaTypes]);
  assert.deepEqual(policyJson.limits.maxSizeKb, { ...MEDIA_UPLOAD_POLICY.limits.maxSizeKb });
  assert.equal(policyJson.limits.dailyUploadQuotaPerDevice, MEDIA_UPLOAD_POLICY.limits.dailyUploadQuotaPerDevice);
  assert.equal(policyJson.limits.uploadUrlTtlSeconds, MEDIA_UPLOAD_POLICY.limits.uploadUrlTtlSeconds);
  assert.equal(policyJson.limits.downloadUrlTtlSeconds, MEDIA_UPLOAD_POLICY.limits.downloadUrlTtlSeconds);
  assert.equal(policyJson.limits.note, MEDIA_UPLOAD_POLICY.limits.note);
  assert.deepEqual(policyJson.limits.consumers, [...MEDIA_UPLOAD_POLICY.limits.consumers]);
  assert.equal(policyJson.objectKey.pattern, MEDIA_UPLOAD_POLICY.objectKey.pattern);
  assert.equal(policyJson.objectKey.clientProvidedKeyAllowed, MEDIA_UPLOAD_POLICY.objectKey.clientProvidedKeyAllowed);
  assert.equal(policyJson.objectKey.note, MEDIA_UPLOAD_POLICY.objectKey.note);
  assert.deepEqual(policyJson.objectKey.consumers, [...MEDIA_UPLOAD_POLICY.objectKey.consumers]);
  assert.deepEqual(policyJson.pendingParameters, [...MEDIA_UPLOAD_POLICY.pendingParameters]);
  assert.equal(policyJson.frozenUpgradePath, MEDIA_UPLOAD_POLICY.frozenUpgradePath);
  // 消费者为合法任务 ID 且覆盖 BE-MED-01
  for (const c of [...MEDIA_UPLOAD_POLICY.limits.consumers, ...MEDIA_UPLOAD_POLICY.objectKey.consumers]) {
    assert.ok(TASK_ID.test(c), `消费者 ${c} 不是合法任务 ID`);
  }
  assert.ok(MEDIA_UPLOAD_POLICY.limits.consumers.includes('BE-MED-01'));
});
