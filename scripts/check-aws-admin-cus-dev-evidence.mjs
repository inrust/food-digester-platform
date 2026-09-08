#!/usr/bin/env node
/**
 * BE-CUS-01/02、BE-DEV-01～06 目标 AWS 验收回执 Gate。
 * 本地测试、mock、CDK synth 或人工声明不能替代隔离 AWS 回执；缺失时失败关闭。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REQUIRED_ADMIN_OPERATIONS = [
  'listCustomers',
  'createCustomer',
  'getCustomer',
  'updateCustomer',
  'deleteCustomer',
  'deactivateCustomer',
  'listSites',
  'createSite',
  'getSite',
  'updateSite',
  'deleteSite',
  'deactivateSite',
  'listDevices',
  'getDevice',
  'updateDeviceMetadata',
  'assignDevice',
  'listDeviceAssignments',
  'suspendDevice',
  'reactivateDevice',
  'retireDevice',
  'forceCompleteRetirement',
  'getDeviceConsole',
  'listDeviceActivities',
  'createActivityExport',
  'getActivityExport',
];

export const REQUIRED_ROLES = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];

export const RETIRED_MQTT_TYPES = ['heartbeat', 'telemetry', 'report', 'alarm', 'event', 'ack', 'tamper', 'media'];

const SUCCESS_STATUS_BY_OPERATION = Object.fromEntries(REQUIRED_ADMIN_OPERATIONS.map((id) => [id, 200]));
SUCCESS_STATUS_BY_OPERATION.createCustomer = 201;
SUCCESS_STATUS_BY_OPERATION.createSite = 201;
SUCCESS_STATUS_BY_OPERATION.createActivityExport = 202;

const COMMIT = /^[a-f0-9]{40}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireString(errors, value, path) {
  if (typeof value !== 'string' || value.trim() === '') errors.push(`${path} 必须为非空字符串`);
}

function validatePassedProbe(errors, probe, path) {
  if (!isRecord(probe)) {
    errors.push(`${path} 必须为对象`);
    return;
  }
  if (probe.passed !== true) errors.push(`${path}.passed 必须为 true`);
  if (!Array.isArray(probe.evidence) || probe.evidence.length === 0) {
    errors.push(`${path}.evidence 必须包含目标环境请求或资源引用`);
  } else {
    probe.evidence.forEach((item, index) => requireString(errors, item, `${path}.evidence[${index}]`));
  }
}

function validateExactNames(errors, rows, required, path, field) {
  if (!Array.isArray(rows) || rows.length !== required.length) {
    errors.push(`${path} 必须恰好包含 ${required.length} 项`);
    return false;
  }
  const names = rows.map((row) => row?.[field]);
  if (new Set(names).size !== required.length || required.some((name) => !names.includes(name))) {
    errors.push(`${path} 必须无重复覆盖 ${required.join(',')}`);
    return false;
  }
  return true;
}

export function validateAwsAdminCusDevEvidence(receipt) {
  const errors = [];
  if (!isRecord(receipt)) return ['回执根节点必须为对象'];
  if (receipt.schemaVersion !== '1.0') errors.push('schemaVersion 必须为 1.0');
  if (receipt.status !== 'PASS') errors.push('status 必须为 PASS');
  if (!COMMIT.test(receipt.sourceCommit ?? '')) errors.push('sourceCommit 必须为 40 位小写 Git SHA');
  if (!ISO_INSTANT.test(receipt.executedAt ?? '') || !Number.isFinite(Date.parse(receipt.executedAt))) {
    errors.push('executedAt 必须为 UTC ISO-8601 时刻');
  }

  if (!isRecord(receipt.environment)) {
    errors.push('environment 必须为对象');
  } else {
    if (receipt.environment.isolated !== true) errors.push('environment.isolated 必须为 true');
    for (const key of ['accountId', 'region', 'stackName', 'apiBaseUrl']) {
      requireString(errors, receipt.environment[key], `environment.${key}`);
    }
  }

  const operations = receipt.probes?.apiOperations;
  if (validateExactNames(errors, operations, REQUIRED_ADMIN_OPERATIONS, 'probes.apiOperations', 'operationId')) {
    operations.forEach((probe, index) => {
      const path = `probes.apiOperations[${index}]`;
      validatePassedProbe(errors, probe, path);
      requireString(errors, probe?.requestId, `${path}.requestId`);
      if (probe?.successStatus !== SUCCESS_STATUS_BY_OPERATION[probe?.operationId]) {
        errors.push(`${path}.successStatus 与 operation 契约不一致`);
      }
      if (
        !Array.isArray(probe?.negativeStatuses) ||
        !probe.negativeStatuses.includes(401) ||
        !probe.negativeStatuses.some((status) => status >= 400 && status !== 401)
      ) {
        errors.push(`${path}.negativeStatuses 必须包含 401 和至少一个其他 4xx/5xx 负向结果`);
      }
    });
  }

  const roles = receipt.probes?.rbac?.roles;
  if (validateExactNames(errors, roles, REQUIRED_ROLES, 'probes.rbac.roles', 'role')) {
    roles.forEach((probe, index) => validatePassedProbe(errors, probe, `probes.rbac.roles[${index}]`));
  }
  const crossCustomer = receipt.probes?.rbac?.crossCustomer;
  validatePassedProbe(errors, crossCustomer, 'probes.rbac.crossCustomer');
  if (isRecord(crossCustomer) && ![403, 404].includes(crossCustomer.deniedStatus)) {
    errors.push('probes.rbac.crossCustomer.deniedStatus 必须为 403 或 404');
  }

  const race = receipt.probes?.ifMatchRace;
  validatePassedProbe(errors, race, 'probes.ifMatchRace');
  if (isRecord(race) && (race.successCount !== 1 || race.conflictCount !== 1 || race.conflictStatus !== 409)) {
    errors.push('probes.ifMatchRace 必须证明并发请求恰好一成功、一 409 冲突');
  }

  const retirement = receipt.probes?.retirement;
  validatePassedProbe(errors, retirement, 'probes.retirement');
  if (isRecord(retirement)) {
    if (retirement.awsIotCertificateStatus !== 'INACTIVE') {
      errors.push('probes.retirement.awsIotCertificateStatus 必须为 INACTIVE');
    }
    const mqttComplete = validateExactNames(
      errors,
      retirement.mqttDenied,
      RETIRED_MQTT_TYPES,
      'probes.retirement.mqttDenied',
      'type',
    );
    if (mqttComplete) {
      retirement.mqttDenied.forEach((probe, index) => {
        validatePassedProbe(errors, probe, `probes.retirement.mqttDenied[${index}]`);
        if (probe.processedMessages !== 0) {
          errors.push(`probes.retirement.mqttDenied[${index}].processedMessages 必须为 0`);
        }
      });
    }
  }

  const activityExport = receipt.probes?.activityExport;
  validatePassedProbe(errors, activityExport, 'probes.activityExport');
  if (isRecord(activityExport)) {
    if (activityExport.snapshotAfterCreatedRows !== 0) {
      errors.push('probes.activityExport.snapshotAfterCreatedRows 必须为 0');
    }
    if (![403, 404].includes(activityExport.crossCustomerStatus)) {
      errors.push('probes.activityExport.crossCustomerStatus 必须为 403 或 404');
    }
    if (activityExport.expiredDownloadUrl !== null || activityExport.urlExpired !== true) {
      errors.push('probes.activityExport 必须证明 URL 过期后 downloadUrl=null 且 urlExpired=true');
    }
    requireString(errors, activityExport.s3ObjectKey, 'probes.activityExport.s3ObjectKey');
  }

  validatePassedProbe(errors, receipt.cleanup, 'cleanup');
  if (isRecord(receipt.cleanup) && receipt.cleanup.completed !== true) errors.push('cleanup.completed 必须为 true');
  return errors;
}

export function checkAwsAdminCusDevEvidence(root, relativeReceipt, expectedSourceCommit) {
  const path = resolve(root, relativeReceipt);
  if (!existsSync(path)) return [`缺少目标 AWS 管理后台回执: ${relativeReceipt}`];
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return [`目标 AWS 管理后台回执不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = validateAwsAdminCusDevEvidence(receipt);
  if (expectedSourceCommit && receipt.sourceCommit !== expectedSourceCommit) {
    errors.push(`sourceCommit 与待发布提交不一致: expected ${expectedSourceCommit}, received ${receipt.sourceCommit}`);
  }
  return errors;
}

function main() {
  const root = process.cwd();
  const relativeReceipt =
    process.env.FDP_AWS_ADMIN_CUS_DEV_RECEIPT ?? 'docs/audit/evidence/be-cus-dev-aws-acceptance.json';
  const expectedSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const errors = checkAwsAdminCusDevEvidence(root, relativeReceipt, expectedSourceCommit);
  for (const error of errors) process.stderr.write(`${error}\n`);
  if (errors.length === 0) process.stdout.write('BE-CUS-01/02、BE-DEV-01～06 目标 AWS 证据 PASS\n');
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
