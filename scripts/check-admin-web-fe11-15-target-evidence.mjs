#!/usr/bin/env node
/** FE-11～FE-15 独立目标环境回执 Gate；不得由本地 mock、构建或占位文件替代。 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

export const REQUIRED_ROUTES = [
  '/esg/overview',
  '/esg/devices',
  '/devices/operate',
  '/ota/packages',
  '/ota/campaigns',
  '/media',
  '/audit-logs',
];
export const REQUIRED_ROLES = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
export const REQUIRED_WORKFLOWS = [
  'FE-11-esg-pagination-export',
  'FE-12-command-danger-publish-failure',
  'FE-13-ota-package-campaign-failure',
  'FE-14-media-short-link-cross-customer',
  'FE-15-audit-readonly-redaction',
];
export const REQUIRED_AUDIT_DENIED_ROLES = ['PlatformOperator', 'CustomerAdmin', 'CustomerViewer'];

const SCHEMA = 'contracts/evidence/fe-11-15-admin-web-target.schema.json';

function exact(errors, rows, required, path, field) {
  if (!Array.isArray(rows) || rows.length !== required.length) {
    errors.push(`${path} 必须恰好包含 ${required.length} 项`);
    return;
  }
  const actual = rows.map((row) => row?.[field]);
  if (new Set(actual).size !== required.length || required.some((value) => !actual.includes(value))) {
    errors.push(`${path} 必须无重复覆盖全部必需项`);
  }
}

export function validateFe11To15TargetEvidence(root, receipt) {
  const schema = JSON.parse(readFileSync(resolve(root, SCHEMA), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat(
    'date-time',
    (value) => typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value)),
  );
  ajv.addFormat('uri', /^https:\/\/[^\s]+$/u);
  const validate = ajv.compile(schema);
  const errors = validate(receipt)
    ? []
    : (validate.errors ?? []).map((error) => `schema${error.instancePath || '/'} ${error.message}`);
  exact(errors, receipt?.probes?.routes, REQUIRED_ROUTES, 'probes.routes', 'path');
  exact(errors, receipt?.probes?.roles, REQUIRED_ROLES, 'probes.roles', 'role');
  exact(errors, receipt?.probes?.workflows, REQUIRED_WORKFLOWS, 'probes.workflows', 'workflowId');
  exact(
    errors,
    receipt?.probes?.readonlyAudit?.deniedRoles?.map((role) => ({ role })),
    REQUIRED_AUDIT_DENIED_ROLES,
    'probes.readonlyAudit.deniedRoles',
    'role',
  );
  if (receipt?.environment?.deployedSourceCommit !== receipt?.sourceCommit) {
    errors.push('environment.deployedSourceCommit 必须与 sourceCommit 一致');
  }
  if (receipt?.environment?.deployedDeploymentCommit !== receipt?.deploymentCommit) {
    errors.push('environment.deployedDeploymentCommit 必须与 deploymentCommit 一致');
  }
  return errors;
}

export function checkFe11To15TargetEvidence(root, relativeReceipt, expectedSourceCommit) {
  const path = resolve(root, relativeReceipt);
  if (!existsSync(path)) return [`缺少 FE-11～FE-15 目标环境回执: ${relativeReceipt}；状态为 NOT RUN / NO RECEIPT`];
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return [`目标环境回执不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = validateFe11To15TargetEvidence(root, receipt);
  if (expectedSourceCommit && receipt.sourceCommit !== expectedSourceCommit) {
    errors.push(`sourceCommit 与待发布提交不一致: expected ${expectedSourceCommit}, received ${receipt.sourceCommit}`);
  }
  return errors;
}

function main() {
  const root = process.cwd();
  const relativeReceipt =
    process.env.FDP_ADMIN_WEB_FE11_15_TARGET_RECEIPT ?? 'docs/audit/evidence/fe-11-15-admin-web-target.json';
  const expectedSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const errors = checkFe11To15TargetEvidence(root, relativeReceipt, expectedSourceCommit);
  errors.forEach((error) => process.stderr.write(`${error}\n`));
  if (errors.length === 0) process.stdout.write('FE-11～FE-15 管理后台目标环境证据 PASS\n');
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
