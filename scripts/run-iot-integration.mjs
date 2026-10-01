#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function summarizeIntegration(rows) {
  const names = ['eight-routes', 'ingestion-faults', 'archive-faults', 'transaction-rollback', 'cleanup-failure'];
  if (
    rows.length !== names.length ||
    new Set(rows.map((r) => r.name)).size !== names.length ||
    rows.some(
      (r) =>
        !names.includes(r.name) || r.status !== 'PASS' || r.cleanup !== 'PASS' || !/^QA03-[A-F0-9]{12}$/.test(r.prefix),
    ) ||
    new Set(rows.map((r) => r.prefix)).size !== rows.length
  )
    throw new Error('INCOMPLETE_INTEGRATION_TRACE');
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  const routes = byName['eight-routes'];
  const expectedTypes = ['heartbeat', 'telemetry', 'report', 'alarm', 'event', 'ack', 'tamper', 'media'];
  if (
    JSON.stringify(routes.routes) !== JSON.stringify(expectedTypes) ||
    routes.legalMessages !== 80 ||
    routes.receipts !== 80 ||
    routes.businessRows !== 80 ||
    routes.duplicateDeliveries !== 80 ||
    routes.archiveRecords !== 60 ||
    routes.rawHashChecks?.length !== 60 ||
    new Set(routes.rawHashChecks.map((r) => r.messageId)).size !== 60 ||
    routes.rawHashChecks.some((r) => !/^[a-f0-9]{64}$/.test(r.rawSha256) || !/^[a-f0-9]{64}$/.test(r.objectSha256))
  )
    throw new Error('INCOMPLETE_ROUTE_OR_ARCHIVE_COVERAGE');
  for (const row of rows.filter((r) => r.name !== 'cleanup-failure'))
    if (row.legalMessages !== row.receipts || row.duplicateBusinessRows !== 0)
      throw new Error('LOSS_OR_DUPLICATE_BUSINESS_RECORD');
  const ingest = byName['ingestion-faults'];
  const archive = byName['archive-faults'];
  const rollback = byName['transaction-rollback'];
  const cleanup = byName['cleanup-failure'];
  if (
    ingest.partialFailures !== 2 ||
    ingest.quarantined !== 4 ||
    ingest.traceablePending !== 3 ||
    !ingest.gapDetected ||
    !ingest.gapResolved ||
    !archive.queueRetry ||
    !archive.manifestRetry ||
    !archive.archivePartialFailure ||
    archive.archiveRecords !== 2 ||
    !rollback.rollback ||
    rollback.traceablePending !== 1 ||
    !cleanup.failureCleanup ||
    !cleanup.isolatedPrefixes
  )
    throw new Error('INCOMPLETE_FAULT_COVERAGE');
  return {
    legalMessages: 86,
    receipts: 86,
    duplicateBusinessRows: 0,
    rawArchiveRecords: 62,
    traceablePending: 4,
    scenarios: rows,
  };
}
export function sourceHashes() {
  const files = execFileSync(
    'git',
    [
      'ls-files',
      'apps/ingestion-worker/src',
      'packages/database',
      'packages/domain/src',
      'packages/auth/src',
      'packages/aws-clients/src',
      'packages/media/src',
      'contracts/mqtt',
      'vitest.config.mjs',
      'infra/src',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  files.push(
    'package.json',
    'pnpm-lock.yaml',
    'scripts/iot-integration.test.mjs',
    'apps/cloud-api/test/helpers.ts',
    'apps/ingestion-worker/test/qa03-fixture.ts',
    'apps/ingestion-worker/test/qa03-data-path.test.ts',
    'scripts/device-simulator/core.mjs',
    'scripts/run-iot-integration.mjs',
  );
  return Object.fromEntries(
    [...new Set(files)].sort().map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
  );
}
export function main(args) {
  if (args.length !== 1) throw new Error('USAGE: pnpm test:iot-integration <local-receipt.json>');
  const output = resolve(args[0]);
  const temp = mkdtempSync(join(tmpdir(), 'qa03-integration-'));
  const trace = join(temp, 'trace.jsonl');
  try {
    const sources = sourceHashes();
    const result = spawnSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', 'apps/ingestion-worker/test/qa03-data-path.test.ts'],
      { encoding: 'utf8', env: { ...process.env, QA03_TRACE: trace }, timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
    );
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.status !== 0 || result.error) throw new Error('IOT_INTEGRATION_TEST_FAILED');
    const summary = summarizeIntegration(
      readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
    if (JSON.stringify(sources) !== JSON.stringify(sourceHashes())) throw new Error('SOURCE_CHANGED_DURING_RUN');
    writeFileSync(
      output,
      JSON.stringify(
        {
          schemaVersion: '1.0',
          task: 'QA-03',
          status: 'PASS',
          scope: 'LOCAL_INTEGRATION',
          baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          sourceHashes: sources,
          executedAt: new Date().toISOString(),
          environment: {
            database: 'isolated in-memory PGlite, all migrations',
            awsPorts: 'in-memory IoT envelope / queues / S3',
            productionCredentialsUsed: false,
          },
          ...summary,
          cleanup: 'PASS',
          awsTargetGate: 'NOT RUN / NO RECEIPT',
        },
        null,
        2,
      ) + '\n',
    );
  } catch (error) {
    writeFileSync(
      output,
      JSON.stringify(
        {
          task: 'QA-03',
          status: 'FAIL',
          scope: 'LOCAL_INTEGRATION',
          error: String(error),
          awsTargetGate: 'NOT RUN / NO RECEIPT',
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
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
