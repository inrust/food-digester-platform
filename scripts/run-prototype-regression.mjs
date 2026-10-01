#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run as checkTraceability } from './check-prototype-traceability.mjs';
import { GROUPS, ABSENCE, VIEWPORTS, validateBindings } from './qa08-bindings.mjs';
export const matrix = JSON.parse(readFileSync('contracts/prototype-traceability.yaml', 'utf8'));
export const CASES = VIEWPORTS.flatMap((width) =>
  matrix.pages.map((p) => ({ title: `QA08 ${p.pageState} ${width}`, pageState: p.pageState, width })),
);
export function summarize(
  report,
  rows,
  snapshotHash = (p, w) =>
    createHash('sha256')
      .update(JSON.stringify(JSON.parse(readFileSync(`apps/admin-web/e2e/qa08-snapshots/${p}-${w}.json`, 'utf8'))))
      .digest('hex'),
) {
  validateBindings(matrix);
  const specs = [];
  function walk(s) {
    specs.push(...(s.specs ?? []));
    for (const child of s.suites ?? []) walk(child);
  }
  for (const s of report.suites ?? []) walk(s);
  const tests = specs.flatMap((s) => (s.tests ?? []).map((t) => ({ title: s.title, ...t })));
  if (
    report.errors?.length ||
    report.stats?.expected !== CASES.length ||
    report.stats?.unexpected !== 0 ||
    report.stats?.flaky !== 0 ||
    report.stats?.skipped !== 0 ||
    tests.length !== CASES.length ||
    tests.some(
      (t) =>
        t.expectedStatus !== 'passed' ||
        t.status !== 'expected' ||
        t.results?.length !== 1 ||
        t.results[0].status !== 'passed' ||
        t.results[0].retry !== 0 ||
        t.results[0].errors?.length,
    )
  )
    throw Error('INCOMPLETE_BROWSER_EXECUTION');
  if (
    report.config?.projects?.length !== 1 ||
    report.config.projects[0].repeatEach !== 1 ||
    report.config.projects[0].retries !== 0
  )
    throw Error('INVALID_PROJECT_CONFIGURATION');
  if (
    rows.length !== CASES.length ||
    new Set(rows.map((r) => r.prefix)).size !== CASES.length ||
    rows.some(
      (r) =>
        r.status !== 'passed' ||
        r.cleanup !== 'PASS' ||
        !/^QA08-[A-F0-9]{12}$/.test(r.prefix) ||
        r.unhandled?.length !== 0 ||
        r.updatedSnapshots !== false ||
        !Array.isArray(r.calls) ||
        !r.calls.length,
    )
  )
    throw Error('INVALID_ISOLATION_OR_NETWORK_PROOF');
  const equalSet = (a, b) =>
    Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));
  for (const c of CASES) {
    const matching = rows.filter((r) => r.title === c.title);
    if (tests.filter((t) => t.title === c.title).length !== 1 || matching.length !== 1)
      throw Error('MISSING_REQUIRED_CASE');
    const r = matching[0],
      groups = Object.keys(GROUPS).filter((k) => k.startsWith(c.pageState + '.'));
    const absence = Object.keys(ABSENCE).filter((k) => k.startsWith(c.pageState + '.'));
    const menus = matrix.menus.filter((m) => m.pageState === c.pageState).map((m) => m.menuId);
    if (
      r.viewport !== c.width ||
      !equalSet(r.groups, groups) ||
      !equalSet(r.absence, absence) ||
      !equalSet(r.menus, menus)
    )
      throw Error('INCOMPLETE_ELEMENT_COVERAGE');
    const flags = ['responsiveSidebar', 'noClipping', 'unmappedFieldIgnored'];
    if (['dashboard', 'device-operate'].includes(c.pageState)) flags.push('dangerousConfirmation');
    if (['device-view', 'esg-device'].includes(c.pageState)) flags.push('cascadingReset');
    if (['device-group', 'contract-detail'].includes(c.pageState)) flags.push('fourAxes');
    if (c.pageState === 'device-view') flags.push('staticMedia');
    if (c.pageState === 'device-consumable') flags.push('unknownNotInvented');
    if (c.pageState === 'settings') flags.push('noPlatformPassword');
    if (['device-operate', 'device-manage'].includes(c.pageState)) flags.push('entryPermissions');
    if (flags.some((f) => r.guards?.[f] !== true)) throw Error('MISSING_BEHAVIOR_GUARD');
    if (r.snapshotHash !== snapshotHash(c.pageState, c.width)) throw Error('SNAPSHOT_RECEIPT_MISMATCH');
  }
  return {
    ...validateBindings(matrix),
    executions: CASES.length,
    viewports: VIEWPORTS,
    positiveAssertions: Object.values(GROUPS).flat().length * VIEWPORTS.length,
    absenceAssertions: Object.keys(ABSENCE).length * VIEWPORTS.length,
    snapshots: CASES.length,
    menuExecutions: matrix.menus.length * VIEWPORTS.length,
    elements: matrix.pages.flatMap((p) =>
      p.elements.map((e) => ({
        id: e.id,
        pageState: p.pageState,
        disposition: e.disposition,
        assertion: Object.entries(GROUPS).find(([, ids]) => ids.includes(e.id))?.[0] ?? `absence:${e.id}`,
        executions: VIEWPORTS.map((w) => `QA08 ${p.pageState} ${w}`),
      })),
    ),
    tests: rows,
  };
}
export function sourceHashes() {
  const files = execFileSync(
    'git',
    [
      'ls-files',
      'apps/admin-web/src',
      'apps/admin-web/e2e',
      'apps/admin-web/playwright.config.ts',
      'apps/admin-web/tsconfig.e2e.json',
      'apps/admin-web/package.json',
      'packages/auth/src',
      'contracts/rest',
      'contracts/prototype-traceability.yaml',
      'contracts/prototype-source-elements.json',
      'contracts/prototype-route-registry.json',
      'docs/index19.html',
      'package.json',
      'pnpm-lock.yaml',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  files.push(
    'scripts/run-prototype-regression.mjs',
    'scripts/prototype-regression.test.mjs',
    'scripts/qa08-bindings.mjs',
    'scripts/qa08-bindings.d.mts',
    'scripts/check-prototype-traceability.mjs',
    'apps/admin-web/e2e/qa08-fixture.ts',
    'apps/admin-web/e2e/qa08-prototype.spec.ts',
    ...readdirSync('apps/admin-web/e2e/qa08-snapshots').map((f) => `apps/admin-web/e2e/qa08-snapshots/${f}`),
  );
  return Object.fromEntries(
    [...new Set(files)].sort().map((f) => [f, createHash('sha256').update(readFileSync(f)).digest('hex')]),
  );
}
export function main(args) {
  if (args.length !== 1) throw Error('USAGE: pnpm test:prototype-regression <local-receipt.json>');
  const output = resolve(args[0]),
    temp = mkdtempSync(join(tmpdir(), 'qa08-browser-'));
  try {
    if (checkTraceability(['--json'], () => {}) !== 0) throw Error('INVALID_UPSTREAM_TRACEABILITY');
    const sources = sourceHashes(),
      report = join(temp, 'report.json'),
      trace = join(temp, 'trace.jsonl');
    const result = spawnSync(
      process.execPath,
      [createRequire(resolve('apps/admin-web/package.json')).resolve('@playwright/test/cli'), 'test'],
      {
        cwd: resolve('apps/admin-web'),
        encoding: 'utf8',
        env: {
          ...process.env,
          QA05_PHASE: '',
          QA05_REPORT: '',
          QA05_TRACE: '',
          QA05_OUTPUT_DIR: '',
          QA08_RUN: '1',
          QA08_UPDATE: '',
          QA08_REPORT: report,
          QA08_TRACE: trace,
          QA08_OUTPUT_DIR: join(temp, 'results'),
        },
        timeout: 480000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error || result.status !== 0) throw Error('BROWSER_REGRESSION_FAILED');
    const coverage = summarize(
      JSON.parse(readFileSync(report, 'utf8')),
      readFileSync(trace, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
    );
    if (JSON.stringify(sources) !== JSON.stringify(sourceHashes())) throw Error('SOURCE_CHANGED_DURING_RUN');
    writeFileSync(
      output,
      JSON.stringify(
        {
          schemaVersion: '1.0',
          task: 'QA-08',
          status: 'PASS',
          scope: 'LOCAL_PROTOTYPE_BROWSER_REGRESSION',
          baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          executedAt: new Date().toISOString(),
          environment: {
            browser: 'headless Chromium',
            api: 'per-test synthetic HTTP fixtures; no deployed API',
            productionCredentialsUsed: false,
            snapshots: 'versioned DOM semantic snapshots; no pixel comparison',
          },
          sourceHashes: sources,
          coverage,
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
          task: 'QA-08',
          status: 'FAIL',
          scope: 'LOCAL_PROTOTYPE_BROWSER_REGRESSION',
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
