import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkAwsDataProcessingEvidence,
  REQUIRED_PROBES,
  validateAwsDataProcessingEvidence,
} from './check-aws-data-processing-evidence.mjs';

const hash = 'a'.repeat(64);
const passed = (extra = {}) => ({ passed: true, evidence: ['aws-request-id:test'], ...extra });

function validReceipt() {
  return {
    schemaVersion: '1.0',
    status: 'PASS',
    sourceCommit: '1'.repeat(40),
    executedAt: '2026-09-08T10:00:00Z',
    environment: { isolated: true, accountId: '123456789012', region: 'ap-southeast-1', stackName: 'fdp-test' },
    probes: {
      archive: Object.fromEntries(REQUIRED_PROBES.archive.map((name) => [name, passed()])),
      replay: Object.fromEntries(REQUIRED_PROBES.replay.map((name) => [name, passed()])),
      summary: Object.fromEntries(REQUIRED_PROBES.summary.map((name) => [name, passed()])),
    },
    cleanup: passed({ completed: true }),
  };
}

test('完整 Archive、Replay、Summary 目标 AWS 回执通过', () => {
  const receipt = validReceipt();
  receipt.probes.archive.s3Object.sha256 = hash;
  receipt.probes.archive.manifest.sha256 = hash;
  Object.assign(receipt.probes.archive.duplicateDelivery, { deliveryCount: 2, logicalRecordCount: 1 });
  Object.assign(receipt.probes.archive.partialFailure, { failedCount: 1, succeededCount: 1 });
  receipt.probes.replay.idempotency.duplicateBusinessRows = 0;
  for (const name of ['hourly', 'daily', 'esgDaily']) receipt.probes.summary[name].rowCount = 1;
  assert.deepEqual(validateAwsDataProcessingEvidence(receipt), []);
});

test('缺探针、重复归档、Replay 复制业务行和空 Summary 均失败关闭', () => {
  const receipt = validReceipt();
  delete receipt.probes.replay.worker;
  Object.assign(receipt.probes.archive.s3Object, { sha256: hash });
  Object.assign(receipt.probes.archive.manifest, { sha256: 'b'.repeat(64) });
  Object.assign(receipt.probes.archive.duplicateDelivery, { deliveryCount: 2, logicalRecordCount: 2 });
  Object.assign(receipt.probes.archive.partialFailure, { failedCount: 0, succeededCount: 1 });
  receipt.probes.replay.idempotency.duplicateBusinessRows = 1;
  for (const name of ['hourly', 'daily', 'esgDaily']) receipt.probes.summary[name].rowCount = 0;
  const errors = validateAwsDataProcessingEvidence(receipt);
  assert.ok(errors.some((error) => error.includes('probes.replay.worker')));
  assert.ok(errors.some((error) => error.includes('复算 Hash')));
  assert.ok(errors.some((error) => error.includes('一条逻辑记录')));
  assert.ok(errors.some((error) => error.includes('失败记录与成功记录')));
  assert.ok(errors.some((error) => error.includes('duplicateBusinessRows')));
  assert.ok(errors.some((error) => error.includes('rowCount')));
});

test('缺少回执或提交不一致时独立 Gate 失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-aws-data-processing-'));
  assert.deepEqual(checkAwsDataProcessingEvidence(root, 'missing.json'), ['缺少目标 AWS 数据处理回执: missing.json']);
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(validReceipt()));
  assert.ok(
    checkAwsDataProcessingEvidence(root, 'receipt.json', '2'.repeat(40)).some((error) =>
      error.includes('sourceCommit 与待发布提交不一致'),
    ),
  );
});
