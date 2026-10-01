import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCoreApi, summarizeTestExecution } from './run-core-api-integration.mjs';
import { QA04_FACTORIES, QA04_ROLES, QA04_FILES, QA04_REQUIRED_CASES } from './qa04-manifest.mjs';

// Synthetic Gate inputs exercise rejection logic, never serve as integration receipts.
function sample() {
  const rows = [...new Set(Object.values(QA04_FACTORIES))].flatMap((area) => [
    {
      kind: 'handler',
      source: 'REAL_HANDLER',
      area,
      method: 'sample',
      status: 200,
      roles: QA04_ROLES,
      errorCode: null,
      ifMatch: null,
      replayed: true,
    },
    {
      kind: 'handler',
      source: 'REAL_HANDLER',
      area,
      method: 'sample',
      status: 409,
      roles: QA04_ROLES,
      errorCode: 'VERSION_CONFLICT',
      ifMatch: '1',
      replayed: false,
    },
  ]);
  rows.push({ ...rows[0], status: 401 });
  const proofs = [
    {
      name: 'five-roles-two-tenants',
      roles: QA04_ROLES,
      unauthorizedNoBusinessWrites: true,
      matrix: QA04_ROLES.map((role) => ({
        role,
        own: 200,
        cross: role.startsWith('Customer') ? 403 : 200,
        suspend: ['PlatformSuperAdmin', 'PlatformOperator'].includes(role) ? 200 : 403,
        audit: ['PlatformSuperAdmin', 'Auditor'].includes(role) ? 200 : 403,
      })),
    },
    { name: 'if-match-race', statuses: [200, 409], version: 2, successAudits: 1, staleRetryNoWrites: true },
    { name: 'atomic-audit-replay', rollback: true, replayNoWrites: true, successAudits: 1, reactivated: true },
  ].map((proof, i) => {
    const prefix = `QA04-${String(i).padStart(12, '0')}`;
    return {
      kind: 'proof',
      status: 'PASS',
      cleanup: 'PASS',
      prefix,
      customers: [`${prefix}-A`, `${prefix}-B`],
      ...proof,
    };
  });
  return [...rows, ...proofs];
}
test('QA04 coverage Gate accepts complete matrix and proofs', () =>
  assert.equal(summarizeCoreApi(sample()).domainCoverage.length, 14));
for (const [name, mutate] of [
  ['missing domain', (r) => r.filter((x) => x.area !== 'Sync')],
  ['no negative path', (r) => r.filter((x) => !(x.area === 'License' && x.status >= 400))],
  [
    'untrusted handler',
    (r) => {
      r[0].source = 'MOCK';
      return r;
    },
  ],
  [
    'missing role',
    (r) => {
      r.find((x) => x.name === 'five-roles-two-tenants').roles.pop();
      return r;
    },
  ],
  [
    'cross-tenant leak',
    (r) => {
      r.find((x) => x.name === 'five-roles-two-tenants').matrix[4].cross = 200;
      return r;
    },
  ],
  [
    'two write winners',
    (r) => {
      r.find((x) => x.name === 'if-match-race').statuses = [200, 200];
      return r;
    },
  ],
  [
    'duplicate audit',
    (r) => {
      r.find((x) => x.name === 'atomic-audit-replay').successAudits = 2;
      return r;
    },
  ],
  [
    'rollback missing',
    (r) => {
      r.find((x) => x.name === 'atomic-audit-replay').rollback = false;
      return r;
    },
  ],
  [
    'unclean resource',
    (r) => {
      r.find((x) => x.kind === 'proof').cleanup = 'FAIL';
      return r;
    },
  ],
  [
    'reused isolation',
    (r) => {
      const p = r.filter((x) => x.kind === 'proof');
      p[1].prefix = p[0].prefix;
      return r;
    },
  ],
  ['no observed replay', (r) => r.map((x) => ({ ...x, replayed: false }))],
])
  test(`QA04 coverage Gate rejects ${name}`, () => {
    assert.throws(() => summarizeCoreApi(mutate(structuredClone(sample()))));
  });

function testReport() {
  const testResults = QA04_FILES.map((file) => ({
    name: process.cwd() + '/' + file,
    status: 'passed',
    assertionResults: QA04_REQUIRED_CASES.filter((r) => r.file === file).map((r) => ({
      fullName: r.name,
      status: 'passed',
    })),
  }));
  return {
    success: true,
    numFailedTests: 0,
    numPendingTests: 0,
    numPassedTests: QA04_REQUIRED_CASES.length,
    testResults,
  };
}
test('QA04 required acceptance cases are enforced', () =>
  assert.equal(summarizeTestExecution(testReport()).requiredAcceptanceCases, 18));
test('QA04 skipped assertion fails execution Gate', () => {
  const r = testReport();
  r.testResults[0].assertionResults[0].status = 'pending';
  assert.throws(() => summarizeTestExecution(r));
});
test('QA04 removed state-machine assertion fails coverage Gate', () => {
  const r = testReport();
  r.testResults[0].assertionResults[0].fullName = 'unrelated green test';
  assert.throws(() => summarizeTestExecution(r));
});
