import test from 'node:test';
import assert from 'node:assert/strict';
import { readFormalBundle, validateFormalBundle } from './check-admin-ui-811a895-formal.mjs';

const actual = readFormalBundle();
function changed(change) {
  const bundle = { ...structuredClone({ ...actual, readArtifact: undefined }), readArtifact: actual.readArtifact };
  change(bundle);
  return validateFormalBundle(bundle);
}
test('scoped Gate accepts the archived real-target receipt, without promoting full acceptance', () => {
  const r = validateFormalBundle(actual);
  assert.deepEqual(r.errors, []);
  assert.equal(r.productionAccepted, false);
  assert.equal(r.fullAdminTargetAccepted, false);
});
const probes = [
  ['missing role', 'five-distinct-roles', (r) => r.business.identities.pop()],
  ['wrong SHA', 'exact-source', (r) => (r.browsers.sourceCommit = '0'.repeat(40))],
  ['unverified Lambda', 'deployment-byte-verification', (r) => (r.version.lambdaArtifacts[0].matches = false)],
  ['runtime drift', 'post-run-runtime-unchanged', (r) => (r.postVersion.lambdaArtifacts[0].revisionId = 'changed')],
  ['mocked API', 'real-target-no-mocks', (r) => (r.browsers.apiMock = true)],
  [
    'empty tenant',
    'six-owned-business-records',
    (r) =>
      (r.ledger.created = r.ledger.created.filter(
        (x) => !(x.kind === 'device-users' && x.customerId === r.ledger.customers[1].id),
      )),
  ],
  [
    'cross-Customer list leak',
    'CustomerViewer:list-force-scope:0',
    (r) => {
      const b = r.business.assertions.find((x) => x.id === 'CustomerViewer:nonempty-binding:0');
      b.returnedCustomerIds = [r.ledger.customers[0].id];
    },
  ],
  [
    'Viewer mutation accepted',
    'Viewer-six-writes-rejected',
    (r) => (r.business.requests.find((x) => x.id.startsWith('viewer-write-denied-')).status = 200),
  ],
  [
    'expired old Token',
    'CustomerViewer:unexpired-token-read-rejected',
    (r) => {
      const q = r.business.requests.find((x) => x.id === 'CustomerViewer:old-token-read-denied');
      q.startedAt = new Date((q.tokenExpiresAt + 1) * 1000).toISOString();
    },
  ],
  [
    'two duplicate successes',
    'duplicate-create-exactly-one',
    (r) =>
      (r.business.requests.find((x) => x.id === 'duplicate-create-b').status = r.business.requests.find(
        (x) => x.id === 'duplicate-create-a',
      ).status),
  ],
  [
    'two optimistic successes',
    'If-Match-conflict-exactly-one',
    (r) =>
      (r.business.requests.find((x) => x.id === 'device-user-if-match-b').status = r.business.requests.find(
        (x) => x.id === 'device-user-if-match-a',
      ).status),
  ],
  [
    'bundled Firefox',
    'three-actual-vendors',
    (r) => (r.browsers.browsers.find((x) => x.name === 'Firefox').binary = '/tmp/ms-playwright/firefox/firefox'),
  ],
  ['missing browser-role case', 'fifteen-distinct-browser-role-cases', (r) => r.browsers.cases.pop()],
  [
    'persisted edit belongs to another record',
    'Chrome:PlatformSuperAdmin:owned-edit-persisted',
    (r) => {
      const c = r.browsers.cases.find((x) => x.browser === 'Chrome' && x.role === 'PlatformSuperAdmin');
      c.checks.find(
        (x) =>
          x.customerId &&
          x.id ===
            r.ledger.created.find((y) => y.kind === 'device-users' && y.customerId === r.ledger.customers[0].id).id,
      ).id = 'foreign-record';
    },
  ],
  [
    'forbidden page rendered as business page',
    'Chrome:CustomerViewer:all-source-routes',
    (r) =>
      (r.browsers.cases
        .find((x) => x.browser === 'Chrome' && x.role === 'CustomerViewer')
        .routes.find((x) => x.expected === 'FORBIDDEN').forbiddenRendered = false),
  ],
  [
    'missing screenshot',
    'Chrome:PlatformSuperAdmin:screenshots-bound',
    (r) => (r.readArtifact = (file) => (file.endsWith('.png') ? null : actual.readArtifact(file))),
  ],
  [
    'cleanup duplicate hides missing ID',
    'cleanup-IDs-bound',
    (r) => (r.business.cleanup[0].id = r.business.cleanup[1].id),
  ],
  ['cleanup incomplete', 'all-owned-records-cleaned', (r) => (r.business.cleanupComplete = false)],
  ['private credentials retained', 'private-credentials-removed', (r) => (r.privateLoginFileExists = true)],
  ['scope promoted', 'scoped-verdict-only', (r) => (r.business.productionAccepted = true)],
];
for (const [description, code, change] of probes)
  test('scoped Gate rejects ' + description, () => assert.ok(changed(change).errors.includes(code)));
