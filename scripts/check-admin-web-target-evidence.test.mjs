import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkAdminWebTargetEvidence,
  REQUIRED_ROLES,
  REQUIRED_ROUTES,
  REQUIRED_WORKFLOWS,
  validateAdminWebTargetEvidence,
} from './check-admin-web-target-evidence.mjs';

const evidence = { passed: true, evidence: ['cloudwatch://receipt'] };

function fixture() {
  const sourceCommit = 'a'.repeat(40);
  return {
    schemaVersion: '1.0',
    status: 'PASS',
    sourceCommit,
    executedAt: '2026-09-10T09:00:00Z',
    environment: {
      isolated: true,
      accountId: '123456789012',
      region: 'ap-southeast-1',
      stackName: 'fdp-fe-acceptance',
      webUrl: 'https://admin.example.test',
      apiBaseUrl: 'https://api.example.test',
      userPoolId: 'ap-southeast-1_example',
      browser: 'Chromium 140',
      deployedSourceCommit: sourceCommit,
    },
    probes: {
      routes: REQUIRED_ROUTES.map((path) => ({ ...evidence, path })),
      roles: REQUIRED_ROLES.map((role) => ({ ...evidence, role })),
      workflows: REQUIRED_WORKFLOWS.map((workflowId) => ({
        ...evidence,
        workflowId,
        requestIds: [`req-${workflowId}`],
      })),
      cognito: { ...evidence, realUserCount: 5, tokenIssuerMatchesUserPool: true },
      deployedApi: { ...evidence, apiBaseUrlMatched: true, mockedResponseCount: 0, requestIdCount: 5 },
      crossCustomer: { ...evidence, deniedStatus: 404 },
      concurrency: {
        ...evidence,
        duplicateSubmitMutationCount: 1,
        ifMatchSuccessCount: 1,
        ifMatchConflictCount: 1,
        ifMatchConflictStatus: 409,
      },
      sensitiveData: { ...evidence, domLeakCount: 0, networkResponseLeakCount: 0, logLeakCount: 0 },
    },
    cleanup: { ...evidence, completed: true },
  };
}

test('完整路由、五角色、五业务闭环、租户、并发、敏感字段与清理回执通过', () => {
  assert.deepEqual(validateAdminWebTargetEvidence(fixture()), []);
});

test('缺路由、角色或业务闭环时失败关闭', () => {
  const receipt = fixture();
  receipt.probes.routes.pop();
  receipt.probes.roles.pop();
  receipt.probes.workflows.pop();
  const errors = validateAdminWebTargetEvidence(receipt);
  assert.ok(errors.some((error) => error.includes('6 项')));
  assert.ok(errors.filter((error) => error.includes('5 项')).length >= 2);
});

test('Cognito、部署 API、跨租户、并发与敏感字段证据不满足约束时失败关闭', () => {
  const receipt = fixture();
  receipt.probes.cognito.realUserCount = 4;
  receipt.probes.deployedApi.mockedResponseCount = 1;
  receipt.probes.crossCustomer.deniedStatus = 200;
  receipt.probes.concurrency.duplicateSubmitMutationCount = 2;
  receipt.probes.sensitiveData.domLeakCount = 1;
  const errors = validateAdminWebTargetEvidence(receipt);
  assert.ok(errors.some((error) => error.includes('Cognito')));
  assert.ok(errors.some((error) => error.includes('部署后 API')));
  assert.ok(errors.some((error) => error.includes('跨 Customer')));
  assert.ok(errors.some((error) => error.includes('并发证据')));
  assert.ok(errors.some((error) => error.includes('泄露计数')));
});

test('缺失回执、部署提交或 sourceCommit 不一致时失败关闭', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-admin-web-target-'));
  assert.ok(checkAdminWebTargetEvidence(root, 'missing.json', 'b'.repeat(40))[0].includes('缺少'));
  const receipt = fixture();
  receipt.environment.deployedSourceCommit = 'b'.repeat(40);
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt));
  const errors = checkAdminWebTargetEvidence(root, 'receipt.json', 'b'.repeat(40));
  assert.ok(errors.some((error) => error.includes('deployedSourceCommit')));
  assert.ok(errors.some((error) => error.includes('sourceCommit 与待发布提交不一致')));
});
