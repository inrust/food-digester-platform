#!/usr/bin/env node
/**
 * FE-06～FE-10 管理后台前端目标环境回执 Gate。
 * 本地 Vitest、Playwright mock、构建和 CDK synth 均不能替代真实 Cognito + 已部署 API 回执。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REQUIRED_ROUTES = [
  '/devices/view',
  '/devices/manage',
  '/licenses',
  '/configurations',
  '/device-users',
  '/alarms',
];

export const REQUIRED_ROLES = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];

export const REQUIRED_WORKFLOWS = [
  'FE-06-device-media-activities',
  'FE-07-lifecycle-retirement-alias',
  'FE-08-license-history-actions',
  'FE-09-configuration-device-user-sync',
  'FE-10-alarm-url-critical',
];

const COMMIT = /^[a-f0-9]{40}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireString(errors, value, path) {
  if (typeof value !== 'string' || value.trim() === '') errors.push(`${path} 必须为非空字符串`);
}

function passed(errors, probe, path) {
  if (!isRecord(probe)) return errors.push(`${path} 必须为对象`);
  if (probe.passed !== true) errors.push(`${path}.passed 必须为 true`);
  if (!Array.isArray(probe.evidence) || probe.evidence.length === 0) errors.push(`${path}.evidence 必须非空`);
  else probe.evidence.forEach((item, index) => requireString(errors, item, `${path}.evidence[${index}]`));
}

function exact(errors, rows, required, path, field) {
  if (!Array.isArray(rows) || rows.length !== required.length) {
    errors.push(`${path} 必须恰好包含 ${required.length} 项`);
    return false;
  }
  const names = rows.map((row) => row?.[field]);
  if (new Set(names).size !== required.length || required.some((name) => !names.includes(name))) {
    errors.push(`${path} 必须无重复覆盖全部必需项`);
    return false;
  }
  return true;
}

export function validateAdminWebTargetEvidence(receipt) {
  const errors = [];
  if (!isRecord(receipt)) return ['回执根节点必须为对象'];
  if (receipt.schemaVersion !== '1.0') errors.push('schemaVersion 必须为 1.0');
  if (receipt.status !== 'PASS') errors.push('status 必须为 PASS');
  if (!COMMIT.test(receipt.sourceCommit ?? '')) errors.push('sourceCommit 必须为 40 位小写 Git SHA');
  if (!ISO_INSTANT.test(receipt.executedAt ?? '') || !Number.isFinite(Date.parse(receipt.executedAt))) {
    errors.push('executedAt 必须为 UTC ISO-8601 时刻');
  }

  if (!isRecord(receipt.environment)) errors.push('environment 必须为对象');
  else {
    if (receipt.environment.isolated !== true) errors.push('environment.isolated 必须为 true');
    for (const key of ['accountId', 'region', 'stackName', 'webUrl', 'apiBaseUrl', 'userPoolId', 'browser']) {
      requireString(errors, receipt.environment[key], `environment.${key}`);
    }
    if (receipt.environment.deployedSourceCommit !== receipt.sourceCommit) {
      errors.push('environment.deployedSourceCommit 必须与 sourceCommit 一致');
    }
  }

  const routes = receipt.probes?.routes;
  if (exact(errors, routes, REQUIRED_ROUTES, 'probes.routes', 'path')) {
    routes.forEach((probe, index) => passed(errors, probe, `probes.routes[${index}]`));
  }
  const roles = receipt.probes?.roles;
  if (exact(errors, roles, REQUIRED_ROLES, 'probes.roles', 'role')) {
    roles.forEach((probe, index) => passed(errors, probe, `probes.roles[${index}]`));
  }
  const workflows = receipt.probes?.workflows;
  if (exact(errors, workflows, REQUIRED_WORKFLOWS, 'probes.workflows', 'workflowId')) {
    workflows.forEach((probe, index) => {
      const path = `probes.workflows[${index}]`;
      passed(errors, probe, path);
      if (!Array.isArray(probe.requestIds) || probe.requestIds.length === 0) errors.push(`${path}.requestIds 必须非空`);
      else
        probe.requestIds.forEach((value, requestIndex) =>
          requireString(errors, value, `${path}.requestIds[${requestIndex}]`),
        );
    });
  }

  const cognito = receipt.probes?.cognito;
  passed(errors, cognito, 'probes.cognito');
  if (
    isRecord(cognito) &&
    (cognito.realUserCount !== REQUIRED_ROLES.length || cognito.tokenIssuerMatchesUserPool !== true)
  ) {
    errors.push('Cognito 证据必须证明五个真实用户且 Token issuer 匹配目标 User Pool');
  }

  const deployedApi = receipt.probes?.deployedApi;
  passed(errors, deployedApi, 'probes.deployedApi');
  if (
    isRecord(deployedApi) &&
    (deployedApi.apiBaseUrlMatched !== true || deployedApi.mockedResponseCount !== 0 || deployedApi.requestIdCount < 5)
  ) {
    errors.push('部署后 API 证据必须证明 Base URL 匹配、零 mock 且至少保存五个 Request ID');
  }

  const rbac = receipt.probes?.crossCustomer;
  passed(errors, rbac, 'probes.crossCustomer');
  if (isRecord(rbac) && ![403, 404].includes(rbac.deniedStatus)) errors.push('跨 Customer 必须返回 403 或 404');

  const concurrency = receipt.probes?.concurrency;
  passed(errors, concurrency, 'probes.concurrency');
  if (
    isRecord(concurrency) &&
    (concurrency.duplicateSubmitMutationCount !== 1 ||
      concurrency.ifMatchSuccessCount !== 1 ||
      concurrency.ifMatchConflictCount !== 1 ||
      concurrency.ifMatchConflictStatus !== 409)
  ) {
    errors.push('并发证据必须证明重复提交仅一次变更，If-Match 恰好一成功一 409 冲突');
  }

  const sensitive = receipt.probes?.sensitiveData;
  passed(errors, sensitive, 'probes.sensitiveData');
  if (
    isRecord(sensitive) &&
    (sensitive.domLeakCount !== 0 || sensitive.networkResponseLeakCount !== 0 || sensitive.logLeakCount !== 0)
  ) {
    errors.push('敏感字段在 DOM、网络响应和日志中的泄露计数必须均为 0');
  }

  passed(errors, receipt.cleanup, 'cleanup');
  if (isRecord(receipt.cleanup) && receipt.cleanup.completed !== true) errors.push('cleanup.completed 必须为 true');
  return errors;
}

export function checkAdminWebTargetEvidence(root, relativeReceipt, expectedSourceCommit) {
  const path = resolve(root, relativeReceipt);
  if (!existsSync(path)) return [`缺少 FE-06～FE-10 目标环境回执: ${relativeReceipt}`];
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return [`目标环境回执不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = validateAdminWebTargetEvidence(receipt);
  if (expectedSourceCommit && receipt.sourceCommit !== expectedSourceCommit) {
    errors.push(`sourceCommit 与待发布提交不一致: expected ${expectedSourceCommit}, received ${receipt.sourceCommit}`);
  }
  return errors;
}

function main() {
  const root = process.cwd();
  const relativeReceipt =
    process.env.FDP_ADMIN_WEB_TARGET_RECEIPT ?? 'docs/audit/evidence/fe-06-10-admin-web-target.json';
  const expectedSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const errors = checkAdminWebTargetEvidence(root, relativeReceipt, expectedSourceCommit);
  errors.forEach((error) => process.stderr.write(`${error}\n`));
  if (errors.length === 0) process.stdout.write('FE-06～FE-10 管理后台目标环境证据 PASS\n');
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
