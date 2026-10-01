#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QA06_FILES, QA06_REQUIRED_CASES, QA06_PROOFS } from './qa06-manifest.mjs';
import { scanSecurityArtifact } from './security-leak-scan.mjs';
import { DELIVERED_OPERATIONS } from '../apps/cloud-api/src/runtime/delivered-operations.ts';
export const ADMIN_WRITES = DELIVERED_OPERATIONS.filter((o) => o.runtime === 'admin-api' && o.method !== 'GET').map(
  (o) => o.operationId,
);
export function summarizeExecution(report) {
  if (
    report.success !== true ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.testResults?.length !== QA06_FILES.length ||
    QA06_FILES.some((file) => !report.testResults.some((r) => resolve(r.name) === resolve(file))) ||
    report.testResults.some(
      (r) =>
        r.status !== 'passed' || !r.assertionResults?.length || r.assertionResults.some((a) => a.status !== 'passed'),
    )
  )
    throw new Error('INCOMPLETE_SECURITY_EXECUTION');
  const tests = report.testResults.flatMap((r) =>
    r.assertionResults.map((a) => ({
      file: r.name.slice(process.cwd().length + 1),
      name: a.fullName,
      status: a.status,
    })),
  );
  if (
    report.numPassedTests !== tests.length ||
    QA06_REQUIRED_CASES.some((c) => !tests.some((t) => t.file === c.file && t.name.includes(c.name)))
  )
    throw new Error('MISSING_REQUIRED_SECURITY_CASE');
  return {
    testCount: tests.length,
    testFiles: QA06_FILES,
    testCases: tests,
    coverage: [...new Set(QA06_REQUIRED_CASES.map((c) => c.area))].map((area) => ({
      area,
      requiredCases: QA06_REQUIRED_CASES.filter((c) => c.area === area),
    })),
  };
}
export function summarizeEvidence(rows) {
  if (rows.some((r) => !['proof', 'artifact'].includes(r.kind))) throw new Error('INVALID_SECURITY_TRACE');
  const proofs = rows.filter((r) => r.kind === 'proof'),
    artifacts = rows.filter((r) => r.kind === 'artifact');
  if (
    proofs.length !== QA06_PROOFS.length ||
    new Set(proofs.map((r) => r.name)).size !== QA06_PROOFS.length ||
    new Set(proofs.map((r) => r.prefix)).size !== QA06_PROOFS.length ||
    QA06_PROOFS.some((name) => !proofs.some((r) => r.name === name)) ||
    proofs.some((r) => r.status !== 'PASS' || r.cleanup !== 'PASS' || !/^QA06-[A-F0-9]{12}$/.test(r.prefix))
  )
    throw new Error('MISSING_ISOLATED_SECURITY_PROOF');
  const byName = Object.fromEntries(proofs.map((r) => [r.name, r]));
  const jwt = byName['jwt-integrity-time-replay'];
  if (
    jwt.invalidClaimsRejected !== 6 ||
    jwt.tamperedRejected !== true ||
    jwt.validReuse !== true ||
    JSON.stringify(jwt.unauthorizedStatuses) !== '[401]'
  )
    throw new Error('INCORRECT_JWT_OR_REPLAY_PROOF');
  const auth = byName['all-admin-write-auth'];
  if (
    auth.resolverCalls !== 0 ||
    auth.matrix?.length !== ADMIN_WRITES.length ||
    new Set(auth.matrix.map((c) => c.operationId)).size !== ADMIN_WRITES.length ||
    ADMIN_WRITES.some(
      (id) => !auth.matrix.some((c) => c.operationId === id && JSON.stringify(c.statuses) === '[401,401,401]'),
    )
  )
    throw new Error('INCOMPLETE_ADMIN_WRITE_AUTH_MATRIX');
  const tenant = byName['tenant-sql-json'],
    media = byName['malicious-media'],
    sensitive = byName['sensitive-artifacts'];
  if (
    tenant.crossTenantStatus !== 403 ||
    tenant.writeDenied !== 403 ||
    tenant.noUnauthorizedWrites !== true ||
    tenant.jsonRejected !== 7 ||
    tenant.sqlLiteralStored !== true ||
    tenant.sqlNoCrossScope !== true ||
    tenant.prototypeUnchanged !== true
  )
    throw new Error('MISSING_TENANT_OR_INJECTION_BOUNDARY');
  if (
    media.attacksRejected !== 12 ||
    JSON.stringify(media.statuses) !== '[400]' ||
    media.signedUrls !== 0 ||
    media.businessWrites !== 0
  )
    throw new Error('MISSING_MALICIOUS_MEDIA_BOUNDARY');
  if (
    sensitive.logLevels !== 4 ||
    sensitive.traceScanned !== true ||
    sensitive.auditScanned !== true ||
    sensitive.snapshotScanned !== true ||
    sensitive.sensitiveFindings !== 0
  )
    throw new Error('MISSING_SENSITIVE_ARTIFACT_PROOF');
  const channels = ['response', 'log', 'audit', 'snapshot'];
  if (
    artifacts.some(
      (r) =>
        !channels.includes(r.channel) ||
        !Number.isInteger(r.inspectedNodes) ||
        r.inspectedNodes < 1 ||
        !Array.isArray(r.findings) ||
        r.findings.length,
    )
  )
    throw new Error('SENSITIVE_LEAK_OR_INVALID_SCAN');
  const coverage = channels.map((channel) => ({
    channel,
    samples: artifacts.filter((r) => r.channel === channel).length,
    inspectedNodes: artifacts.filter((r) => r.channel === channel).reduce((n, r) => n + r.inspectedNodes, 0),
    findings: 0,
  }));
  if (
    coverage.some((r) => r.samples === 0) ||
    coverage[0].samples < ADMIN_WRITES.length * 3 ||
    coverage[1].samples !== 4
  )
    throw new Error('MISSING_ARTIFACT_CHANNEL');
  return {
    adminWriteOperations: ADMIN_WRITES.length,
    authenticationRejections: ADMIN_WRITES.length * 3,
    acceptanceProofs: proofs,
    artifactScans: coverage,
    sensitiveFindings: 0,
  };
}
export function assertSafeArtifact(value) {
  const scan = scanSecurityArtifact(value);
  if (scan.findings.length) throw new Error('UNREDACTED_SECURITY_RUN_ARTIFACT');
  return { inspectedNodes: scan.inspectedNodes, findings: 0 };
}
export function sourceHashes() {
  const files = execFileSync(
    'git',
    [
      'ls-files',
      'apps/cloud-api/src',
      'packages/auth/src',
      'packages/aws-clients/src',
      'packages/observability/src',
      'packages/database',
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
    ...QA06_FILES,
    'apps/admin-web/src/pages/audit/audit-state.ts',
    'apps/admin-web/test/contract-parity.test.ts',
    'apps/cloud-api/test/helpers.ts',
    'apps/cloud-api/test/qa06-evidence.ts',
    'packages/auth/test/helpers.ts',
    'qa06-vitest.config.mjs',
    'scripts/qa06-manifest.mjs',
    'scripts/run-security-suite.mjs',
    'scripts/security-leak-scan.mjs',
    'scripts/security-leak-scan.d.mts',
    'scripts/security-suite.test.mjs',
  );
  return Object.fromEntries(
    [...new Set(files)].sort().map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
  );
}
function snapshotFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'cdk.out'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...snapshotFiles(path));
    else if (entry.name.endsWith('.snap')) files.push(path);
  }
  return files;
}
export function main(args) {
  if (args.length !== 1) throw new Error('USAGE: pnpm test:security-suite <local-receipt.json>');
  const output = resolve(args[0]),
    temp = mkdtempSync(join(tmpdir(), 'qa06-security-')),
    reportPath = join(temp, 'vitest.json'),
    trace = join(temp, 'trace.jsonl');
  try {
    const sources = sourceHashes();
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'qa06-vitest.config.mjs',
        '--reporter=default',
        '--reporter=json',
        '--outputFile',
        reportPath,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, QA06_TRACE: trace, QA04_TRACE: '', QA02_CONTRACT_TRACE: '' },
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    // Inspect raw output before printing; never repair a leak with redaction to claim zero findings.
    const outputScan = assertSafeArtifact((result.stdout ?? '') + (result.stderr ?? ''));
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.status !== 0 || result.error) throw new Error('SECURITY_SUITE_FAILED');
    const tests = JSON.parse(readFileSync(reportPath, 'utf8'));
    const reportScan = assertSafeArtifact(tests);
    const execution = summarizeExecution(tests);
    const rows = readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const traceScan = assertSafeArtifact(rows);
    const evidence = summarizeEvidence(rows);
    const snapshots = ['apps', 'packages']
      .flatMap(snapshotFiles)
      .map((file) => ({ file, ...assertSafeArtifact(readFileSync(file, 'utf8')) }));
    if (JSON.stringify(sources) !== JSON.stringify(sourceHashes())) throw new Error('SOURCE_CHANGED_DURING_RUN');
    writeFileSync(
      output,
      JSON.stringify(
        {
          schemaVersion: '1.0',
          task: 'QA-06',
          status: 'PASS',
          scope: 'LOCAL_APPLICATION_SECURITY',
          baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          executedAt: new Date().toISOString(),
          environment: {
            database: 'isolated PGlite with all migrations',
            identity: 'local RS256/JWKS; no real Cognito or TLS handshake',
            topic: 'literal IoT Policy evaluation; no AWS broker',
            externalPorts: 'injected local ports',
            productionCredentialsUsed: false,
          },
          sourceHashes: sources,
          ...execution,
          ...evidence,
          runArtifactScans: { outputScan, reportScan, traceScan, snapshots },
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
          task: 'QA-06',
          status: 'FAIL',
          scope: 'LOCAL_APPLICATION_SECURITY',
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
