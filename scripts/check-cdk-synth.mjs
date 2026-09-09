#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

export const DELIVERED_LAMBDA_LOGICAL_ID_PREFIXES = [
  'IngestionFn',
  'ArchiveFn',
  'OutboxPublisherFn',
  'NotificationPublisherFn',
  'SummaryFn',
  'ReplayTriggerPublisherFn',
  'ReplayFn',
  'CertPackageSweeperFn',
  'OnboardingDeadlineFn',
  'RetirementTimeoutFn',
  'CommandPublisherFn',
  'CommandTimeoutFn',
  'OtaDispatcherFn',
  'OnboardingApiFn',
  'OnboardingProvisioningFn',
  'DeviceApiFn',
  'ApiFn',
];

export function findCdkWarnings(output) {
  return output.split(/\r?\n/u).filter((line) => /(?:\bWARNING\b|\[Warning at |\bF\d{4}\b)/iu.test(line));
}

export function findDeliveredLambdaAssetErrors(templates, prefixes = DELIVERED_LAMBDA_LOGICAL_ID_PREFIXES) {
  const functions = templates.flatMap((template) =>
    Object.entries(template.Resources ?? {})
      .filter(([, resource]) => resource.Type === 'AWS::Lambda::Function')
      .map(([logicalId, resource]) => ({ logicalId, code: resource.Properties?.Code })),
  );
  const errors = [];
  for (const prefix of prefixes) {
    const matches = functions.filter(({ logicalId }) => logicalId.startsWith(prefix));
    if (matches.length === 0) {
      errors.push(`已交付 Lambda 缺失: ${prefix}`);
      continue;
    }
    for (const match of matches) {
      if (!match.code || typeof match.code !== 'object' || 'ZipFile' in match.code) {
        errors.push(`已交付 Lambda 仍使用内联/占位代码: ${match.logicalId}`);
      }
    }
  }
  return errors;
}

const resourcesOfType = (template, type) =>
  Object.entries(template.Resources ?? {}).filter(([, resource]) => resource.Type === type);

const roleLogicalIdOf = (fn) => fn.Properties?.Role?.['Fn::GetAtt']?.[0];

function statementsForRole(template, roleLogicalId) {
  const statements = [];
  const role = template.Resources?.[roleLogicalId];
  for (const policy of role?.Properties?.Policies ?? []) {
    statements.push(...(policy.PolicyDocument?.Statement ?? []));
  }
  for (const [, policy] of resourcesOfType(template, 'AWS::IAM::Policy')) {
    const roles = policy.Properties?.Roles ?? [];
    if (roles.some((candidate) => candidate?.Ref === roleLogicalId)) {
      statements.push(...(policy.Properties?.PolicyDocument?.Statement ?? []));
    }
  }
  return statements;
}

const actionsOf = (statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
const containsResource = (statement, fragment) => JSON.stringify(statement.Resource ?? '').includes(fragment);

/** P2 CMD/OTA 生产接线 Gate：基于 synth 后 CloudFormation 验证 Worker、调度/DLQ 与最小权限。 */
export function findCmdOtaDeliveryErrors(templates) {
  const errors = [];
  const allFunctions = templates.flatMap((template) =>
    resourcesOfType(template, 'AWS::Lambda::Function').map(([logicalId, resource]) => ({
      template,
      logicalId,
      resource,
    })),
  );
  const findFunction = (suffix) =>
    allFunctions.find(({ resource }) => String(resource.Properties?.FunctionName ?? '').endsWith(suffix));
  const functions = {
    commandPublisher: findFunction('-command-publisher'),
    commandTimeout: findFunction('-command-timeout'),
    otaDispatcher: findFunction('-ota-dispatcher'),
    adminApi: findFunction('-api'),
    deviceApi: findFunction('-device-api-handler'),
  };
  for (const [name, entry] of Object.entries(functions)) {
    if (!entry) errors.push(`CMD/OTA Lambda 缺失: ${name}`);
  }
  for (const [name, entry] of Object.entries({
    commandPublisher: functions.commandPublisher,
    commandTimeout: functions.commandTimeout,
    otaDispatcher: functions.otaDispatcher,
  })) {
    if (entry && !entry.resource.Properties?.Environment?.Variables?.DB_SECRET_ARN) {
      errors.push(`CMD/OTA Worker 数据库配置缺失: ${name}`);
    }
  }

  for (const suffix of ['-command-publisher', '-command-timeout', '-ota-dispatcher']) {
    const rule = templates
      .flatMap((template) => resourcesOfType(template, 'AWS::Events::Rule').map(([, resource]) => resource))
      .find((resource) => String(resource.Properties?.Name ?? '').endsWith(suffix));
    if (!rule || rule.Properties?.ScheduleExpression !== 'rate(1 minute)') {
      errors.push(`CMD/OTA 每分钟调度缺失: ${suffix.slice(1)}`);
    } else if (!(rule.Properties?.Targets ?? []).every((target) => target.DeadLetterConfig?.Arn)) {
      errors.push(`CMD/OTA 调度 DLQ 缺失: ${suffix.slice(1)}`);
    }
  }

  const requireStatement = (entry, description, predicate) => {
    if (!entry) return;
    const roleId = roleLogicalIdOf(entry.resource);
    const statements = roleId ? statementsForRole(entry.template, roleId) : [];
    if (!statements.some(predicate)) errors.push(`CMD/OTA IAM 缺失: ${description}`);
  };
  requireStatement(
    functions.commandPublisher,
    'Command Publisher iot:Publish bnx/device/*/cmd',
    (s) => actionsOf(s).includes('iot:Publish') && containsResource(s, 'bnx/device/*/cmd'),
  );
  for (const [name, entry] of Object.entries({
    commandPublisher: functions.commandPublisher,
    commandTimeout: functions.commandTimeout,
    otaDispatcher: functions.otaDispatcher,
  })) {
    requireStatement(entry, `${name} Secrets Manager database access`, (s) =>
      actionsOf(s).includes('secretsmanager:GetSecretValue'),
    );
  }
  requireStatement(
    functions.otaDispatcher,
    'OTA Dispatcher iot:Publish bnx/device/*/ota',
    (s) => actionsOf(s).includes('iot:Publish') && containsResource(s, 'bnx/device/*/ota'),
  );
  requireStatement(
    functions.adminApi,
    'Admin API OTA S3 read/write',
    (s) => actionsOf(s).includes('s3:PutObject') && containsResource(s, 'Ota'),
  );
  requireStatement(
    functions.adminApi,
    'Admin API KMS Verify',
    (s) => actionsOf(s).includes('kms:Verify') && containsResource(s, 'OtaSigningKey'),
  );
  requireStatement(
    functions.deviceApi,
    'Device API OTA S3 read',
    (s) => actionsOf(s).some((action) => action?.startsWith('s3:GetObject')) && containsResource(s, 'Ota'),
  );
  if (functions.otaDispatcher) {
    const env = functions.otaDispatcher.resource.Properties?.Environment?.Variables ?? {};
    if (!env.DEVICE_API_BASE_URL || env.OTA_BUCKET_NAME) {
      errors.push('CMD/OTA OTA Dispatcher 必须使用 Device API，且不得直接持有 OTA_BUCKET_NAME');
    }
    const roleId = roleLogicalIdOf(functions.otaDispatcher.resource);
    if (
      roleId &&
      statementsForRole(functions.otaDispatcher.template, roleId).some((s) =>
        actionsOf(s).some((a) => a?.startsWith('s3:')),
      )
    ) {
      errors.push('CMD/OTA OTA Dispatcher 不得持有 S3 data-plane 权限');
    }
  }
  return errors;
}

function loadSynthTemplates(root) {
  const outputDir = resolve(root, 'infra/cdk.out');
  return readdirSync(outputDir)
    .filter((file) => file.endsWith('.template.json'))
    .map((file) => JSON.parse(readFileSync(resolve(outputDir, file), 'utf8')));
}

export function checkCdkSynth(root = process.cwd()) {
  const executable = resolve(root, 'infra/node_modules/.bin/cdk');
  const run = spawnSync(executable, ['synth', '--quiet'], { cwd: resolve(root, 'infra'), encoding: 'utf8' });
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  if (run.status !== 0) throw new Error(`cdk synth 失败（exit ${run.status ?? 'unknown'}）\n${output}`);
  const warnings = findCdkWarnings(output);
  if (warnings.length > 0) throw new Error(`cdk synth 存在警告：\n${warnings.join('\n')}`);
  const templates = loadSynthTemplates(root);
  const assetErrors = findDeliveredLambdaAssetErrors(templates);
  if (assetErrors.length > 0) throw new Error(`cdk synth 已交付 Lambda Gate 失败：\n${assetErrors.join('\n')}`);
  const cmdOtaErrors = findCmdOtaDeliveryErrors(templates);
  if (cmdOtaErrors.length > 0) throw new Error(`CMD/OTA 生产接线 Gate 失败：\n${cmdOtaErrors.join('\n')}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  checkCdkSynth(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log('CDK synth 无 warning；已交付 Lambda asset 与 CMD/OTA 生产接线 Gate 通过');
}
