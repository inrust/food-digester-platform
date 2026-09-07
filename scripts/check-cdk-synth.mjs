#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

export const DELIVERED_LAMBDA_LOGICAL_ID_PREFIXES = [
  'IngestionFn',
  'OutboxPublisherFn',
  'CertPackageSweeperFn',
  'OnboardingDeadlineFn',
  'RetirementTimeoutFn',
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
  const assetErrors = findDeliveredLambdaAssetErrors(loadSynthTemplates(root));
  if (assetErrors.length > 0) throw new Error(`cdk synth 已交付 Lambda Gate 失败：\n${assetErrors.join('\n')}`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  checkCdkSynth(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log('CDK synth 无 warning，已交付 Lambda 全部使用真实 asset');
}
