import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkAwsAdminCusDevEvidence,
  REQUIRED_ADMIN_OPERATIONS,
  REQUIRED_ROLES,
  RETIRED_MQTT_TYPES,
  validateAwsAdminCusDevEvidence,
} from './check-aws-admin-cus-dev-evidence.mjs';

const passed = (extra = {}) => ({ passed: true, evidence: ['aws-request-id:test'], ...extra });

function validReceipt() {
  return {
    schemaVersion: '1.0',
    status: 'PASS',
    sourceCommit: '1'.repeat(40),
    executedAt: '2026-09-08T11:00:00Z',
    environment: {
      isolated: true,
      accountId: '123456789012',
      region: 'ap-southeast-1',
      stackName: 'fdp-test',
      apiBaseUrl: 'https://example.execute-api.ap-southeast-1.amazonaws.com/',
    },
    probes: {
      apiOperations: REQUIRED_ADMIN_OPERATIONS.map((operationId) =>
        passed({
          operationId,
          requestId: `request:${operationId}`,
          successStatus:
            operationId === 'createCustomer' || operationId === 'createSite'
              ? 201
              : operationId === 'createActivityExport'
                ? 202
                : 200,
          negativeStatuses: [400, 401],
        }),
      ),
      rbac: {
        roles: REQUIRED_ROLES.map((role) => passed({ role })),
        crossCustomer: passed({ deniedStatus: 404 }),
      },
      ifMatchRace: passed({ successCount: 1, conflictCount: 1, conflictStatus: 409 }),
      retirement: passed({
        awsIotCertificateStatus: 'INACTIVE',
        mqttDenied: RETIRED_MQTT_TYPES.map((type) => passed({ type, processedMessages: 0 })),
      }),
      activityExport: passed({
        snapshotAfterCreatedRows: 0,
        crossCustomerStatus: 404,
        expiredDownloadUrl: null,
        urlExpired: true,
        s3ObjectKey: 'activity-exports/test.csv',
      }),
    },
    cleanup: passed({ completed: true }),
  };
}

test('完整覆盖 25 API、五角色、竞态、退役与导出的隔离 AWS 回执通过', () => {
  assert.deepEqual(validateAwsAdminCusDevEvidence(validReceipt()), []);
});

test('缺 operation、跨租户放行、竞态双成功、证书未失活与 MQTT/S3 缺口均失败关闭', () => {
  const receipt = validReceipt();
  receipt.probes.apiOperations.pop();
  receipt.probes.rbac.crossCustomer.deniedStatus = 200;
  receipt.probes.ifMatchRace.successCount = 2;
  receipt.probes.retirement.awsIotCertificateStatus = 'ACTIVE';
  receipt.probes.retirement.mqttDenied[0].processedMessages = 1;
  receipt.probes.activityExport.snapshotAfterCreatedRows = 1;
  receipt.probes.activityExport.expiredDownloadUrl = 'https://expired.invalid/';
  const errors = validateAwsAdminCusDevEvidence(receipt);
  assert.ok(errors.some((error) => error.includes('恰好包含 25')));
  assert.ok(errors.some((error) => error.includes('crossCustomer.deniedStatus')));
  assert.ok(errors.some((error) => error.includes('一成功、一 409')));
  assert.ok(errors.some((error) => error.includes('INACTIVE')));
  assert.ok(errors.some((error) => error.includes('processedMessages')));
  assert.ok(errors.some((error) => error.includes('snapshotAfterCreatedRows')));
  assert.ok(errors.some((error) => error.includes('URL 过期')));
});

test('operation 成功状态与负向状态集合不完整时失败关闭', () => {
  const receipt = validReceipt();
  receipt.probes.apiOperations[0].successStatus = 201;
  receipt.probes.apiOperations[1].negativeStatuses = [401];
  const errors = validateAwsAdminCusDevEvidence(receipt);
  assert.ok(errors.some((error) => error.includes('successStatus')));
  assert.ok(errors.some((error) => error.includes('negativeStatuses')));
});

test('回执缺失、非法 JSON 或 sourceCommit 不一致时独立发布 Gate 失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-aws-admin-evidence-'));
  assert.deepEqual(checkAwsAdminCusDevEvidence(root, 'missing.json'), ['缺少目标 AWS 管理后台回执: missing.json']);
  writeFileSync(join(root, 'bad.json'), '{');
  assert.ok(checkAwsAdminCusDevEvidence(root, 'bad.json')[0].includes('不是合法 JSON'));
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(validReceipt()));
  assert.ok(
    checkAwsAdminCusDevEvidence(root, 'receipt.json', '2'.repeat(40)).some((error) =>
      error.includes('sourceCommit 与待发布提交不一致'),
    ),
  );
});
