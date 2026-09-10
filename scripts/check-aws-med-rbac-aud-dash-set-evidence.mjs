#!/usr/bin/env node
/**
 * BE-MED/RBAC/AUD/DASH/SET 目标 AWS 验收回执 Gate。
 * 本地测试、PGlite、mock 与 CDK synth 均不能替代目标环境回执；缺失时失败关闭。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REQUIRED_OPERATIONS = [
  'createMediaUploadSession',
  'listMedia',
  'createMediaDownloadUrl',
  'listUsers',
  'inviteUser',
  'assignUserRoles',
  'setUserScope',
  'disableUser',
  'triggerUserPasswordReset',
  'listAuditLogs',
  'getAuditLogDetail',
  'getDashboardOverview',
  'listSettings',
  'getSetting',
  'updateSetting',
];

export const REQUIRED_ROLES = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];

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

export function validateEvidence(receipt) {
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
    for (const key of ['accountId', 'region', 'stackName', 'apiBaseUrl', 'userPoolId', 'mediaBucket']) {
      requireString(errors, receipt.environment[key], `environment.${key}`);
    }
  }

  const operations = receipt.probes?.apiOperations;
  if (exact(errors, operations, REQUIRED_OPERATIONS, 'probes.apiOperations', 'operationId')) {
    operations.forEach((probe, index) => {
      const path = `probes.apiOperations[${index}]`;
      passed(errors, probe, path);
      requireString(errors, probe.requestId, `${path}.requestId`);
      const expected =
        probe.operationId === 'createMediaUploadSession' || probe.operationId === 'inviteUser' ? 201 : 200;
      if (probe.successStatus !== expected) errors.push(`${path}.successStatus 与契约不一致`);
      if (
        !Array.isArray(probe.negativeStatuses) ||
        !probe.negativeStatuses.includes(401) ||
        !probe.negativeStatuses.some((status) => status >= 400 && status !== 401)
      ) {
        errors.push(`${path}.negativeStatuses 必须包含 401 和至少一个其他失败状态`);
      }
    });
  }

  const roles = receipt.probes?.rbac?.roles;
  if (exact(errors, roles, REQUIRED_ROLES, 'probes.rbac.roles', 'role')) {
    roles.forEach((probe, index) => passed(errors, probe, `probes.rbac.roles[${index}]`));
  }
  passed(errors, receipt.probes?.rbac?.crossCustomer, 'probes.rbac.crossCustomer');
  if (
    isRecord(receipt.probes?.rbac?.crossCustomer) &&
    ![403, 404].includes(receipt.probes.rbac.crossCustomer.deniedStatus)
  ) {
    errors.push('跨 Customer 必须返回 403 或 404');
  }

  const cognito = receipt.probes?.cognito;
  passed(errors, cognito, 'probes.cognito');
  if (isRecord(cognito)) {
    for (const key of [
      'inviteObserved',
      'groupsSynchronized',
      'customerScopeSynchronized',
      'disableObserved',
      'passwordResetObserved',
      'compensationObserved',
    ]) {
      if (cognito[key] !== true) errors.push(`probes.cognito.${key} 必须为 true`);
    }
  }

  const superAdminRace = receipt.probes?.superAdminRace;
  passed(errors, superAdminRace, 'probes.superAdminRace');
  if (
    isRecord(superAdminRace) &&
    (superAdminRace.successCount !== 1 ||
      superAdminRace.conflictCount !== 1 ||
      superAdminRace.effectiveSuperAdminCount < 1)
  ) {
    errors.push('最后 SuperAdmin 并发必须一成功一冲突且至少保留一个有效 SuperAdmin');
  }
  const settingRace = receipt.probes?.settingVersionRace;
  passed(errors, settingRace, 'probes.settingVersionRace');
  if (
    isRecord(settingRace) &&
    (settingRace.successCount !== 1 || settingRace.conflictCount !== 1 || settingRace.conflictStatus !== 409)
  ) {
    errors.push('设置版本并发必须恰好一成功、一 409 冲突');
  }

  const s3 = receipt.probes?.mediaS3;
  passed(errors, s3, 'probes.mediaS3');
  if (isRecord(s3)) {
    if (
      s3.serverGeneratedKey !== true ||
      s3.contentLengthBound !== true ||
      s3.sha256Bound !== true ||
      s3.hashVerified !== true
    )
      errors.push('Media S3 必须证明服务端 Key、大小与 Hash 绑定及复核');
    if (s3.uploadUrlTtlSeconds !== 900 || s3.downloadUrlTtlSeconds !== 900 || s3.expiredUrlRejected !== true)
      errors.push('Media S3 URL 必须证明 DEC-024 的 900 秒 TTL 与过期拒绝');
  }
  const quota = receipt.probes?.mediaQuotaRace;
  passed(errors, quota, 'probes.mediaQuotaRace');
  if (
    isRecord(quota) &&
    (quota.quota !== 100 ||
      quota.requestCount !== 101 ||
      quota.successCount !== 100 ||
      quota.conflictCount !== 1 ||
      quota.issuedSessionCount !== 100)
  ) {
    errors.push('Media 配额并发必须证明 101 请求仅 100 成功且仅签发 100 会话');
  }

  const dashboard = receipt.probes?.dashboardEntitlement;
  passed(errors, dashboard, 'probes.dashboardEntitlement');
  if (
    isRecord(dashboard) &&
    (dashboard.activeEntitlementAllowed !== true ||
      dashboard.noLicenseDenied !== true ||
      dashboard.expiredDenied !== true ||
      dashboard.revokedDenied !== true ||
      dashboard.missingEntitlementDenied !== true)
  ) {
    errors.push('Dashboard 必须覆盖有效、无 License、过期、吊销和无 Entitlement 判定');
  }

  const audit = receipt.probes?.auditRedaction;
  passed(errors, audit, 'probes.auditRedaction');
  if (isRecord(audit)) {
    const requiredFields = [
      'authorization',
      'cookie',
      'set-cookie',
      'session',
      'jwt',
      'refreshToken',
      'accessToken',
      'idToken',
    ];
    if (
      audit.noSensitiveValuesReturned !== true ||
      !Array.isArray(audit.redactedFields) ||
      requiredFields.some((field) => !audit.redactedFields.includes(field))
    ) {
      errors.push('审计脱敏必须覆盖全部必需凭据字段且不得返回敏感值');
    }
  }

  const strict = receipt.probes?.strictRequests;
  passed(errors, strict, 'probes.strictRequests');
  if (
    isRecord(strict) &&
    (strict.unknownFieldStatus !== 400 ||
      strict.arrayBodyStatus !== 400 ||
      strict.passwordFieldStatus !== 400 ||
      strict.sideEffectsObserved !== 0)
  ) {
    errors.push('严格请求必须在副作用前拒绝未知字段、数组和 password');
  }

  passed(errors, receipt.cleanup, 'cleanup');
  if (isRecord(receipt.cleanup) && receipt.cleanup.completed !== true) errors.push('cleanup.completed 必须为 true');
  return errors;
}

export function checkEvidence(root, relativeReceipt, expectedSourceCommit) {
  const path = resolve(root, relativeReceipt);
  if (!existsSync(path)) return [`缺少目标 AWS BE-MED/RBAC/AUD/DASH/SET 回执: ${relativeReceipt}`];
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return [`目标 AWS 回执不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = validateEvidence(receipt);
  if (expectedSourceCommit && receipt.sourceCommit !== expectedSourceCommit)
    errors.push(`sourceCommit 与待发布提交不一致: expected ${expectedSourceCommit}, received ${receipt.sourceCommit}`);
  return errors;
}

function main() {
  const root = process.cwd();
  const relativeReceipt =
    process.env.FDP_AWS_MED_RBAC_AUD_DASH_SET_RECEIPT ??
    'docs/audit/evidence/be-med-rbac-aud-dash-set-aws-acceptance.json';
  const expectedSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const errors = checkEvidence(root, relativeReceipt, expectedSourceCommit);
  errors.forEach((error) => process.stderr.write(`${error}\n`));
  if (errors.length === 0) process.stdout.write('BE-MED/RBAC/AUD/DASH/SET 目标 AWS 证据 PASS\n');
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
