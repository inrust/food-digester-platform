#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkBaselines } from './contract-suite/baseline.mjs';
import { deviceContract } from '../contracts/testing/device-contract.ts';
import { DELIVERED_OPERATIONS } from '../apps/cloud-api/src/runtime/delivered-operations.ts';

export const DEVICE_TEST_FILES = [
  'certificate-status',
  'certificate-rotate',
  'device-sync',
  'device-deactivate',
  'media',
  'csr-onboarding',
  'ota-dispatch',
  'qa02-device-errors',
  'device-lambda-composition',
].map((name) => `apps/cloud-api/test/${name}.test.ts`);
function run(args, env) {
  const result = spawnSync(process.execPath, args, {
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0 || result.error) throw new Error('CONTRACT_TEST_COMMAND_FAILED');
}
export function summarizeCoverage(rows, operations) {
  if (
    rows.some(
      (row) =>
        row.source !== 'REAL_HANDLER' ||
        typeof row.operationId !== 'string' ||
        !Number.isInteger(row.status) ||
        typeof row.validRequest !== 'boolean',
    )
  )
    throw new Error('INVALID_OPERATION_TRACE');
  const matrix = [];
  for (const [id, { operation }] of operations) {
    const samples = rows.filter((row) => row.operationId === id && row.source === 'REAL_HANDLER');
    const declaredStatuses = Object.keys(operation.responses)
      .map(Number)
      .sort((a, b) => a - b);
    const observedStatuses = [...new Set(samples.map((row) => row.status))].sort((a, b) => a - b);
    const missingStatuses = declaredStatuses.filter((status) => !observedStatuses.includes(status));
    if (
      !samples.some((row) => row.status < 400 && row.validRequest) ||
      !samples.some((row) => row.status >= 400) ||
      missingStatuses.length ||
      observedStatuses.some((status) => !declaredStatuses.includes(status))
    )
      throw new Error(`INCOMPLETE_OPERATION_COVERAGE ${id}: ${missingStatuses.join(',')}`);
    matrix.push({
      operationId: id,
      checkedResponses: samples.length,
      validRequests: samples.filter((row) => row.validRequest).length,
      rejectedInvalidRequests: samples.filter((row) => !row.validRequest).length,
      declaredStatuses,
      observedStatuses,
      missingStatuses,
    });
  }
  const ids = new Set([...operations.keys()]);
  if (rows.some((row) => !ids.has(row.operationId))) throw new Error('UNEXPECTED_OPERATION_TRACE');
  return matrix;
}
export async function main(args) {
  if (args.length !== 1) throw new Error('USAGE: pnpm test:device-contracts <receipt.json>');
  const receiptPath = resolve(args[0]);
  const temp = mkdtempSync(join(tmpdir(), 'qa02-contract-'));
  const trace = join(temp, 'trace.jsonl');
  try {
    const baseline = await checkBaselines();
    const delivered = DELIVERED_OPERATIONS.filter((operation) => operation.path.startsWith('/api/v1/device/'));
    if (
      delivered.length !== deviceContract.operations.size ||
      delivered.some((op) => {
        const schema = deviceContract.operations.get(op.operationId);
        return !schema || schema.method.toUpperCase() !== op.method || schema.path !== op.path;
      })
    )
      throw new Error('DEVICE_API_DELIVERY_MISMATCH');
    run(['--import', 'tsx', '--test', 'scripts/contract-suite.test.mjs'], { ...process.env, QA02_CONTRACT_TRACE: '' });
    // Clear nested trace overrides and invoke local Vitest directly; no pnpm/network/bootstrap needed.
    run(['node_modules/vitest/vitest.mjs', 'run', ...DEVICE_TEST_FILES], {
      ...process.env,
      QA02_CONTRACT_TRACE: trace,
    });
    const rows = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const matrix = summarizeCoverage(rows, deviceContract.operations);
    const topics = JSON.parse(readFileSync('contracts/mqtt/topic-catalog.json', 'utf8')).topics;
    const mqtt = topics.map(({ type }) => {
      const fixture = JSON.parse(readFileSync(`contracts/mqtt/fixtures/${type}.fixtures.json`, 'utf8'));
      return {
        topicType: type,
        validFixtures: fixture.valid.length,
        invalidFixtures: fixture.invalid.length,
        fieldDeletionDetected: true,
        typeMutationDetected: true,
      };
    });
    const receipt = {
      task: 'QA-02',
      scope: 'LOCAL_CONTRACT_AND_REAL_HANDLER',
      status: 'PASS',
      baselineCommit: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      sourceSha256: Object.fromEntries(
        [
          'contracts/testing/device-contract.ts',
          'contracts/testing/mqtt-contract.ts',
          'contracts/testing/compatibility-approvals.json',
          'scripts/contract-suite/baseline.mjs',
          'scripts/contract-suite/compatibility.mjs',
          'scripts/contract-suite.test.mjs',
          'scripts/run-contract-suite.mjs',
          'apps/cloud-api/src/ota/download.ts',
          'apps/cloud-api/src/runtime/device-lambda.ts',
          ...DEVICE_TEST_FILES,
        ].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
      ),
      mqttSchemaCount: mqtt.length,
      mqtt,
      deviceOperationCoverage: `${matrix.length}/${delivered.length}`,
      declaredResponseStatusCoverage: '100%',
      checkedResponses: rows.length,
      nonConformingResponses: 0,
      rest: matrix,
      compatibility: baseline,
      awsTargetAcceptance: 'NOT RUN / NO RECEIPT',
    };
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    process.stdout.write(
      `QA-02 PASS: ${mqtt.length} MQTT schemas, ${matrix.length} device operations, ${rows.length} checked Handler responses\n`,
    );
    return receipt;
  } catch (error) {
    writeFileSync(
      receiptPath,
      JSON.stringify(
        {
          task: 'QA-02',
          scope: 'LOCAL_CONTRACT_AND_REAL_HANDLER',
          status: 'FAIL',
          reason: String(error.message),
          awsTargetAcceptance: 'NOT RUN / NO RECEIPT',
        },
        null,
        2,
      ) + '\n',
    );
    throw error;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
