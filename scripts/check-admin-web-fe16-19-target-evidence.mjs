#!/usr/bin/env node
/** FE-16～FE-19 独立目标环境回执 Gate；普通 verify 与本地 mock 不得替代。 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { targetEnvironmentErrors, validateReceiptBinding, runTargetEvidenceCli } from './qa09-acceptance-context.mjs';
import Ajv2020 from 'ajv/dist/2020.js';

export const REQUIRED_ROUTES = ['/settings', '/contracts', '/contracts/new', '/contracts/detail', '/consumables'];
export const REQUIRED_ROLES = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
export const REQUIRED_WORKFLOWS = [
  'FE-16-users-settings',
  'FE-17-contract-lifecycle',
  'FE-18-consumable-privacy-workflow',
  'FE-19-bilingual-layout',
];
export const REQUIRED_LOCALES = ['zh-CN', 'en'];
export const REQUIRED_VIEWPORTS = [375, 768, 1440];

const SCHEMA = 'contracts/evidence/fe-16-19-admin-web-target.schema.json';

function exact(errors, rows, required, path, field) {
  if (!Array.isArray(rows) || rows.length !== required.length) {
    errors.push(`${path} 必须恰好包含 ${required.length} 项`);
    return;
  }
  const actual = field === null ? rows : rows.map((row) => row?.[field]);
  if (new Set(actual).size !== required.length || required.some((value) => !actual.includes(value))) {
    errors.push(`${path} 必须无重复覆盖全部必需项`);
  }
}

export function validateFe16To19TargetEvidence(root, receipt, context) {
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
  errors.push(...targetEnvironmentErrors(receipt?.environment, context));
  exact(errors, receipt?.probes?.routes, REQUIRED_ROUTES, 'probes.routes', 'path');
  exact(errors, receipt?.probes?.roles, REQUIRED_ROLES, 'probes.roles', 'role');
  exact(errors, receipt?.probes?.workflows, REQUIRED_WORKFLOWS, 'probes.workflows', 'workflowId');
  exact(errors, receipt?.probes?.i18nLayout?.locales, REQUIRED_LOCALES, 'probes.i18nLayout.locales', null);
  exact(errors, receipt?.probes?.i18nLayout?.viewports, REQUIRED_VIEWPORTS, 'probes.i18nLayout.viewports', null);
  if (receipt?.environment?.deployedSourceCommit !== receipt?.sourceCommit) {
    errors.push('environment.deployedSourceCommit 必须与 sourceCommit 一致');
  }
  if (receipt?.environment?.deployedDeploymentCommit !== receipt?.deploymentCommit) {
    errors.push('environment.deployedDeploymentCommit 必须与 deploymentCommit 一致');
  }
  return errors;
}

export function checkFe16To19TargetEvidence(root, relativeReceipt, expectedSourceCommit, context) {
  const path = resolve(root, relativeReceipt);
  if (!existsSync(path)) return [`缺少 FE-16～FE-19 目标环境回执: ${relativeReceipt}；状态为 NOT RUN / NO RECEIPT`];
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return [`目标环境回执不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = validateFe16To19TargetEvidence(root, receipt, context);
  errors.push(
    ...validateReceiptBinding(root, relativeReceipt, receipt, context, 'check-admin-web-fe16-19-target-evidence.mjs'),
  );
  if (expectedSourceCommit && receipt.sourceCommit !== expectedSourceCommit) {
    errors.push(`sourceCommit 与待发布提交不一致: expected ${expectedSourceCommit}, received ${receipt.sourceCommit}`);
  }
  return errors;
}

function main() {
  const root = process.cwd();
  const relativeReceipt =
    process.env.FDP_ADMIN_WEB_FE16_19_TARGET_RECEIPT ?? 'docs/audit/evidence/fe-16-19-admin-web-target.json';
  runTargetEvidenceCli(
    root,
    'check-admin-web-fe16-19-target-evidence.mjs',
    relativeReceipt,
    checkFe16To19TargetEvidence,
    'FE-16～FE-19 管理后台目标环境证据 PASS',
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
