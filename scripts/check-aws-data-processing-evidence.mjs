#!/usr/bin/env node
/**
 * BE-ARC-01/02、BE-RPL-01、BE-ESG-01 目标 AWS 验收回执 Gate。
 * 本地测试、mock、CDK synth 或文字声明均不能替代此结构化回执。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REQUIRED_PROBES = {
  archive: ['outbox', 'archiveQueue', 's3Object', 'manifest', 'duplicateDelivery', 'partialFailure'],
  replay: ['apiCreate', 'triggerQueue', 'worker', 'idempotency', 'outOfScope'],
  summary: ['scheduleInvocation', 'migration', 'hourly', 'daily', 'esgDaily'],
};

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePassedProbe(errors, probe, path) {
  if (!isRecord(probe)) {
    errors.push(`${path} 必须为对象`);
    return;
  }
  if (probe.passed !== true) errors.push(`${path}.passed 必须为 true`);
  if (!Array.isArray(probe.evidence) || probe.evidence.length === 0) {
    errors.push(`${path}.evidence 必须包含目标环境资源或请求引用`);
  } else if (probe.evidence.some((item) => typeof item !== 'string' || item.trim() === '')) {
    errors.push(`${path}.evidence 每项必须为非空字符串`);
  }
}

export function validateAwsDataProcessingEvidence(receipt) {
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
    for (const key of ['accountId', 'region', 'stackName']) {
      if (typeof receipt.environment[key] !== 'string' || receipt.environment[key].trim() === '') {
        errors.push(`environment.${key} 必须为非空字符串`);
      }
    }
  }

  for (const [group, names] of Object.entries(REQUIRED_PROBES)) {
    for (const name of names) validatePassedProbe(errors, receipt.probes?.[group]?.[name], `probes.${group}.${name}`);
  }

  const s3Object = receipt.probes?.archive?.s3Object;
  if (isRecord(s3Object) && !SHA256.test(s3Object.sha256 ?? '')) {
    errors.push('probes.archive.s3Object.sha256 必须为 64 位小写 SHA-256');
  }
  const manifest = receipt.probes?.archive?.manifest;
  if (isRecord(manifest) && manifest.sha256 !== s3Object?.sha256) {
    errors.push('probes.archive.manifest.sha256 必须与 S3 对象复算 Hash 一致');
  }
  const duplicate = receipt.probes?.archive?.duplicateDelivery;
  if (
    isRecord(duplicate) &&
    (!Number.isInteger(duplicate.deliveryCount) || duplicate.deliveryCount < 2 || duplicate.logicalRecordCount !== 1)
  ) {
    errors.push('probes.archive.duplicateDelivery 必须证明至少两次投递仅产生一条逻辑记录');
  }
  const partialFailure = receipt.probes?.archive?.partialFailure;
  if (
    isRecord(partialFailure) &&
    (!Number.isInteger(partialFailure.failedCount) ||
      partialFailure.failedCount < 1 ||
      !Number.isInteger(partialFailure.succeededCount) ||
      partialFailure.succeededCount < 1)
  ) {
    errors.push('probes.archive.partialFailure 必须同时证明失败记录与成功记录');
  }
  const idempotency = receipt.probes?.replay?.idempotency;
  if (isRecord(idempotency) && idempotency.duplicateBusinessRows !== 0) {
    errors.push('probes.replay.idempotency.duplicateBusinessRows 必须为 0');
  }
  for (const name of ['hourly', 'daily', 'esgDaily']) {
    const probe = receipt.probes?.summary?.[name];
    if (isRecord(probe) && (!Number.isInteger(probe.rowCount) || probe.rowCount < 1)) {
      errors.push(`probes.summary.${name}.rowCount 必须为正整数`);
    }
  }

  validatePassedProbe(errors, receipt.cleanup, 'cleanup');
  if (isRecord(receipt.cleanup) && receipt.cleanup.completed !== true) {
    errors.push('cleanup.completed 必须为 true');
  }
  return errors;
}

export function checkAwsDataProcessingEvidence(root, relativeReceipt, expectedSourceCommit) {
  const path = resolve(root, relativeReceipt);
  if (!existsSync(path)) return [`缺少目标 AWS 数据处理回执: ${relativeReceipt}`];
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return [`目标 AWS 数据处理回执不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = validateAwsDataProcessingEvidence(receipt);
  if (expectedSourceCommit && receipt.sourceCommit !== expectedSourceCommit) {
    errors.push(`sourceCommit 与待发布提交不一致: expected ${expectedSourceCommit}, received ${receipt.sourceCommit}`);
  }
  return errors;
}

function main() {
  const root = process.cwd();
  const relativeReceipt =
    process.env.FDP_AWS_DATA_PROCESSING_RECEIPT ?? 'docs/audit/evidence/be-arc-rpl-esg-aws-data-processing.json';
  const expectedSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const errors = checkAwsDataProcessingEvidence(root, relativeReceipt, expectedSourceCommit);
  for (const error of errors) process.stderr.write(`${error}\n`);
  if (errors.length === 0) process.stdout.write('BE-ARC/RPL/ESG 目标 AWS 数据处理证据 PASS\n');
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
