#!/usr/bin/env node
/**
 * BE-IOT-01 / QA-03 目标 AWS 数据链路证据 Gate。
 *
 * 本脚本不把 CDK synth、本地测试或人工声明当作云端验收。只有隔离 AWS 环境
 * 生成的结构化回执覆盖全部探针时才返回 0；缺失回执默认失败关闭。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const UPLINK_TYPES = ['heartbeat', 'telemetry', 'report', 'alarm', 'event', 'ack', 'tamper', 'media'];
export const QA03_PROBES = ['partialFailure', 'quarantine', 'receipt', 'rds', 'outbox', 'archiveQueue', 's3RawArchive'];

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(errors, value, path) {
  if (typeof value !== 'string' || value.trim().length === 0) errors.push(`${path} 必须为非空字符串`);
}

function validatePassedProbe(errors, probe, path) {
  if (!isRecord(probe)) {
    errors.push(`${path} 必须为对象`);
    return;
  }
  if (probe.passed !== true) errors.push(`${path}.passed 必须为 true`);
  if (!Array.isArray(probe.evidence) || probe.evidence.length === 0) {
    errors.push(`${path}.evidence 必须包含至少一条目标环境证据引用`);
  } else {
    probe.evidence.forEach((item, index) => requireString(errors, item, `${path}.evidence[${index}]`));
  }
}

export function validateAwsIotDataPathEvidence(receipt) {
  const errors = [];
  if (!isRecord(receipt)) return ['回执根节点必须为对象'];
  if (receipt.schemaVersion !== '1.0') errors.push('schemaVersion 必须为 1.0');
  if (receipt.status !== 'PASS') errors.push('status 必须为 PASS');
  if (!COMMIT.test(receipt.sourceCommit ?? '')) errors.push('sourceCommit 必须为 40 位小写 Git SHA');
  if (!ISO_INSTANT.test(receipt.executedAt ?? '') || !Number.isFinite(Date.parse(receipt.executedAt))) {
    errors.push('executedAt 必须为 UTC ISO-8601 时刻');
  }

  const environment = receipt.environment;
  if (!isRecord(environment)) {
    errors.push('environment 必须为对象');
  } else {
    if (environment.isolated !== true) errors.push('environment.isolated 必须为 true');
    requireString(errors, environment.accountId, 'environment.accountId');
    requireString(errors, environment.region, 'environment.region');
    requireString(errors, environment.stackName, 'environment.stackName');
  }

  const routes = receipt.probes?.uplinkRoutes;
  if (!Array.isArray(routes) || routes.length !== UPLINK_TYPES.length) {
    errors.push(`probes.uplinkRoutes 必须恰好包含 ${UPLINK_TYPES.length} 个上行类型`);
  } else {
    const types = routes.map((route) => route?.type);
    if (new Set(types).size !== UPLINK_TYPES.length || UPLINK_TYPES.some((type) => !types.includes(type))) {
      errors.push(`probes.uplinkRoutes 必须无重复覆盖 ${UPLINK_TYPES.join(',')}`);
    }
    routes.forEach((route, index) => {
      const path = `probes.uplinkRoutes[${index}]`;
      validatePassedProbe(errors, route, path);
      if (isRecord(route)) {
        if (typeof route.deviceId !== 'string' || route.topic !== `bnx/device/${route.deviceId}/${route.type}`) {
          errors.push(`${path}.topic 必须与 deviceId/type 精确一致`);
        }
        if (!SHA256.test(route.publishedBodySha256 ?? '')) errors.push(`${path}.publishedBodySha256 非法`);
        if (route.publishedBodySha256 !== route.ingressBodySha256) {
          errors.push(`${path} Ingress 原文 SHA-256 与发布原文不一致`);
        }
      }
    });
  }

  const unknown = receipt.probes?.unknownTopic;
  validatePassedProbe(errors, unknown, 'probes.unknownTopic');
  if (isRecord(unknown)) {
    if (!Number.isInteger(unknown.observedSeconds) || unknown.observedSeconds < 60) {
      errors.push('probes.unknownTopic.observedSeconds 必须至少为 60');
    }
    if (unknown.ingressMessages !== 0) errors.push('probes.unknownTopic.ingressMessages 必须为 0');
  }

  const errorAction = receipt.probes?.errorAction;
  validatePassedProbe(errors, errorAction, 'probes.errorAction');
  if (isRecord(errorAction) && errorAction.restored !== true) {
    errors.push('probes.errorAction.restored 必须为 true');
  }

  for (const probeName of QA03_PROBES) {
    validatePassedProbe(errors, receipt.probes?.qa03?.[probeName], `probes.qa03.${probeName}`);
  }
  const archive = receipt.probes?.qa03?.s3RawArchive;
  if (isRecord(archive)) {
    if (!SHA256.test(archive.sourceRawBodySha256 ?? '')) {
      errors.push('probes.qa03.s3RawArchive.sourceRawBodySha256 非法');
    }
    if (archive.sourceRawBodySha256 !== archive.archivedRawBodySha256) {
      errors.push('probes.qa03.s3RawArchive 归档原文 SHA-256 不一致');
    }
  }

  validatePassedProbe(errors, receipt.cleanup, 'cleanup');
  if (isRecord(receipt.cleanup) && receipt.cleanup.completed !== true) {
    errors.push('cleanup.completed 必须为 true');
  }
  return errors;
}

export function checkAwsIotDataPathEvidence(root, relativeReceipt, expectedSourceCommit) {
  const path = resolve(root, relativeReceipt);
  if (!existsSync(path)) return [`缺少目标 AWS 数据链路回执: ${relativeReceipt}`];
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return [`目标 AWS 数据链路回执不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  const errors = validateAwsIotDataPathEvidence(receipt);
  if (expectedSourceCommit && receipt.sourceCommit !== expectedSourceCommit) {
    errors.push(`sourceCommit 与待发布提交不一致: expected ${expectedSourceCommit}, received ${receipt.sourceCommit}`);
  }
  return errors;
}

function main() {
  const root = process.cwd();
  const relativeReceipt = process.env.FDP_AWS_IOT_DATA_PATH_RECEIPT ?? 'docs/audit/evidence/be-iot-aws-data-path.json';
  const expectedSourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const errors = checkAwsIotDataPathEvidence(root, relativeReceipt, expectedSourceCommit);
  for (const error of errors) process.stderr.write(`${error}\n`);
  if (errors.length === 0) process.stdout.write('BE-IOT-01 / QA-03 目标 AWS 数据链路证据 PASS\n');
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
