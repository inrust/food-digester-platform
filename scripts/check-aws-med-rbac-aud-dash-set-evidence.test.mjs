import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkEvidence,
  REQUIRED_OPERATIONS,
  REQUIRED_ROLES,
  validateEvidence,
} from './check-aws-med-rbac-aud-dash-set-evidence.mjs';

const evidence = { passed: true, evidence: ['cloudwatch://receipt'] };
const ROOT = new URL('..', import.meta.url).pathname;

function fixture() {
  return {
    schemaVersion: '1.0',
    status: 'PASS',
    sourceCommit: 'a'.repeat(40),
    executedAt: '2026-09-10T00:00:00Z',
    environment: {
      isolated: true,
      accountId: '123456789012',
      region: 'ap-southeast-1',
      stackName: 'fdp-acceptance',
      apiBaseUrl: 'https://api.example.test',
      userPoolId: 'ap-southeast-1_example',
      mediaBucket: 'fdp-media-acceptance',
    },
    probes: {
      apiOperations: REQUIRED_OPERATIONS.map((operationId) => ({
        ...evidence,
        operationId,
        requestId: `req-${operationId}`,
        successStatus: ['createMediaUploadSession', 'inviteUser'].includes(operationId) ? 201 : 200,
        negativeStatuses: [401, 403],
      })),
      rbac: {
        roles: REQUIRED_ROLES.map((role) => ({ ...evidence, role })),
        crossCustomer: { ...evidence, deniedStatus: 404 },
      },
      cognito: {
        ...evidence,
        inviteObserved: true,
        groupsSynchronized: true,
        customerScopeSynchronized: true,
        disableObserved: true,
        passwordResetObserved: true,
        compensationObserved: true,
      },
      superAdminRace: { ...evidence, successCount: 1, conflictCount: 1, effectiveSuperAdminCount: 1 },
      settingVersionRace: { ...evidence, successCount: 1, conflictCount: 1, conflictStatus: 409 },
      mediaS3: {
        ...evidence,
        serverGeneratedKey: true,
        contentLengthBound: true,
        sha256Bound: true,
        hashVerified: true,
        uploadUrlTtlSeconds: 900,
        downloadUrlTtlSeconds: 900,
        expiredUrlRejected: true,
      },
      mediaQuotaRace: {
        ...evidence,
        quota: 100,
        requestCount: 101,
        successCount: 100,
        conflictCount: 1,
        issuedSessionCount: 100,
      },
      dashboardEntitlement: {
        ...evidence,
        activeEntitlementAllowed: true,
        noLicenseDenied: true,
        expiredDenied: true,
        revokedDenied: true,
        missingEntitlementDenied: true,
      },
      auditRedaction: {
        ...evidence,
        noSensitiveValuesReturned: true,
        redactedFields: [
          'authorization',
          'cookie',
          'set-cookie',
          'session',
          'jwt',
          'refreshToken',
          'accessToken',
          'idToken',
        ],
      },
      strictRequests: {
        ...evidence,
        unknownFieldStatus: 400,
        arrayBodyStatus: 400,
        passwordFieldStatus: 400,
        sideEffectsObserved: 0,
      },
    },
    cleanup: { ...evidence, completed: true },
  };
}

test('完整的 15 API、角色、Cognito、并发、S3、Dashboard、审计与清理回执通过', () => {
  assert.equal(REQUIRED_OPERATIONS.length, 15);
  assert.deepEqual(validateEvidence(fixture()), []);
});

test('15 个 operationId 与六份正式 OpenAPI 精确一致', () => {
  const files = [
    'device-media-api.json',
    'admin-media-api.json',
    'admin-user-api.json',
    'admin-audit-api.json',
    'admin-dashboard-api.json',
    'admin-settings-api.json',
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
  assert.deepEqual(new Set(REQUIRED_OPERATIONS), new Set(actual));
});

test('API、角色、租户或安全/并发探针缺口均失败关闭', () => {
  const missing = fixture();
  missing.probes.apiOperations.pop();
  assert.ok(validateEvidence(missing).some((error) => error.includes('15')));
  const role = fixture();
  role.probes.rbac.roles.pop();
  assert.ok(validateEvidence(role).some((error) => error.includes('5')));
  const unsafe = fixture();
  unsafe.probes.strictRequests.passwordFieldStatus = 201;
  unsafe.probes.auditRedaction.noSensitiveValuesReturned = false;
  unsafe.probes.mediaQuotaRace.successCount = 101;
  const errors = validateEvidence(unsafe);
  assert.ok(errors.some((error) => error.includes('严格请求')));
  assert.ok(errors.some((error) => error.includes('审计脱敏')));
  assert.ok(errors.some((error) => error.includes('配额并发')));
});

test('缺失回执与 sourceCommit 不匹配均失败关闭', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-med-rbac-evidence-'));
  assert.ok(checkEvidence(root, 'missing.json', 'b'.repeat(40))[0].includes('缺少'));
  mkdirSync(join(root, 'evidence'));
  writeFileSync(join(root, 'evidence/receipt.json'), JSON.stringify(fixture()));
  assert.ok(
    checkEvidence(root, 'evidence/receipt.json', 'b'.repeat(40)).some((error) => error.includes('sourceCommit')),
  );
});
