import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAwsIotDataPathEvidence,
  QA03_PROBES,
  UPLINK_TYPES,
  validateAwsIotDataPathEvidence,
} from './check-aws-iot-data-path-evidence.mjs';

const hash = 'a'.repeat(64);

function passed(evidence = ['aws-request-id:test']) {
  return { passed: true, evidence };
}

function validReceipt() {
  return {
    schemaVersion: '1.0',
    status: 'PASS',
    sourceCommit: '1'.repeat(40),
    executedAt: '2026-09-07T10:00:00Z',
    environment: { isolated: true, accountId: '123456789012', region: 'ap-southeast-1', stackName: 'fdp-test' },
    probes: {
      uplinkRoutes: UPLINK_TYPES.map((type) => ({
        ...passed([`sqs-message-id:${type}`]),
        type,
        deviceId: 'device-evidence',
        topic: `bnx/device/device-evidence/${type}`,
        publishedBodySha256: hash,
        ingressBodySha256: hash,
      })),
      unknownTopic: { ...passed(), observedSeconds: 60, ingressMessages: 0 },
      errorAction: { ...passed(), restored: true },
      qa03: Object.fromEntries(QA03_PROBES.map((name) => [name, passed([`evidence:${name}`])])),
    },
    cleanup: { ...passed(['cloudformation/change-log:test']), completed: true },
  };
}

test('完整隔离 AWS 回执覆盖 8 Topic、负向路径、QA-03 与清理时通过', () => {
  const receipt = validReceipt();
  receipt.probes.qa03.s3RawArchive = {
    ...passed(['s3://bucket/raw/key']),
    sourceRawBodySha256: hash,
    archivedRawBodySha256: hash,
  };
  assert.deepEqual(validateAwsIotDataPathEvidence(receipt), []);
});

test('缺 Topic、未知 Topic 命中、Error Action 未恢复和原文漂移均失败关闭', () => {
  const receipt = validReceipt();
  receipt.probes.uplinkRoutes.pop();
  receipt.probes.unknownTopic.ingressMessages = 1;
  receipt.probes.errorAction.restored = false;
  receipt.probes.qa03.s3RawArchive = {
    ...passed(),
    sourceRawBodySha256: hash,
    archivedRawBodySha256: 'b'.repeat(64),
  };
  const errors = validateAwsIotDataPathEvidence(receipt);
  assert.ok(errors.some((error) => error.includes('恰好包含 8 个')));
  assert.ok(errors.some((error) => error.includes('ingressMessages')));
  assert.ok(errors.some((error) => error.includes('restored')));
  assert.ok(errors.some((error) => error.includes('归档原文')));
});

test('未提供目标 AWS 回执时独立发布 Gate 明确失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-aws-iot-evidence-'));
  assert.deepEqual(checkAwsIotDataPathEvidence(root, 'missing.json'), ['缺少目标 AWS 数据链路回执: missing.json']);
  writeFileSync(join(root, 'bad.json'), '{');
  assert.ok(checkAwsIotDataPathEvidence(root, 'bad.json')[0].includes('不是合法 JSON'));
});

test('回执必须对应待发布的精确 Git 提交', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-aws-iot-evidence-'));
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(validReceipt()));
  const errors = checkAwsIotDataPathEvidence(root, 'receipt.json', '2'.repeat(40));
  assert.ok(errors.some((error) => error.includes('sourceCommit 与待发布提交不一致')));
});
