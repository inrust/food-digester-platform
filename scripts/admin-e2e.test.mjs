import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  summarizePhase,
  validateDiscovery,
  validateCrossPhaseIsolation,
  REQUIRED_TITLES,
  ROLES,
  ROUTES,
  PROOFS,
} from './run-admin-e2e.mjs';
function fixture(repeatEach = 1) {
  const specs = [],
    rows = [];
  let index = 0;
  for (const title of REQUIRED_TITLES) {
    const tests = [];
    for (let repeat = 0; repeat < repeatEach; repeat++) {
      tests.push({
        expectedStatus: 'passed',
        status: 'expected',
        repeatEachIndex: repeat,
        results: [{ status: 'passed', retry: 0, errors: [] }],
      });
      const proof = Object.fromEntries((PROOFS[title] ?? []).map((flag) => [flag, true]));
      const role = ROLES.find((r) => title === `QA05 role route and button matrix ${r}`);
      if (role) {
        proof.role = role;
        proof.routeMatrix = Object.entries(ROUTES).map(([path, allowed]) => ({
          path,
          allowed: allowed.includes(role),
        }));
        proof.buttons = [
          ['/customers', 'create-customer', ['PlatformSuperAdmin', 'PlatformOperator']],
          ['/sites', 'create-site', ['PlatformSuperAdmin', 'PlatformOperator']],
          ['/device-users', 'device-user-create', ['PlatformSuperAdmin', 'CustomerAdmin']],
          ['/settings', 'user-invite-open', ['PlatformSuperAdmin']],
          ['/consumables', 'consumable-request-create-open', ['PlatformSuperAdmin', 'PlatformOperator']],
          ['/licenses', 'license-create', ['PlatformSuperAdmin', 'PlatformOperator']],
          ['/configurations', 'config-create', ['PlatformSuperAdmin', 'PlatformOperator']],
          ['/contracts', 'contract-new-open', ['PlatformSuperAdmin']],
          ['/ota/packages', 'upload-session-open', ['PlatformSuperAdmin', 'PlatformOperator']],
          ['/ota/campaigns', 'campaign-create-open', ['PlatformSuperAdmin', 'PlatformOperator']],
        ]
          .filter(([path]) => ROUTES[path].includes(role))
          .map(([path, id, allowed]) => ({ path, id, enabled: allowed.includes(role) }));
      }
      rows.push({
        title,
        repeat,
        prefix: `QA05-${(++index).toString(16).padStart(12, '0').toUpperCase()}`,
        status: 'passed',
        retry: 0,
        cleanup: 'PASS',
        unhandled: [],
        responses: [
          { path: '/api/v1/admin/devices', method: 'GET', status: 403 },
          { path: '/api/v1/admin/customers', method: 'PATCH', status: 409 },
        ],
        proof,
      });
    }
    specs.push({ title, tests });
  }
  return {
    report: {
      config: { projects: [{ repeatEach, retries: 0 }] },
      stats: { expected: rows.length, unexpected: 0, flaky: 0, skipped: 0 },
      errors: [],
      suites: [{ suites: [{ specs }] }],
    },
    rows,
  };
}
test('serial and parallel repeated browser receipts are validated', () => {
  for (const repeat of [1, 2]) {
    const f = fixture(repeat);
    const summary = summarizePhase(f.report, f.rows, repeat);
    assert.equal(summary.testCount, 35 * repeat);
    assert.equal(summary.buttonAssertions, 33 * repeat);
  }
});
const probes = [
  [
    'missing required flow',
    (f) => {
      f.report.suites[0].suites[0].specs.pop();
    },
  ],
  [
    'skipped execution',
    (f) => {
      f.report.stats.skipped = 1;
    },
  ],
  [
    'flaky execution',
    (f) => {
      f.report.stats.flaky = 1;
    },
  ],
  [
    'retry hides failure',
    (f) => {
      f.report.suites[0].suites[0].specs[0].tests[0].results[0].retry = 1;
    },
  ],
  [
    'unexpected error',
    (f) => {
      f.report.errors.push({ message: 'browser crashed' });
    },
  ],
  [
    'missing isolated trace',
    (f) => {
      f.rows.pop();
    },
  ],
  [
    'data prefix reused',
    (f) => {
      f.rows[1].prefix = f.rows[0].prefix;
    },
  ],
  [
    'context cleanup failed',
    (f) => {
      f.rows[0].cleanup = 'FAIL';
    },
  ],
  [
    'unmocked network request',
    (f) => {
      f.rows[0].unhandled.push('GET external.test/api');
    },
  ],
  [
    'missing role proof',
    (f) => {
      delete f.rows.find((r) => r.proof.role === 'Auditor').proof.role;
    },
  ],
  [
    'wrong route permission',
    (f) => {
      const r = f.rows.find((r) => r.proof.role === 'CustomerViewer');
      r.proof.routeMatrix.find((c) => c.path === '/contracts/new').allowed = true;
    },
  ],
  [
    'Auditor OTA write enabled',
    (f) => {
      f.rows
        .find((r) => r.proof.role === 'Auditor')
        .proof.buttons.find((c) => c.id === 'campaign-create-open').enabled = true;
    },
  ],
  [
    'missing MFA assertion',
    (f) => {
      delete f.rows.find((r) => r.title === 'QA05 login SRP MFA error success logout without persisting password').proof
        .mfaRetry;
    },
  ],
  [
    'missing conflict response',
    (f) => {
      for (const r of f.rows) r.responses = r.responses.filter((c) => c.status !== 409);
    },
  ],
  [
    'missing forbidden response',
    (f) => {
      for (const r of f.rows) r.responses = r.responses.filter((c) => c.status !== 403);
    },
  ],
  [
    'missing repeat',
    (f) => {
      f.rows[0].repeat = 1;
    },
  ],
];
for (const [name, mutate] of probes)
  test(`fail closed: ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => summarizePhase(f.report, f.rows, 1));
  });
test('repeat traces cannot duplicate the first execution', () => {
  const f = fixture(2);
  f.rows[1].repeat = 0;
  assert.throws(() => summarizePhase(f.report, f.rows, 2));
});

test('manifest exactly matches independent Playwright discovery', () => {
  const cli = createRequire(resolve('apps/admin-web/package.json')).resolve('@playwright/test/cli');
  const report = JSON.parse(
    execFileSync(process.execPath, [cli, 'test', '--list', '--reporter=json'], {
      cwd: resolve('apps/admin-web'),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, QA05_PHASE: 'serial' },
    }),
  );
  assert.equal(validateDiscovery(report).distinctCases, 35);
});
for (const [name, mutate] of [
  ['missing case', (specs) => specs.pop()],
  ['extra case', (specs) => specs.push({ title: 'unregistered test', tests: [{}] })],
  [
    'duplicate replacing required case',
    (specs) => {
      specs[1] = specs[0];
    },
  ],
])
  test(`discovery fails closed: ${name}`, () => {
    const f = fixture();
    mutate(f.report.suites[0].suites[0].specs);
    assert.throws(() => validateDiscovery(f.report), /BROWSER_DISCOVERY_MANIFEST_MISMATCH/);
  });
test('old Viewer permission cannot pass the updated matrix', () => {
  const f = fixture();
  f.rows
    .find((row) => row.proof.role === 'CustomerViewer')
    .proof.routeMatrix.find((route) => route.path === '/device-users').allowed = false;
  assert.throws(() => summarizePhase(f.report, f.rows, 1), /INCORRECT_ROUTE_MATRIX/);
});
for (const title of Object.keys(PROOFS))
  test(`required behavioral proof cannot be missing: ${title}`, () => {
    const f = fixture();
    delete f.rows.find((row) => row.title === title).proof[PROOFS[title][0]];
    assert.throws(() => summarizePhase(f.report, f.rows, 1), /MISSING_WORKFLOW_PROOF/);
  });
test('serial and repeated phases require all 105 independent prefixes', () => {
  const a = fixture();
  const b = fixture(2);
  b.rows.forEach((row, i) => {
    row.prefix = `QA05-${(i + 1000).toString(16).padStart(12, '0').toUpperCase()}`;
  });
  const phases = [summarizePhase(a.report, a.rows, 1), summarizePhase(b.report, b.rows, 2)];
  assert.equal(validateCrossPhaseIsolation(phases), 105);
  phases[1].tests[0].prefix = phases[0].tests[0].prefix;
  assert.throws(() => validateCrossPhaseIsolation(phases), /CROSS_PHASE_DATA_COLLISION/);
});
