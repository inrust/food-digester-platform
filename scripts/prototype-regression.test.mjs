import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, ABSENCE, validateBindings } from './qa08-bindings.mjs';
import { matrix, CASES, summarize } from './run-prototype-regression.mjs';
const clone = (x) => structuredClone(x);
function fixture() {
  return {
    report: {
      errors: [],
      config: { projects: [{ repeatEach: 1, retries: 0 }] },
      stats: { expected: 24, unexpected: 0, flaky: 0, skipped: 0 },
      suites: [
        {
          specs: CASES.map((c) => ({
            title: c.title,
            tests: [
              { expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', retry: 0, errors: [] }] },
            ],
          })),
        },
      ],
    },
    rows: CASES.map((c, i) => ({
      title: c.title,
      prefix: `QA08-${i.toString(16).padStart(12, '0').toUpperCase()}`,
      status: 'passed',
      cleanup: 'PASS',
      updatedSnapshots: false,
      unhandled: [],
      viewport: c.width,
      groups: Object.keys(GROUPS).filter((k) => k.startsWith(c.pageState + '.')),
      absence: Object.keys(ABSENCE).filter((k) => k.startsWith(c.pageState + '.')),
      menus: matrix.menus.filter((m) => m.pageState === c.pageState).map((m) => m.menuId),
      guards: Object.fromEntries(
        [
          'responsiveSidebar',
          'noClipping',
          'unmappedFieldIgnored',
          'dangerousConfirmation',
          'cascadingReset',
          'fourAxes',
          'staticMedia',
          'unknownNotInvented',
          'noPlatformPassword',
          'entryPermissions',
        ].map((k) => [k, true]),
      ),
      calls: [{}],
      snapshotHash: 'fixture-hash',
    })),
  };
}
test('receipt covers all 128 decisions in two viewports', () => {
  const f = fixture();
  const c = summarize(f.report, f.rows, () => 'fixture-hash');
  assert.equal(c.positiveAssertions, 234);
  assert.equal(c.absenceAssertions, 22);
});
for (const [label, change] of [
  ['missing page', (f) => f.report.suites[0].specs.pop()],
  ['skipped case', (f) => f.report.stats.skipped++],
  ['flaky success', (f) => f.report.stats.flaky++],
  ['retry', (f) => f.report.suites[0].specs[0].tests[0].results[0].retry++],
  ['unexpected external network', (f) => f.rows[0].unhandled.push('https://external.test')],
  ['fixture collision', (f) => (f.rows[0].prefix = f.rows[1].prefix)],
  ['missing cleanup', (f) => (f.rows[0].cleanup = 'FAIL')],
  ['updated baseline masquerades as regression', (f) => (f.rows[0].updatedSnapshots = true)],
  ['missing group', (f) => f.rows[0].groups.pop()],
  ['duplicate group', (f) => f.rows[0].groups.push(f.rows[0].groups[0])],
  ['missing rejection assertion', (f) => f.rows[1].absence.pop()],
  ['missing menu', (f) => f.rows[0].menus.pop()],
  ['missing behavior guard', (f) => (f.rows[0].guards.dangerousConfirmation = false)],
  ['wrong viewport', (f) => (f.rows[0].viewport = 768)],
  ['snapshot hash mismatch', (f) => (f.rows[0].snapshotHash = 'altered')],
])
  test(`fail closed: ${label}`, () => {
    const f = fixture();
    change(f);
    assert.throws(() => summarize(f.report, f.rows, () => 'fixture-hash'));
  });
test('binding omission, duplication and reject implementation fail closed', () => {
  const missing = clone(GROUPS);
  missing['dashboard.summary'].pop();
  assert.throws(() => validateBindings(matrix, missing));
  const duplicate = clone(GROUPS);
  duplicate['dashboard.summary'].push(duplicate['dashboard.summary'][0]);
  assert.throws(() => validateBindings(matrix, duplicate));
  const invented = clone(GROUPS);
  invented['dashboard.summary'][0] = 'settings.modal.passwordInput';
  assert.throws(() => validateBindings(matrix, invented));
  const absent = clone(ABSENCE);
  delete absent['settings.modal.passwordInput'];
  assert.throws(() => validateBindings(matrix, GROUPS, absent));
});
