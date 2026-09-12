import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAwsAdminBusinessEvidence,
  REQUIRED_ADMIN_BUSINESS_OPERATIONS,
  REQUIRED_ADMIN_BUSINESS_ROLES,
  validateAwsAdminBusinessEvidence,
} from './check-aws-admin-business-evidence.mjs';

const evidence = { passed: true, evidence: ['cloudwatch://receipt'] };
const ROOT = new URL('..', import.meta.url).pathname;
function fixture() {
  return {
    schemaVersion: '1.0',
    status: 'PASS',
    sourceCommit: 'a'.repeat(40),
    executedAt: '2026-09-08T14:00:00Z',
    environment: {
      isolated: true,
      accountId: '123456789012',
      region: 'ap-southeast-1',
      stackName: 'fdp-acceptance',
      apiBaseUrl: 'https://api.example.test',
    },
    probes: {
      apiOperations: REQUIRED_ADMIN_BUSINESS_OPERATIONS.map((operationId) => ({
        ...evidence,
        operationId,
        requestId: `req-${operationId}`,
        negativeStatuses: [401, 403],
        successStatus:
          operationId === 'createEsgExport'
            ? 202
            : [
                  'createLicense',
                  'createContract',
                  'bindContractDevices',
                  'createConfiguration',
                  'createConfigurationVersion',
                  'createConsumableRequest',
                  'createDeviceUser',
                  'assignDeviceUser',
                ].includes(operationId)
              ? 201
              : 200,
      })),
      rbac: {
        roles: REQUIRED_ADMIN_BUSINESS_ROLES.map((role) => ({ ...evidence, role })),
        crossCustomer: { ...evidence, deniedStatus: 404 },
      },
      ifMatchRace: { ...evidence, successCount: 1, conflictCount: 1, conflictStatus: 409 },
      businessNotifier: {
        ...evidence,
        scheduleMinutes: 1,
        emailProvider: 'SES_V2',
        webhookHttpsAllowlist: true,
        concurrentSendCount: 1,
        processingClaimObserved: true,
        providerRequestIdRecorded: true,
        retryRecovered: true,
      },
      esgExport: {
        ...evidence,
        scheduleMinutes: 1,
        s3ObjectKey: 'esg-exports/test.csv',
        csvRowCount: 2,
        queryRowCount: 2,
        crossCustomerStatus: 404,
        expiredDownloadUrl: null,
        urlExpired: true,
        lifecycleDays: 1,
        expiredProcessingRecovered: true,
      },
    },
    cleanup: { ...evidence, completed: true },
  };
}

test('完整的 58 API、五角色、并发、通知、ESG 与清理目标 AWS 回执通过', () => {
  assert.equal(REQUIRED_ADMIN_BUSINESS_OPERATIONS.length, 58);
  assert.deepEqual(validateAwsAdminBusinessEvidence(fixture()), []);
});

test('58 个回执 operationId 与九份正式业务 OpenAPI 精确一致', () => {
  const files = [
    'admin-license-api.json',
    'admin-contract-api.json',
    'admin-contract-device-api.json',
    'admin-configuration-api.json',
    'admin-consumable-api.json',
    'admin-consumable-request-api.json',
    'admin-device-user-api.json',
    'admin-alarm-api.json',
    'admin-esg-api.json',
  ];
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
  const actual = files.flatMap((file) => {
    const document = JSON.parse(readFileSync(join(ROOT, 'contracts/rest', file), 'utf8'));
    return Object.values(document.paths).flatMap((pathItem) =>
      Object.entries(pathItem)
        .filter(([method]) => methods.has(method))
        .map(([, operation]) => operation.operationId),
    );
  });
  assert.deepEqual(new Set(REQUIRED_ADMIN_BUSINESS_OPERATIONS), new Set(actual));
});

test('API 缺项、角色缺项与跨 Customer 放行均失败关闭', () => {
  const missing = fixture();
  missing.probes.apiOperations.pop();
  assert.ok(validateAwsAdminBusinessEvidence(missing).some((error) => error.includes('58')));
  const role = fixture();
  role.probes.rbac.roles.pop();
  assert.ok(validateAwsAdminBusinessEvidence(role).some((error) => error.includes('5')));
  const tenant = fixture();
  tenant.probes.rbac.crossCustomer.deniedStatus = 200;
  assert.ok(validateAwsAdminBusinessEvidence(tenant).some((error) => error.includes('跨 Customer')));
});

test('并发、通知或 ESG 证据不满足生产约束时失败关闭', () => {
  const receipt = fixture();
  receipt.probes.ifMatchRace.successCount = 2;
  receipt.probes.businessNotifier.scheduleMinutes = 2;
  receipt.probes.esgExport.csvRowCount = 1;
  const errors = validateAwsAdminBusinessEvidence(receipt);
  assert.ok(errors.some((error) => error.includes('If-Match')));
  assert.ok(errors.some((error) => error.includes('通知调度')));
  assert.ok(errors.some((error) => error.includes('CSV 行数')));
});

test('缺失回执与 sourceCommit 不匹配均失败关闭', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-admin-business-evidence-'));
  assert.ok(checkAwsAdminBusinessEvidence(root, 'missing.json', 'b'.repeat(40))[0].includes('缺少'));
  assert.ok(validateAwsAdminBusinessEvidence({}).length > 0);
  mkdirSync(join(root, 'evidence'));
  writeFileSync(join(root, 'evidence/receipt.json'), JSON.stringify(fixture()));
  assert.ok(
    checkAwsAdminBusinessEvidence(root, 'evidence/receipt.json', 'b'.repeat(40)).some((error) =>
      error.includes('sourceCommit'),
    ),
  );
});
