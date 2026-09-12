import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkFe16To19TargetEvidence,
  REQUIRED_LOCALES,
  REQUIRED_ROLES,
  REQUIRED_ROUTES,
  REQUIRED_VIEWPORTS,
  REQUIRED_WORKFLOWS,
  validateFe16To19TargetEvidence,
} from './check-admin-web-fe16-19-target-evidence.mjs';

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
      stackName: 'fdp-fe16-19-acceptance',
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
      deployedApi: { ...evidence, apiBaseUrlMatched: true, mockedResponseCount: 0, requestIdCount: 8 },
      authorization: {
        ...evidence,
        contractWriteDeniedStatuses: [403, 403, 403, 403],
        crossCustomerStatus: 404,
        missingResourceStatus: 404,
        selfElevationStatus: 403,
        lastSuperAdminStatus: 409,
      },
      concurrency: { ...evidence, duplicateMutationCount: 1, ifMatchSuccessCount: 1, ifMatchConflictCount: 1 },
      privacy: {
        ...evidence,
        listContactFieldCount: 0,
        preClickContactRequestCount: 0,
        domLeakCount: 0,
        networkResponseLeakCount: 0,
        logLeakCount: 0,
      },
      i18nLayout: {
        ...evidence,
        locales: [...REQUIRED_LOCALES],
        productionRouteCount: 22,
        testedRouteCount: 22,
        viewports: [...REQUIRED_VIEWPORTS],
        overflowCount: 0,
        refreshPersistence: true,
        localeFormatting: true,
        timeZonePreserved: true,
      },
    },
    cleanup: { ...evidence, completed: true },
  };
}

test('完整回执覆盖双提交、隔离环境、五角色、五路由、四闭环、隐私、双语布局与清理', () => {
  assert.deepEqual(validateFe16To19TargetEvidence(repositoryRoot, fixture()), []);
});

test('缺路由、角色、闭环、locale 或 viewport 时失败关闭', () => {
  const receipt = fixture();
  receipt.probes.routes.pop();
  receipt.probes.roles.pop();
  receipt.probes.workflows.pop();
  receipt.probes.i18nLayout.locales.pop();
  receipt.probes.i18nLayout.viewports.pop();
  const errors = validateFe16To19TargetEvidence(repositoryRoot, receipt).join('\n');
  for (const path of [
    'probes.routes',
    'probes.roles',
    'probes.workflows',
    'i18nLayout.locales',
    'i18nLayout.viewports',
  ])
    assert.match(errors, new RegExp(path.replace('.', '\\.')));
});

test('mock、权限、并发、泄露或布局不合格时失败关闭', () => {
  const receipt = fixture();
  receipt.probes.deployedApi.mockedResponseCount = 1;
  receipt.probes.authorization.crossCustomerStatus = 403;
  receipt.probes.concurrency.duplicateMutationCount = 2;
  receipt.probes.privacy.networkResponseLeakCount = 1;
  receipt.probes.i18nLayout.overflowCount = 1;
  const errors = validateFe16To19TargetEvidence(repositoryRoot, receipt).join('\n');
  for (const field of [
    'mockedResponseCount',
    'crossCustomerStatus',
    'duplicateMutationCount',
    'networkResponseLeakCount',
    'overflowCount',
  ])
    assert.match(errors, new RegExp(field));
});

test('缺失回执、双部署提交漂移、HEAD 不一致与未清理均失败关闭', () => {
  const root = mkdtempSync(join(tmpdir(), 'fdp-fe16-19-target-'));
  assert.match(checkFe16To19TargetEvidence(root, 'missing.json', 'c'.repeat(40))[0], /NOT RUN \/ NO RECEIPT/);
  const receipt = fixture();
  receipt.environment.deployedSourceCommit = 'c'.repeat(40);
  receipt.environment.deployedDeploymentCommit = 'd'.repeat(40);
  receipt.cleanup.completed = false;
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt));
  const errors = checkFe16To19TargetEvidence(repositoryRoot, join(root, 'receipt.json'), 'c'.repeat(40)).join('\n');
  assert.match(errors, /deployedSourceCommit/);
  assert.match(errors, /deployedDeploymentCommit/);
  assert.match(errors, /sourceCommit 与待发布提交不一致/);
  assert.match(errors, /cleanup/);
});

test('目标 Gate 是显式发布步骤且不进入普通 verify', () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(
    manifest.scripts['check:admin-web-fe16-19-target-evidence'],
    'node scripts/check-admin-web-fe16-19-target-evidence.mjs',
  );
  assert.ok(!manifest.scripts.verify.includes('check:admin-web-fe16-19-target-evidence'));
});
