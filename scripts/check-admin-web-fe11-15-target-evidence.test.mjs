import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkFe11To15TargetEvidence,
  REQUIRED_AUDIT_DENIED_ROLES,
  REQUIRED_ROLES,
  REQUIRED_ROUTES,
  REQUIRED_WORKFLOWS,
  validateFe11To15TargetEvidence,
} from './check-admin-web-fe11-15-target-evidence.mjs';

const evidence = { passed: true, evidence: ['pipeline://acceptance/run-1'] };
const repositoryRoot = new URL('..', import.meta.url).pathname;

function fixture() {
  const sourceCommit = 'a'.repeat(40);
  const deploymentCommit = 'b'.repeat(40);
  return {
    schemaVersion: '1.0',
    status: 'PASS',
    sourceCommit,
    deploymentCommit,
    executedAt: '2026-09-12T05:00:00Z',
    environment: {
      isolated: true,
      accountId: '123456789012',
      region: 'ap-southeast-1',
      stackName: 'fdp-fe11-15-acceptance',
      webUrl: 'https://admin.example.test',
      apiBaseUrl: 'https://api.example.test',
      userPoolId: 'ap-southeast-1_example',
      browser: 'Chromium 140',
      deployedSourceCommit: sourceCommit,
      deployedDeploymentCommit: deploymentCommit,
    },
    probes: {
      routes: REQUIRED_ROUTES.map((path) => ({ ...evidence, path })),
      roles: REQUIRED_ROLES.map((role) => ({ ...evidence, role, identityProvider: 'COGNITO' })),
      workflows: REQUIRED_WORKFLOWS.map((workflowId) => ({
        ...evidence,
        workflowId,
        requestIds: [`request-${workflowId}`],
      })),
      cognito: { ...evidence, realUserCount: 5, tokenIssuerMatchesUserPool: true },
      deployedApi: { ...evidence, apiBaseUrlMatched: true, mockedResponseCount: 0, requestIdCount: 5 },
      crossCustomer: { ...evidence, deniedStatus: 404 },
      shortLink: { ...evidence, expiredStatus: 410, renewedUrlWorks: true, persistedUrlCount: 0 },
      dangerousAction: { ...evidence, confirmationRequired: true, unauthorizedStatus: 403, duplicateMutationCount: 1 },
      readonlyAudit: { ...evidence, writeRequestCount: 0, deniedRoles: [...REQUIRED_AUDIT_DENIED_ROLES] },
      sensitiveData: { ...evidence, domLeakCount: 0, networkResponseLeakCount: 0, logLeakCount: 0 },
    },
    cleanup: { ...evidence, completed: true },
  };
}

test('完整目标回执覆盖双提交、隔离环境、五角色、七路由、五闭环与清理', () => {
  assert.deepEqual(validateFe11To15TargetEvidence(repositoryRoot, fixture()), []);
});

test('缺路由、角色、闭环或审计拒绝角色时失败关闭', () => {
  const receipt = fixture();
  receipt.probes.routes.pop();
  receipt.probes.roles.pop();
  receipt.probes.workflows.pop();
  receipt.probes.readonlyAudit.deniedRoles.pop();
  const errors = validateFe11To15TargetEvidence(repositoryRoot, receipt);
  assert.ok(errors.some((error) => error.includes('probes.routes')));
  assert.ok(errors.some((error) => error.includes('probes.roles')));
  assert.ok(errors.some((error) => error.includes('probes.workflows')));
  assert.ok(errors.some((error) => error.includes('readonlyAudit.deniedRoles')));
});

test('mock、泄露、短链持久化、危险操作与只读写请求均失败关闭', () => {
  const receipt = fixture();
  receipt.probes.deployedApi.mockedResponseCount = 1;
  receipt.probes.sensitiveData.domLeakCount = 1;
  receipt.probes.shortLink.persistedUrlCount = 1;
  receipt.probes.dangerousAction.duplicateMutationCount = 2;
  receipt.probes.readonlyAudit.writeRequestCount = 1;
  const errors = validateFe11To15TargetEvidence(repositoryRoot, receipt).join('\n');
  assert.match(errors, /mockedResponseCount/);
  assert.match(errors, /domLeakCount/);
  assert.match(errors, /persistedUrlCount/);
  assert.match(errors, /duplicateMutationCount/);
  assert.match(errors, /writeRequestCount/);
});

test('缺失回执、双部署提交漂移、HEAD 不一致与未清理均失败关闭', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-fe11-15-target-'));
  assert.match(checkFe11To15TargetEvidence(root, 'missing.json', 'c'.repeat(40))[0], /NOT RUN \/ NO RECEIPT/);
  const receipt = fixture();
  receipt.environment.deployedSourceCommit = 'c'.repeat(40);
  receipt.environment.deployedDeploymentCommit = 'd'.repeat(40);
  receipt.cleanup.completed = false;
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt));
  const errors = checkFe11To15TargetEvidence(repositoryRoot, join(root, 'receipt.json'), 'c'.repeat(40)).join('\n');
  assert.match(errors, /deployedSourceCommit/);
  assert.match(errors, /deployedDeploymentCommit/);
  assert.match(errors, /sourceCommit 与待发布提交不一致/);
  assert.match(errors, /cleanup/);
});

test('目标 Gate 是显式发布步骤且不进入普通 verify', () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(
    manifest.scripts['check:admin-web-fe11-15-target-evidence'],
    'node scripts/check-admin-web-fe11-15-target-evidence.mjs',
  );
  assert.ok(!manifest.scripts.verify.includes('check:admin-web-fe11-15-target-evidence'));
});
