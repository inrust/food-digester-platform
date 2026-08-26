/**
 * DEC-005 Media 文件与元数据保留期策略测试。
 * 运行：node --test "contracts/media/media-retention-policy.test.ts"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  MEDIA_RETENTION_POLICY,
  getExpiryAction,
  getFileRetentionDays,
  getFileStore,
  getMetadataRetentionDays,
  getMetadataStore,
  getRetentionPolicyStatus,
  isAutomaticExpiryEnabled,
} from './media-retention-policy.ts';
import { PolicyParameterPendingError } from '../security/certificate-package-policy.ts';
import { SchemaRegistry, validate } from '../mqtt/validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const policyJson = read('./media-retention-policy.json');
const policySchema = read('./media-retention-policy.schema.json');
const registerJson = read('../decisions/decision-register.json');

const TASK_ID = /^[A-Z]{2,4}(-[A-Z]{2,4})?-\d{2}$/;

test('策略 JSON 通过自身 JSON Schema 结构校验', () => {
  const registry = new SchemaRegistry(here);
  const errors = validate(policySchema, 'media-retention-policy.schema.json', policyJson, registry);
  assert.deepEqual(errors, []);
});

test('负向结构：存储位置篡改、非法处置行为与缺失字段被 Schema 拒绝', () => {
  const registry = new SchemaRegistry(here);
  const run = (mutate: (m: Record<string, unknown>) => void) => {
    const m = JSON.parse(JSON.stringify(policyJson));
    mutate(m);
    return validate(policySchema, 'media-retention-policy.schema.json', m, registry);
  };
  // 元数据存储锁定 RDS
  assert.ok(run((m) => { (m.storageSplit as Record<string, unknown>).metadataStore = 's3'; }).some((e) => e.path === 'storageSplit.metadataStore' && e.keyword === 'enum'));
  // 文件存储锁定 S3
  assert.ok(run((m) => { (m.storageSplit as Record<string, unknown>).fileStore = 'rds'; }).some((e) => e.path === 'storageSplit.fileStore' && e.keyword === 'enum'));
  // 非法处置行为被拒绝
  assert.ok(run((m) => { (m.retention as Record<string, unknown>).expiryAction = 'purge-everything'; }).some((e) => e.path === 'retention.expiryAction' && e.keyword === 'enum'));
  // 保留天数非正数被拒绝
  assert.ok(run((m) => { (m.retention as Record<string, unknown>).fileRetentionDays = 0; }).some((e) => e.path === 'retention.fileRetentionDays' && e.keyword === 'minimum'));
  // 冻结参数允许填入（frozen 后合法）
  assert.deepEqual(run((m) => {
    const r = m.retention as Record<string, unknown>;
    r.metadataRetentionDays = 365; r.fileRetentionDays = 90; r.expiryAction = 'delete';
  }), []);
  // 缺字段与额外字段被拒绝
  assert.ok(run((m) => { delete m.pendingParameters; }).some((e) => e.keyword === 'required'));
  assert.ok(run((m) => { m.extra = 1; }).some((e) => e.keyword === 'additionalProperties'));
});

test('x-decision-versions 引用 DEC-005 且版本与决策登记一致', () => {
  const refs: string[] = policyJson['x-decision-versions'];
  const dec005 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-005');
  assert.ok(dec005, '决策登记必须包含 DEC-005');
  assert.ok(refs.includes(`DEC-005@${dec005.version}`), `引用必须包含 DEC-005@${dec005.version}`);
  if (dec005.status !== 'frozen') {
    assert.equal(policyJson.status, 'provisional');
    assert.ok(policyJson.policyVersion.startsWith('0.'));
  }
});

test('暂定值定性规则可执行：RDS 元数据 / S3 文件分离', () => {
  assert.equal(getMetadataStore(), 'rds');
  assert.equal(getFileStore(), 's3');
});

test('待冻结参数失败关闭：禁止臆测保留期与处置行为', () => {
  const r = MEDIA_RETENTION_POLICY.retention;
  assert.equal(r.metadataRetentionDays, null);
  assert.equal(r.fileRetentionDays, null);
  assert.equal(r.expiryAction, null);
  const pendingCases: Array<[() => unknown, string]> = [
    [getMetadataRetentionDays, 'retention.metadataRetentionDays'],
    [getFileRetentionDays, 'retention.fileRetentionDays'],
    [getExpiryAction, 'retention.expiryAction'],
  ];
  for (const [fn, param] of pendingCases) {
    assert.throws(fn, (e: unknown) => e instanceof PolicyParameterPendingError && (e as PolicyParameterPendingError).parameter === param);
  }
  // 冻结前禁止任何自动过期/删除
  assert.equal(isAutomaticExpiryEnabled(), false);
  assert.deepEqual([...MEDIA_RETENTION_POLICY.pendingParameters].sort(), ['retention.expiryAction', 'retention.fileRetentionDays', 'retention.metadataRetentionDays']);
});

test('策略消费者均为合法任务 ID 且覆盖 DEC-005 阻塞任务与关联任务', () => {
  const consumers = new Set<string>();
  for (const s of [MEDIA_RETENTION_POLICY.storageSplit, MEDIA_RETENTION_POLICY.retention]) {
    assert.ok(s.note.length > 0, '缺少 note');
    assert.ok(s.consumers.length > 0, '缺少 consumers');
    for (const c of s.consumers) {
      assert.ok(TASK_ID.test(c), `消费者 ${c} 不是合法任务 ID`);
      consumers.add(c);
    }
  }
  const dec005 = registerJson.decisions.find((d: { id: string }) => d.id === 'DEC-005');
  for (const task of dec005.blockingTasks as string[]) {
    assert.ok(consumers.has(task), `阻塞任务 ${task} 未被策略承接`);
  }
  assert.ok(consumers.has('BE-ARC-02'), 'BE-ARC-02（Media 独立 Bucket）必须被策略承接');
});

test('TS 常量与 media-retention-policy.json 完全一致', () => {
  assert.equal(policyJson.policyVersion, MEDIA_RETENTION_POLICY.policyVersion);
  assert.equal(policyJson.status, MEDIA_RETENTION_POLICY.status);
  assert.equal(policyJson.storageSplit.metadataStore, MEDIA_RETENTION_POLICY.storageSplit.metadataStore);
  assert.equal(policyJson.storageSplit.fileStore, MEDIA_RETENTION_POLICY.storageSplit.fileStore);
  assert.equal(policyJson.storageSplit.note, MEDIA_RETENTION_POLICY.storageSplit.note);
  assert.deepEqual(policyJson.storageSplit.consumers, [...MEDIA_RETENTION_POLICY.storageSplit.consumers]);
  assert.equal(policyJson.retention.metadataRetentionDays, MEDIA_RETENTION_POLICY.retention.metadataRetentionDays);
  assert.equal(policyJson.retention.fileRetentionDays, MEDIA_RETENTION_POLICY.retention.fileRetentionDays);
  assert.equal(policyJson.retention.expiryAction, MEDIA_RETENTION_POLICY.retention.expiryAction);
  assert.equal(policyJson.retention.note, MEDIA_RETENTION_POLICY.retention.note);
  assert.deepEqual(policyJson.retention.consumers, [...MEDIA_RETENTION_POLICY.retention.consumers]);
  assert.deepEqual(policyJson.pendingParameters, [...MEDIA_RETENTION_POLICY.pendingParameters]);
  assert.equal(policyJson.frozenUpgradePath, MEDIA_RETENTION_POLICY.frozenUpgradePath);
  assert.equal(getRetentionPolicyStatus(), 'provisional');
});
