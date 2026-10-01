#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QA04_FACTORIES, QA04_FILES, QA04_ROLES, QA04_REQUIRED_CASES } from './qa04-manifest.mjs';

export function summarizeCoreApi(rows) {
  const handlers = rows.filter((r) => r.kind === 'handler');
  const proofs = rows.filter((r) => r.kind === 'proof');
  const areas = [...new Set(Object.values(QA04_FACTORIES))];
  if (
    rows.some((r) => !['handler', 'proof'].includes(r.kind)) ||
    !handlers.length ||
    handlers.some(
      (r) =>
        r.source !== 'REAL_HANDLER' ||
        !areas.includes(r.area) ||
        !Number.isInteger(r.status) ||
        r.status < 200 ||
        r.status > 599 ||
        !Array.isArray(r.roles),
    )
  )
    throw new Error('INVALID_API_TRACE');
  const coverage = areas.map((area) => {
    const samples = handlers.filter((r) => r.area === area);
    const success = samples.filter((r) => r.status < 400).length;
    const negative = samples.filter((r) => r.status >= 400).length;
    if (!success || !negative) throw new Error(`MISSING_POSITIVE_OR_NEGATIVE ${area}`);
    return {
      area,
      responses: samples.length,
      success,
      negative,
      statuses: [...new Set(samples.map((r) => r.status))].sort((a, b) => a - b),
      methods: [...new Set(samples.map((r) => r.method))].sort(),
    };
  });
  const names = ['five-roles-two-tenants', 'if-match-race', 'atomic-audit-replay'];
  if (
    proofs.length !== 3 ||
    new Set(proofs.map((r) => r.name)).size !== 3 ||
    new Set(proofs.map((r) => r.prefix)).size !== 3 ||
    proofs.some(
      (r) =>
        !names.includes(r.name) ||
        r.status !== 'PASS' ||
        r.cleanup !== 'PASS' ||
        !/^QA04-[A-F0-9]{12}$/.test(r.prefix) ||
        JSON.stringify(r.customers) !== JSON.stringify([`${r.prefix}-A`, `${r.prefix}-B`]),
    )
  )
    throw new Error('MISSING_ISOLATED_ACCEPTANCE_PROOF');
  const byName = Object.fromEntries(proofs.map((r) => [r.name, r]));
  const rbac = byName['five-roles-two-tenants'];
  if (
    JSON.stringify(rbac.roles) !== JSON.stringify(QA04_ROLES) ||
    rbac.matrix?.length !== 5 ||
    rbac.unauthorizedNoBusinessWrites !== true
  )
    throw new Error('INCOMPLETE_ROLE_MATRIX');
  for (const [index, role] of QA04_ROLES.entries()) {
    const cell = rbac.matrix[index];
    if (
      cell.role !== role ||
      cell.own !== 200 ||
      cell.cross !== (role.startsWith('Customer') ? 403 : 200) ||
      cell.suspend !== (['PlatformSuperAdmin', 'PlatformOperator'].includes(role) ? 200 : 403) ||
      cell.audit !== (['PlatformSuperAdmin', 'Auditor'].includes(role) ? 200 : 403)
    )
      throw new Error('INCORRECT_ROLE_OR_TENANT_BOUNDARY');
    if (!handlers.some((r) => r.roles.includes(role) && r.status === 200)) throw new Error('MISSING_OBSERVED_ROLE');
  }
  const race = byName['if-match-race'];
  const atomic = byName['atomic-audit-replay'];
  if (
    JSON.stringify(race.statuses) !== '[200,409]' ||
    race.version !== 2 ||
    race.successAudits !== 1 ||
    race.staleRetryNoWrites !== true ||
    atomic.rollback !== true ||
    atomic.replayNoWrites !== true ||
    atomic.successAudits !== 1 ||
    atomic.reactivated !== true
  )
    throw new Error('MISSING_TRANSACTION_CONCURRENCY_OR_AUDIT_ASSERTION');
  if (
    !handlers.some((r) => r.status === 401) ||
    !handlers.some((r) => r.errorCode === 'VERSION_CONFLICT' && r.ifMatch !== null) ||
    !handlers.some((r) => r.replayed === true)
  )
    throw new Error('MISSING_AUTH_CONFLICT_OR_REPLAY_RESPONSE');
  return { observedResponses: handlers.length, domainCoverage: coverage, acceptanceProofs: proofs };
}
export function summarizeTestExecution(tests) {
  if (
    !tests.success ||
    tests.numFailedTests !== 0 ||
    tests.numPendingTests !== 0 ||
    !Array.isArray(tests.testResults) ||
    tests.testResults.length !== QA04_FILES.length ||
    tests.testResults.some(
      (r) =>
        r.status !== 'passed' ||
        !Array.isArray(r.assertionResults) ||
        !r.assertionResults.length ||
        r.assertionResults.some((a) => a.status !== 'passed'),
    ) ||
    QA04_FILES.some((file) => !tests.testResults.some((r) => resolve(r.name) === resolve(file)))
  )
    throw new Error('INCOMPLETE_TEST_EXECUTION');
  const cases = tests.testResults.flatMap((r) =>
    r.assertionResults.map((a) => ({
      file: r.name.slice(process.cwd().length + 1),
      name: a.fullName,
      status: a.status,
    })),
  );
  if (
    tests.numPassedTests !== cases.length ||
    QA04_REQUIRED_CASES.some(
      (required) => !cases.some((test) => test.file === required.file && test.name.includes(required.name)),
    )
  )
    throw new Error('MISSING_REQUIRED_ACCEPTANCE_CASE');
  return { testCount: cases.length, requiredAcceptanceCases: QA04_REQUIRED_CASES.length, testCases: cases };
}
export function sourceHashes() {
  const files = execFileSync(
    'git',
    [
      'ls-files',
      'apps/cloud-api/src',
      'packages/database',
      'packages/auth/src',
      'packages/domain/src',
      'packages/aws-clients/src',
      'contracts',
      'vitest.config.mjs',
      'package.json',
      'pnpm-lock.yaml',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  files.push(
    ...QA04_FILES,
    'apps/cloud-api/test/helpers.ts',
    'apps/cloud-api/test/openapi-response.ts',
    'apps/cloud-api/test/qa04-observe.ts',
    'qa04-vitest.config.mjs',
    'scripts/qa04-manifest.mjs',
    'scripts/run-core-api-integration.mjs',
    'scripts/core-api-integration.test.mjs',
  );
  return Object.fromEntries(
    [...new Set(files)].sort().map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
  );
}
export function main(args) {
  if (args.length !== 1) throw new Error('USAGE: pnpm test:core-api-integration <local-receipt.json>');
  const output = resolve(args[0]);
  const temp = mkdtempSync(join(tmpdir(), 'qa04-core-api-'));
  const trace = join(temp, 'trace.jsonl');
  const report = join(temp, 'vitest.json');
  try {
    const sources = sourceHashes();
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'qa04-vitest.config.mjs',
        '--reporter=default',
        '--reporter=json',
        '--outputFile',
        report,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, QA04_TRACE: trace, QA02_CONTRACT_TRACE: '' },
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.status !== 0 || result.error) throw new Error('CORE_API_INTEGRATION_FAILED');
    const tests = JSON.parse(readFileSync(report, 'utf8'));
    const testExecution = summarizeTestExecution(tests);
    const summary = summarizeCoreApi(
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
          task: 'QA-04',
          status: 'PASS',
          scope: 'LOCAL_API_INTEGRATION',
          baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          executedAt: new Date().toISOString(),
          environment: {
            database: 'isolated PGlite with all migrations',
            identity: 'ActorContext fixtures; no real Cognito login',
            externalPorts: 'injected local ports',
            productionCredentialsUsed: false,
          },
          sourceHashes: sources,
          testFiles: QA04_FILES,
          ...testExecution,
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
          task: 'QA-04',
          status: 'FAIL',
          scope: 'LOCAL_API_INTEGRATION',
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
