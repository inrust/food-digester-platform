import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizePhase, REQUIRED_TITLES, ROLES, ROUTES, PROOFS } from './run-admin-e2e.mjs';
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
    assert.equal(summarizePhase(f.report, f.rows, repeat).testCount, 30 * repeat);
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
      delete f.rows.find((r) => r.title in PROOFS).proof.mfaRetry;
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
