#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLoadPlan, latencySummary } from './reliability-plan.mjs';
export function validateReliability(rows, profile = 'quick') {
  const plan = buildLoadPlan(profile);
  if (rows.length !== 1) throw new Error('INCOMPLETE_RELIABILITY_TRACE');
  const r = rows[0];
  if (
    r.task !== 'QA-07' ||
    r.status !== 'PASS' ||
    r.cleanup !== 'PASS' ||
    !/^QA07-[A-F0-9]{12}$/.test(r.prefix) ||
    r.profile !== profile ||
    JSON.stringify(r.config) !== JSON.stringify(plan.config)
  )
    throw new Error('INVALID_RELIABILITY_EXECUTION');
  const required = {
    deviceCount: 10,
    telemetrySeconds: 10,
    heartbeatSeconds: 60,
    historyHours: 24,
    historyExecutedSeconds: plan.historyExecutedSeconds,
    uniqueTelemetry: plan.uniqueTelemetry,
    uniqueHeartbeat: plan.uniqueHeartbeat,
    duplicatesInjected: plan.duplicates,
    reorderedInjected: plan.reordered,
    burstMultiplier: 30,
    receipts: plan.uniqueTelemetry + plan.uniqueHeartbeat,
    archived: plan.uniqueTelemetry,
    archiveHashesVerified: plan.uniqueTelemetry,
    quarantined: 0,
    partialRetries: 1,
    sendRetries: 1,
    unresolvedGaps: 0,
    untrackedMissing: 0,
    pendingAfterRecovery: 0,
    replaySent: plan.config.historyWindowSeconds / 10,
    replayFailed: 0,
    commandPublished: 10,
    duplicateCommandPublishes: 0,
    timeoutAudit: 1,
  };
  if (
    Object.entries(required).some(([k, v]) => r[k] !== v) ||
    r.consistency?.samples !== plan.uniqueTelemetry ||
    r.consistency?.duplicateBusinessRows !== 0 ||
    !Number.isInteger(r.consistency?.buckets) ||
    r.consistency.buckets < 240
  )
    throw new Error('LOAD_LOSS_DUPLICATE_OR_MISSING_COVERAGE');
  if (
    ['pauseVerified', 'manifestRetry', 'gapObserved', 'replayIdempotent', 'lateAckPreserved'].some(
      (k) => r[k] !== true,
    ) ||
    !Number.isInteger(r.gapRows) ||
    r.gapRows < 1 ||
    !Number.isInteger(r.backlogAtResume) ||
    r.backlogAtResume < 1 ||
    !Number.isInteger(r.maxBacklog) ||
    r.maxBacklog < r.backlogAtResume ||
    !Number.isInteger(r.replaySkipped) ||
    r.replaySkipped < 1 ||
    !Number.isFinite(r.schedulerElapsedMs) ||
    r.schedulerElapsedMs < 0
  )
    throw new Error('MISSING_FAILURE_OR_RECOVERY_PROOF');
  for (const [key, samples, limit] of [
    ['telemetryLatency', plan.config.normalSeconds, 5000],
    ['commandLatency', 10, 3000],
  ]) {
    const metric = r[key];
    if (!Array.isArray(metric?.valuesMs) || metric.valuesMs.length !== samples)
      throw new Error('LATENCY_RAW_SAMPLES_MISSING');
    const recomputed = latencySummary(metric.valuesMs);
    if (metric.p95Ms !== recomputed.p95Ms || metric.maxMs !== recomputed.maxMs)
      throw new Error('LATENCY_SUMMARY_MISMATCH');
    if (
      metric?.samples !== samples ||
      !Number.isFinite(metric.p95Ms) ||
      metric.p95Ms < 0 ||
      metric.p95Ms > limit ||
      !Number.isFinite(metric.maxMs) ||
      metric.maxMs < metric.p95Ms
    )
      throw new Error('LATENCY_SLO_OR_SAMPLE_FAILURE');
  }
  return r;
}
export function sourceHashes() {
  const files = execFileSync(
    'git',
    [
      'ls-files',
      'apps/ingestion-worker/src',
      'apps/cloud-api/src',
      'packages/database',
      'packages/domain/src',
      'packages/auth/src',
      'packages/aws-clients/src',
      'packages/observability/src',
      'contracts',
      'package.json',
      'pnpm-lock.yaml',
      'vitest.config.mjs',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  files.push(
    'contracts/mqtt/telemetry-backfill-policy.ts',
    'contracts/mqtt/telemetry-backfill-policy.test.ts',
    'apps/cloud-api/test/helpers.ts',
    'apps/ingestion-worker/test/qa03-fixture.ts',
    'apps/ingestion-worker/test/qa07-reliability.test.ts',
    'scripts/device-simulator/core.mjs',
    'scripts/reliability-plan.mjs',
    'scripts/reliability-plan.d.mts',
    'scripts/reliability-suite.test.mjs',
    'scripts/run-reliability-suite.mjs',
  );
  return Object.fromEntries(
    [...new Set(files)].sort().map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
  );
}
export function main(args) {
  if (args.length < 1 || args.length > 2)
    throw new Error('USAGE: pnpm test:reliability-suite <receipt.json> [quick|full]');
  const [destination, profile = 'quick'] = args;
  buildLoadPlan(profile);
  const output = resolve(destination),
    temp = mkdtempSync(join(tmpdir(), 'qa07-reliability-')),
    trace = join(temp, 'trace.jsonl'),
    report = join(temp, 'vitest.json');
  try {
    const sources = sourceHashes();
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        'apps/ingestion-worker/test/qa07-reliability.test.ts',
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, QA07_PROFILE: profile, QA07_TRACE: trace, QA03_TRACE: '' },
        timeout: profile === 'full' ? 1860000 : 240000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.status !== 0 || result.error) throw new Error('RELIABILITY_TEST_FAILED');
    const execution = JSON.parse(readFileSync(report, 'utf8'));
    if (
      execution.success !== true ||
      execution.numFailedTests !== 0 ||
      execution.numPendingTests !== 0 ||
      execution.numPassedTests !== 2 ||
      execution.testResults?.length !== 1 ||
      execution.testResults[0].assertionResults?.length !== 2 ||
      execution.testResults[0].assertionResults.some((a) => a.status !== 'passed')
    )
      throw new Error('INCOMPLETE_RELIABILITY_TEST');
    const summary = validateReliability(
      readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      profile,
    );
    if (JSON.stringify(sources) !== JSON.stringify(sourceHashes())) throw new Error('SOURCE_CHANGED_DURING_RUN');
    writeFileSync(
      output,
      JSON.stringify(
        {
          schemaVersion: '1.0',
          task: 'QA-07',
          status: 'PASS',
          scope: 'LOCAL_LOAD_RELIABILITY',
          baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          executedAt: new Date().toISOString(),
          sourceHashes: sources,
          environment: {
            database: 'isolated PGlite with all migrations',
            transport: 'in-memory queue, archive store and MQTT publish port',
            clock: 'scaled producer schedule; monotonic wall-clock latency including queue wait',
            productionCredentialsUsed: false,
          },
          historyCoverage: {
            requestedHours: 24,
            executedSeconds: summary.historyExecutedSeconds,
            continuousFullDay: profile === 'full',
            sampling:
              profile === 'quick' ? 'first 20 seconds of each historical hour' : 'all 10-second samples in 24 hours',
          },
          result: summary,
          testCount: 2,
          cleanup: 'PASS',
          awsTargetGate: 'DEFERRED TO QA-09 / NOT RUN / NO RECEIPT',
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
          task: 'QA-07',
          status: 'FAIL',
          scope: 'LOCAL_LOAD_RELIABILITY',
          error: String(error),
          awsTargetGate: 'DEFERRED TO QA-09 / NOT RUN / NO RECEIPT',
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
