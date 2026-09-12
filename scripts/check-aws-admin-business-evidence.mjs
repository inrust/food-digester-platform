#!/usr/bin/env node
/**
 * BE-LIC/CON/CFG/CNS/DUSR/ALM/ESG 目标 AWS 验收回执 Gate。
 * 本地测试、mock、CDK synth 或人工声明不能替代隔离 AWS 回执；缺失时失败关闭。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REQUIRED_ADMIN_BUSINESS_OPERATIONS = [
  'listLicenses',
  'createLicense',
  'getLicense',
  'listLicenseHistory',
  'issueLicense',
  'activateLicense',
  'renewLicense',
  'revokeLicense',
  'evaluateLicense',
  'createContract',
  'listContracts',
  'getContract',
  'updateContract',
  'activateContract',
  'renewContract',
  'terminateContract',
  'evaluateContract',
  'listContractDevices',
  'listAvailableDevices',
  'listContractAssociations',
  'bindContractDevices',
  'unbindContractDevices',
  'createConfiguration',
  'listConfigurations',
  'getConfiguration',
  'createConfigurationVersion',
  'publishConfigurationVersion',
  'getConfigurationVersion',
  'getConfigurationVersionStatus',
  'listConsumableStatus',
  'getConsumableContact',
  'createConsumableRequest',
  'listConsumableRequests',
  'getConsumableRequest',
  'processConsumableRequest',
  'completeConsumableRequest',
  'cancelConsumableRequest',
  'createDeviceUser',
  'listDeviceUsers',
  'getDeviceUser',
  'updateDeviceUser',
  'disableDeviceUser',
  'assignDeviceUser',
  'revokeDeviceUser',
  'listAlarms',
  'getAlarm',
  'acknowledgeAlarm',
  'clearAlarm',
  'listDeviceEvents',
  'listTamperEvents',
  'getEsgOverview',
  'listEsgHourly',
  'listEsgDaily',
  'listEsgReports',
  'listEsgDailySummary',
  'listEsgCalculationVersions',
  'createEsgExport',
  'getEsgExport',
];

export const REQUIRED_ADMIN_BUSINESS_ROLES = [
  'PlatformSuperAdmin',
  'PlatformOperator',
  'Auditor',
  'CustomerAdmin',
  'CustomerViewer',
];

const CREATED = new Set([
  'createLicense',
  'createContract',
  'bindContractDevices',
  'createConfiguration',
  'createConfigurationVersion',
  'createConsumableRequest',
  'createDeviceUser',
  'assignDeviceUser',
]);
const expectedStatus = (operationId) =>
  operationId === 'createEsgExport' ? 202 : CREATED.has(operationId) ? 201 : 200;
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

export function validateAwsAdminBusinessEvidence(receipt) {
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
    for (const key of ['accountId', 'region', 'stackName', 'apiBaseUrl'])
      requireString(errors, receipt.environment[key], `environment.${key}`);
  }

  const operations = receipt.probes?.apiOperations;
  if (exact(errors, operations, REQUIRED_ADMIN_BUSINESS_OPERATIONS, 'probes.apiOperations', 'operationId')) {
    operations.forEach((probe, index) => {
      const path = `probes.apiOperations[${index}]`;
      passed(errors, probe, path);
      requireString(errors, probe.requestId, `${path}.requestId`);
      if (probe.successStatus !== expectedStatus(probe.operationId)) errors.push(`${path}.successStatus 与契约不一致`);
      if (
        !Array.isArray(probe.negativeStatuses) ||
        !probe.negativeStatuses.includes(401) ||
        !probe.negativeStatuses.some((status) => status >= 400 && status !== 401)
      ) {
        errors.push(`${path}.negativeStatuses 必须包含 401 和至少一个其他 4xx/5xx`);
      }
    });
  }

  const roles = receipt.probes?.rbac?.roles;
  if (exact(errors, roles, REQUIRED_ADMIN_BUSINESS_ROLES, 'probes.rbac.roles', 'role')) {
    roles.forEach((probe, index) => passed(errors, probe, `probes.rbac.roles[${index}]`));
  }
  const crossCustomer = receipt.probes?.rbac?.crossCustomer;
  passed(errors, crossCustomer, 'probes.rbac.crossCustomer');
  if (isRecord(crossCustomer) && ![403, 404].includes(crossCustomer.deniedStatus))
    errors.push('跨 Customer 必须返回 403 或 404');

  const race = receipt.probes?.ifMatchRace;
  passed(errors, race, 'probes.ifMatchRace');
  if (isRecord(race) && (race.successCount !== 1 || race.conflictCount !== 1 || race.conflictStatus !== 409)) {
    errors.push('If-Match 并发必须恰好一成功、一 409 冲突');
  }

  const notifier = receipt.probes?.businessNotifier;
  passed(errors, notifier, 'probes.businessNotifier');
  if (isRecord(notifier)) {
    if (!(notifier.scheduleMinutes > 0 && notifier.scheduleMinutes <= 1)) errors.push('通知调度必须不超过 1 分钟');
    if (notifier.emailProvider !== 'SES_V2' || notifier.webhookHttpsAllowlist !== true)
      errors.push('通知必须证明 SES_V2 与 HTTPS allowlist');
    for (const key of ['processingClaimObserved', 'providerRequestIdRecorded', 'retryRecovered']) {
      if (notifier[key] !== true) errors.push(`probes.businessNotifier.${key} 必须为 true`);
    }
    if (notifier.concurrentSendCount !== 1) errors.push('并发通知必须仅发送一次');
  }

  const esg = receipt.probes?.esgExport;
  passed(errors, esg, 'probes.esgExport');
  if (isRecord(esg)) {
    if (!(esg.scheduleMinutes > 0 && esg.scheduleMinutes <= 1)) errors.push('ESG 导出调度必须不超过 1 分钟');
    requireString(errors, esg.s3ObjectKey, 'probes.esgExport.s3ObjectKey');
    if (typeof esg.s3ObjectKey === 'string' && !esg.s3ObjectKey.startsWith('esg-exports/'))
      errors.push('ESG 对象 key 必须使用 esg-exports/ 前缀');
    if (esg.csvRowCount !== esg.queryRowCount) errors.push('ESG CSV 行数必须等于同筛选查询行数');
    if (![403, 404].includes(esg.crossCustomerStatus)) errors.push('ESG 跨 Customer 必须返回 403 或 404');
    if (esg.expiredDownloadUrl !== null || esg.urlExpired !== true) errors.push('ESG URL 过期后必须不可用');
    if (!(esg.lifecycleDays > 0 && esg.lifecycleDays <= 1)) errors.push('ESG 导出对象生命周期必须不超过 1 天');
    if (esg.expiredProcessingRecovered !== true) errors.push('ESG 必须证明过期 PROCESSING 可恢复');
  }

  passed(errors, receipt.cleanup, 'cleanup');
  if (isRecord(receipt.cleanup) && receipt.cleanup.completed !== true) errors.push('cleanup.completed 必须为 true');
  return errors;
}

export function checkAwsAdminBusinessEvidence(root, relativeReceipt, expectedSourceCommit) {
  const path = resolve(root, relativeReceipt);
  if (!existsSync(path)) return [`缺少目标 AWS 管理后台业务回执: ${relativeReceipt}`];
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return [`目标 AWS 管理后台业务回执不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = validateAwsAdminBusinessEvidence(receipt);
  if (expectedSourceCommit && receipt.sourceCommit !== expectedSourceCommit)
    errors.push(`sourceCommit 与待发布提交不一致: expected ${expectedSourceCommit}, received ${receipt.sourceCommit}`);
  return errors;
}

function main() {
  const root = process.cwd();
  const relativeReceipt =
    process.env.FDP_AWS_ADMIN_BUSINESS_RECEIPT ?? 'docs/audit/evidence/be-admin-business-aws-acceptance.json';
  const expectedSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const errors = checkAwsAdminBusinessEvidence(root, relativeReceipt, expectedSourceCommit);
  errors.forEach((error) => process.stderr.write(`${error}\n`));
  if (errors.length === 0) process.stdout.write('管理后台业务目标 AWS 证据 PASS\n');
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
