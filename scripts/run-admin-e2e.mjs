#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROLES = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
const platform = ROLES.slice(0, 3);
export const ROUTES = Object.fromEntries([
  ...[
    '/dashboard',
    '/devices/view',
    '/devices/groups',
    '/devices/manage',
    '/sites',
    '/alarms',
    '/media',
    '/esg/overview',
    '/esg/devices',
  ].map((p) => [p, ROLES]),
  ...[
    '/customers',
    '/licenses',
    '/configurations',
    '/contracts',
    '/contracts/detail',
    '/ota/packages',
    '/ota/campaigns',
  ].map((p) => [p, platform]),
  ['/devices/operate', ['PlatformSuperAdmin', 'PlatformOperator', 'CustomerAdmin']],
  ['/device-users', ['PlatformSuperAdmin', 'Auditor', 'CustomerAdmin', 'CustomerViewer']],
  ['/audit-logs', ['PlatformSuperAdmin', 'Auditor']],
  ['/contracts/new', ['PlatformSuperAdmin']],
  ['/consumables', ['PlatformSuperAdmin', 'PlatformOperator', 'CustomerAdmin', 'CustomerViewer']],
  ['/settings', ['PlatformSuperAdmin', 'CustomerAdmin']],
]);
const BUTTONS = {
  'create-customer': ['/customers', platform.slice(0, 2)],
  'create-site': ['/sites', platform.slice(0, 2)],
  'device-user-create': ['/device-users', ['PlatformSuperAdmin', 'CustomerAdmin']],
  'user-invite-open': ['/settings', ['PlatformSuperAdmin']],
  'consumable-request-create-open': ['/consumables', platform.slice(0, 2)],
  'license-create': ['/licenses', platform.slice(0, 2)],
  'config-create': ['/configurations', platform.slice(0, 2)],
  'contract-new-open': ['/contracts', ['PlatformSuperAdmin']],
  'upload-session-open': ['/ota/packages', platform.slice(0, 2)],
  'campaign-create-open': ['/ota/campaigns', platform.slice(0, 2)],
};
export const PROOFS = {
  'H-01 API 拒绝停用会话后清除浏览器会话并返回登录': ['disabledSessionLogout'],
  'M-01 CustomerViewer 从菜单查询设备用户详情，全部写入口隐藏': ['viewerOwnRead', 'viewerReadOnly'],
  ...Object.fromEntries(
    [1366, 1440, 1920].map((width, index) => [
      `UI redesign: all business routes at ${width}x${[768, 900, 1080][index]}`,
      ['desktopRoutes', 'desktopLayout', 'dialogKeyboard', 'languageSwitch'],
    ]),
  ),
  'QA05 login SRP MFA error success logout without persisting password': ['login', 'mfaRetry', 'logout'],
  'QA05 ESG cursor totals export snapshot timezone and empty state': ['cursorExport', 'timezone', 'empty'],
  'QA05 Command dangerous confirmation terminal result and publish failure': [
    'dangerousConfirmation',
    'commandTerminal',
    'publishFailure',
  ],
  'QA05 Media expiry renew 403 and audit read-only zero writes': [
    'mediaExpiry',
    'mediaRenew',
    'media403',
    'auditReadOnly',
  ],
};
export const REQUIRED_TITLES = [
  '无 Token 安全回登录；五角色菜单和受限路由均由组合根守卫',
  '刷新失败清会话，API 403 保留会话并呈现无权',
  'Customer scope 与 Dashboard 离线/无 entitlement 动作在真实浏览器失败关闭',
  'Onboarding 审批双击只提交一次，展示录入来源和证书状态',
  'Customer/Site CRUD 关键路径：创建、非法时区、关联停用提示与 409',
  '1440/768/375 响应式布局、横向表格和对话框键盘边界',
  'FE-06 至 FE-10 六个生产路由可运行，并覆盖成功、空态、分页入口、时区与响应式',
  'FE-06 至 FE-10 在 403/404、Customer scope、详情焦点与重复提交场景失败关闭',
  'FE-11 至 FE-15 七个生产路由由真实控制器驱动，并覆盖媒体签发与审计详情',
  'FE-11 至 FE-15 API 403 与路由角色边界在真实浏览器失败关闭',
  'FE-17 新建权限与零设备第二阶段在真实浏览器失败关闭',
  'FE-18 Chromium 覆盖 unknown/stale、联系人按需零预载与申请状态机',
  'FE-16 Chromium 覆盖邀请、角色、Scope、重置与设置 409 回源',
  'FE-17 Chromium 覆盖绑定、解绑、续约与终止并保留 License 边界',
  ...['zh-CN', 'en'].flatMap((language) =>
    [375, 768, 1440].map((width) => `FE-19 Chromium 22 个生产路由：${language} / ${width}px`),
  ),
  'FE-19 语言选择在刷新后保持',
  ...ROLES.map((role) => `QA05 role route and button matrix ${role}`),
  ...Object.keys(PROOFS),
];
function reportSpecs(report) {
  const specs = [];
  function walk(suite) {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) walk(child);
  }
  for (const suite of report.suites ?? []) walk(suite);
  return specs;
}
/** 与 Playwright 实际发现的测试集交叉核对，禁止遗漏、新增未登记或重复标题静默通过。 */
export function validateDiscovery(report) {
  const specs = reportSpecs(report);
  const titles = specs.map((spec) => spec.title);
  if (
    report.errors?.length ||
    report.config?.projects?.length !== 1 ||
    report.config.projects[0].repeatEach !== 1 ||
    report.config.projects[0].retries !== 0 ||
    new Set(REQUIRED_TITLES).size !== REQUIRED_TITLES.length ||
    titles.length !== REQUIRED_TITLES.length ||
    new Set(titles).size !== titles.length ||
    REQUIRED_TITLES.some((title) => !titles.includes(title)) ||
    specs.some((spec) => spec.tests?.length !== 1)
  )
    throw new Error('BROWSER_DISCOVERY_MANIFEST_MISMATCH');
  return { distinctCases: titles.length, titles };
}
export function summarizePhase(report, rows, repeatEach) {
  const specs = reportSpecs(report);
  const tests = specs.flatMap((spec) => (spec.tests ?? []).map((test) => ({ title: spec.title, ...test })));
  const expected = REQUIRED_TITLES.length * repeatEach;
  if (
    report.errors?.length ||
    report.stats?.expected !== expected ||
    report.stats?.unexpected !== 0 ||
    report.stats?.flaky !== 0 ||
    report.stats?.skipped !== 0 ||
    tests.length !== expected ||
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
    throw new Error('INCOMPLETE_BROWSER_EXECUTION');
  if (
    rows.length !== expected ||
    new Set(rows.map((r) => r.prefix)).size !== expected ||
    rows.some(
      (r) =>
        r.status !== 'passed' ||
        r.cleanup !== 'PASS' ||
        r.retry !== 0 ||
        !/^QA05-[A-F0-9]{12}$/.test(r.prefix) ||
        !Array.isArray(r.unhandled) ||
        r.unhandled.length ||
        !Array.isArray(r.responses),
    )
  )
    throw new Error('INVALID_ISOLATION_OR_NETWORK_PROOF');
  for (const title of REQUIRED_TITLES) {
    const executions = tests.filter((t) => t.title === title);
    const traces = rows.filter((r) => r.title === title);
    if (
      executions.length !== repeatEach ||
      traces.length !== repeatEach ||
      report.config?.projects?.length !== 1 ||
      report.config.projects[0].repeatEach !== repeatEach ||
      report.config.projects[0].retries !== 0 ||
      new Set(traces.map((r) => r.repeat)).size !== repeatEach ||
      traces.some((r) => !Number.isInteger(r.repeat) || r.repeat < 0 || r.repeat >= repeatEach)
    )
      throw new Error('MISSING_REQUIRED_CASE_OR_REPEAT');
  }
  for (const row of rows.filter((r) => r.proof.role)) {
    const { role, routeMatrix, buttons } = row.proof;
    if (
      !ROLES.includes(role) ||
      row.title !== `QA05 role route and button matrix ${role}` ||
      routeMatrix?.length !== Object.keys(ROUTES).length ||
      new Set(routeMatrix.map((c) => c.path)).size !== routeMatrix.length ||
      routeMatrix.some((c) => !ROUTES[c.path] || c.allowed !== ROUTES[c.path].includes(role))
    )
      throw new Error('INCORRECT_ROUTE_MATRIX');
    const expectedButtons = Object.entries(BUTTONS).filter(([, [path]]) => ROUTES[path].includes(role));
    if (
      buttons?.length !== expectedButtons.length ||
      new Set(buttons.map((c) => c.id)).size !== buttons.length ||
      expectedButtons.some(
        ([id, [path, allowed]]) =>
          !buttons.some((c) => c.id === id && c.path === path && c.enabled === allowed.includes(role)),
      )
    )
      throw new Error('INCORRECT_BUTTON_MATRIX');
  }
  for (const role of ROLES)
    if (rows.filter((r) => r.proof.role === role).length !== repeatEach) throw new Error('MISSING_ROLE_PROOF');
  for (const [title, flags] of Object.entries(PROOFS))
    if (rows.filter((r) => r.title === title).some((r) => flags.some((flag) => r.proof[flag] !== true)))
      throw new Error('MISSING_WORKFLOW_PROOF');
  const responses = rows.flatMap((r) => r.responses);
  if (!responses.some((r) => r.status === 403) || !responses.some((r) => r.status === 409))
    throw new Error('MISSING_NEGATIVE_RESPONSES');
  return {
    testCount: expected,
    distinctCases: REQUIRED_TITLES.length,
    repeatEach,
    roleRouteAssertions: Object.keys(ROUTES).length * ROLES.length * repeatEach,
    buttonAssertions: rows.filter((row) => row.proof.role).reduce((sum, row) => sum + row.proof.buttons.length, 0),
    observedApiResponses: responses.length,
    statuses: [...new Set(responses.map((r) => r.status))].sort(),
    tests: rows.map(({ responses, ...row }) => ({ ...row, observedApiResponses: responses.length })),
  };
}
export function validateCrossPhaseIsolation(phases) {
  const total = phases.reduce((sum, phase) => sum + phase.testCount, 0);
  const prefixes = phases.flatMap((phase) => phase.tests.map((row) => row.prefix));
  if (prefixes.length !== total || new Set(prefixes).size !== total) throw new Error('CROSS_PHASE_DATA_COLLISION');
  return total;
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
      'apps/admin-web/test/ota.test.tsx',
      'apps/admin-web/package.json',
      'packages/auth/src',
      'contracts/prototype',
      'package.json',
      'pnpm-lock.yaml',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  files.push(
    'apps/admin-web/tsconfig.e2e.json',
    'apps/admin-web/e2e/qa05-api-fixtures.ts',
    'apps/admin-web/e2e/qa05-fixture.ts',
    'apps/admin-web/e2e/qa05-workflows.spec.ts',
    'scripts/run-admin-e2e.mjs',
    'scripts/admin-e2e.test.mjs',
  );
  return Object.fromEntries(
    [...new Set(files)].sort().map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
  );
}
export function main(args) {
  if (args.length !== 1) throw new Error('USAGE: pnpm test:admin-e2e-suite <local-receipt.json>');
  const output = resolve(args[0]);
  const temp = mkdtempSync(join(tmpdir(), 'qa05-browser-'));
  try {
    const sources = sourceHashes();
    const discoveryResult = spawnSync(
      process.execPath,
      [
        createRequire(resolve('apps/admin-web/package.json')).resolve('@playwright/test/cli'),
        'test',
        '--list',
        '--reporter=json',
      ],
      {
        cwd: resolve('apps/admin-web'),
        encoding: 'utf8',
        env: { ...process.env, QA05_PHASE: 'serial' },
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (discoveryResult.error || discoveryResult.status !== 0) throw new Error('BROWSER_DISCOVERY_FAILED');
    const discovery = validateDiscovery(JSON.parse(discoveryResult.stdout));
    const phases = [];
    for (const [phase, repeatEach, workers] of [
      ['serial', 1, 1],
      ['parallel-repeat', 2, 2],
    ]) {
      const report = join(temp, `${phase}.json`),
        trace = join(temp, `${phase}.jsonl`);
      const result = spawnSync(
        process.execPath,
        [createRequire(resolve('apps/admin-web/package.json')).resolve('@playwright/test/cli'), 'test'],
        {
          cwd: resolve('apps/admin-web'),
          encoding: 'utf8',
          env: {
            ...process.env,
            QA05_PHASE: phase,
            QA05_REPORT: report,
            QA05_TRACE: trace,
            QA05_OUTPUT_DIR: join(temp, phase),
          },
          timeout: 240000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
      if (result.error || result.status !== 0) throw new Error(`BROWSER_PHASE_FAILED ${phase}`);
      phases.push({
        phase,
        workers,
        ...summarizePhase(
          JSON.parse(readFileSync(report, 'utf8')),
          readFileSync(trace, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
          repeatEach,
        ),
      });
    }
    const totalExecutions = validateCrossPhaseIsolation(phases);
    if (JSON.stringify(sources) !== JSON.stringify(sourceHashes())) throw new Error('SOURCE_CHANGED_DURING_RUN');
    writeFileSync(
      output,
      JSON.stringify(
        {
          schemaVersion: '1.0',
          task: 'QA-05',
          status: 'PASS',
          scope: 'LOCAL_BROWSER_E2E',
          baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          executedAt: new Date().toISOString(),
          environment: {
            browser: 'headless Chromium',
            api: 'per-test route fixtures; no deployed API',
            identity: 'scripted Cognito SRP/MFA and synthetic tokens',
            productionCredentialsUsed: false,
          },
          sourceHashes: sources,
          phases,
          discovery,
          totalExecutions,
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
          task: 'QA-05',
          status: 'FAIL',
          scope: 'LOCAL_BROWSER_E2E',
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
