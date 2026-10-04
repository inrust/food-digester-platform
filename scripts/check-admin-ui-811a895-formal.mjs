/** Historical scoped receipt Gate. Does not replace the existing FE-06–19 target Gates. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { APP_ROUTES } from '../apps/admin-web/src/router/routes.ts';
import { hasPermission } from '../packages/auth/src/permissions.ts';

export const SOURCE_COMMIT = '811a8959477d7b2608f2562b5d221f8b40370944';
export const FORMAL_FOLDER = 'docs/audit/evidence/admin-ui-811a895-formal-2026-10-04';
export const ROLES = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
const BROWSERS = ['Chrome', 'Edge', 'Firefox'];
const READS = {
  customers: 'customer:read',
  sites: 'site:read',
  devices: 'device:read',
  contracts: 'contract:read',
  licenses: 'license:read',
  configurations: 'config:read',
  'device-users': 'device-user:read',
  alarms: 'alarm:read',
  dashboard: 'dashboard:read',
  audit: 'audit:read',
  users: 'user:read',
  settings: 'settings:read',
  reports: 'report:read',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rows = (value) => (Array.isArray(value) ? value : []);
const exact = (a, b) => a.length === b.length && new Set(a).size === b.length && b.every((x) => a.includes(x));
export function readFormalBundle(folder = FORMAL_FOLDER) {
  const readArtifact = (file) => {
    try {
      return readFileSync(resolve(folder, file));
    } catch {
      return null;
    }
  };
  const json = (file) => {
    try {
      return JSON.parse(readArtifact(file));
    } catch {
      return null;
    }
  };
  return {
    version: json('application-version.json'),
    postVersion: json('application-version-after.json'),
    business: json('real-business.json'),
    browsers: json('browsers.json'),
    ledger: json('owned-fixture-ledger.json'),
    privateLoginFileExists: existsSync('/tmp/fdp-811a895-formal-private-logins.json'),
    readArtifact,
  };
}
export function validateFormalBundle(bundle) {
  const { version: v, postVersion: p, business: a, browsers: b, ledger: l, readArtifact } = bundle;
  const errors = [],
    passed = [];
  const check = (id, condition) => {
    (condition ? passed : errors).push(id);
  };
  const digestFile = (file, expected) => {
    const bytes = readArtifact?.(file);
    return !!bytes && hash(bytes) === expected;
  };
  check(
    'exact-source',
    [v, a, b, l, p].every((x) => x?.sourceCommit === SOURCE_COMMIT),
  );
  check(
    'deployment-byte-verification',
    v?.gate === 'PASS' &&
      rows(v?.blockers).length === 0 &&
      rows(v?.lambdaArtifacts).length === 19 &&
      v.lambdaArtifacts.every((x) => x.matches === true && x.artifactSha256 === x.codeSha256 && x.rangeCount > 0),
  );
  check(
    'exact-CI-deploy-Amplify',
    v?.ci?.headSha === SOURCE_COMMIT &&
      v.ci.conclusion === 'success' &&
      v?.github?.headSha === SOURCE_COMMIT &&
      v.github.conclusion === 'success' &&
      v?.amplify?.[0]?.commitId === SOURCE_COMMIT &&
      v.amplify[0].status === 'SUCCEED',
  );
  check(
    'post-run-runtime-unchanged',
    p?.gate === 'PASS' &&
      rows(p?.lambdaArtifacts).length === 19 &&
      p.lambdaArtifacts.every((x) => {
        const old = rows(v?.lambdaArtifacts).find((y) => y.name === x.name);
        return (
          old &&
          old.codeSha256 === x.codeSha256 &&
          old.revisionId === x.revisionId &&
          x.state === 'Active' &&
          x.lastUpdateStatus === 'Successful'
        );
      }) &&
      p?.amplify?.[0]?.commitId === SOURCE_COMMIT,
  );
  check(
    'scoped-verdict-only',
    a?.status === 'PASS_SCOPED_FIVE_ROLE_CROSS_CUSTOMER' &&
      b?.status === 'PASS_SCOPED_THREE_VENDOR_BROWSERS' &&
      a.productionAccepted === false &&
      a.fullAdminTargetAccepted === false &&
      b.productionAccepted === false &&
      b.fullAdminTargetAccepted === false,
  );
  check(
    'real-target-no-mocks',
    a?.environment === 'fdp-test-app' &&
      a.apiBase === 'https://api.bio-nexa.com/api/v1/admin' &&
      a.mockedRequestCount === 0 &&
      b?.apiMock === false &&
      b.jwtModified === false &&
      b.credentialsInRepository === false,
  );
  check(
    'executor-source-binding',
    digestFile('real-business-executor.mjs', a?.executorSha256) &&
      digestFile('browser-executor.mjs', b?.executorSha256),
  );
  check(
    'receipt-binding',
    digestFile('application-version.json', a?.applicationVersionReceiptSha256) &&
      digestFile('application-version.json', b?.applicationVersionReceiptSha256) &&
      digestFile('browsers.json', a?.browserReceiptSha256),
  );
  const accounts = rows(l?.accounts),
    customers = rows(l?.customers),
    created = rows(l?.created),
    identities = rows(a?.identities);
  check(
    'five-distinct-roles',
    exact(
      accounts.map((x) => x.role),
      ROLES,
    ) &&
      exact(
        identities.map((x) => x.role),
        ROLES,
      ) &&
      new Set(identities.map((x) => x.sub)).size === 5,
  );
  check(
    'two-distinct-customers',
    customers.length === 2 &&
      new Set(customers.map((x) => x.id)).size === 2 &&
      customers.every((x) => /^[a-f0-9-]{36}$/.test(x.id)),
  );
  check(
    'customer-role-binding',
    accounts.find((x) => x.role === 'CustomerAdmin')?.customerId === customers[0]?.id &&
      accounts.find((x) => x.role === 'CustomerViewer')?.customerId === customers[1]?.id &&
      accounts.filter((x) => x.role.startsWith('Platform') || x.role === 'Auditor').every((x) => x.customerId === null),
  );
  check(
    'six-owned-business-records',
    created.length === 6 &&
      new Set(created.map((x) => x.id)).size === 6 &&
      customers.every((c) =>
        ['sites', 'device-users', 'contracts'].every(
          (kind) => created.filter((x) => x.kind === kind && x.customerId === c.id).length === 1,
        ),
      ),
  );
  const requests = rows(a?.requests),
    assertions = rows(a?.assertions);
  check(
    'all-API-requests-pass',
    requests.length >= 130 &&
      requests.every((x) => x.result === 'PASS' && typeof x.requestId === 'string' && x.requestId.length > 0),
  );
  check('all-API-assertions-pass', assertions.length >= 300 && assertions.every((x) => x.result === 'PASS'));
  const request = (id) => requests.find((x) => x.id === id);
  for (const role of ROLES) {
    check(
      role + ':permission-matrix',
      Object.entries(READS).every(([name, permission]) => {
        const q = request(role + ':read:' + name);
        return q?.method === 'GET' && q.status === (hasPermission(role, permission) ? 200 : 403);
      }),
    );
    for (const [i, c] of customers.entries()) {
      const own =
        !accounts.find((x) => x.role === role)?.customerId || accounts.find((x) => x.role === role).customerId === c.id;
      const site = created.find((x) => x.kind === 'sites' && x.customerId === c.id);
      check(
        role + ':site-isolation:' + i,
        request(role + ':site:' + i)?.path === '/sites/' + site?.id &&
          request(role + ':site:' + i)?.status === (own ? 200 : 403),
      );
      if (hasPermission(role, 'device-user:read')) {
        const du = created.find((x) => x.kind === 'device-users' && x.customerId === c.id);
        check(
          role + ':device-user-isolation:' + i,
          request(role + ':device-user-detail:' + i)?.path === '/device-users/' + du?.id &&
            request(role + ':device-user-detail:' + i)?.status === (own ? 200 : 404),
        );
        const effective = accounts.find((x) => x.role === role)?.customerId ?? c.id;
        const binding = assertions.find((x) => x.id === role + ':nonempty-binding:' + i);
        check(
          role + ':list-force-scope:' + i,
          binding?.requestedCustomerId === c.id &&
            binding.effectiveCustomerId === effective &&
            exact(rows(binding.returnedIds), [
              created.find((x) => x.kind === 'device-users' && x.customerId === effective)?.id,
            ]) &&
            exact(rows(binding.returnedCustomerIds), [effective]),
        );
      }
    }
    const identity = identities.find((x) => x.role === role),
      before = request(role + ':old-token-before-disable');
    check(
      role + ':same-token-before-disable',
      before?.status === 200 &&
        before.tokenSha256 === identity?.tokenSha256 &&
        Date.parse(before.startedAt) / 1000 < identity?.expiresAt,
    );
    for (const action of ['read', 'write']) {
      const q = request(role + ':old-token-' + action + '-denied');
      check(
        role + ':unexpired-token-' + action + '-rejected',
        q?.status === 401 &&
          q.errorCode === 'UNAUTHENTICATED' &&
          q.tokenSha256 === identity?.tokenSha256 &&
          q.tokenExpiresAt === identity?.expiresAt &&
          Date.parse(q.startedAt) / 1000 < identity?.expiresAt &&
          Date.parse(q.startedAt) > Date.parse(before?.startedAt),
      );
    }
    check(
      role + ':Cognito-disabled',
      assertions.some((x) => x.id === role + ':cognito-disabled' && x.result === 'PASS'),
    );
  }
  check(
    'duplicate-create-exactly-one',
    exact(
      ['duplicate-create-a', 'duplicate-create-b'].map((id) => request(id)?.status),
      [201, 409],
    ),
  );
  check(
    'If-Match-conflict-exactly-one',
    exact(
      ['device-user-if-match-a', 'device-user-if-match-b'].map((id) => request(id)?.status),
      [200, 409],
    ),
  );
  check('customer-cross-write-rejected', [403, 404].includes(request('admin-cross-customer-write-denied')?.status));
  check(
    'Viewer-six-writes-rejected',
    request('CustomerViewer:device-user-write-denied')?.status === 403 &&
      requests.filter((x) => x.id.startsWith('viewer-write-denied-')).length === 5 &&
      requests.filter((x) => x.id.startsWith('viewer-write-denied-')).every((x) => x.status === 403) &&
      assertions.some((x) => x.id === 'viewer-denials-no-mutation' && x.result === 'PASS'),
  );
  check(
    'three-actual-vendors',
    exact(
      rows(b?.browsers).map((x) => x.name),
      BROWSERS,
    ) &&
      rows(b?.browsers).every(
        (x) =>
          /^[0-9]+\./.test(x.version) &&
          (x.name === 'Chrome'
            ? x.binary === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
            : x.name === 'Edge'
              ? x.binary === '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
              : x.binary === '/private/tmp/fdp-formal-browser-811a895/Firefox.app/Contents/MacOS/firefox' &&
                x.capabilities?.browserName === 'firefox' &&
                x.capabilities?.acceptInsecureCerts === false),
      ),
  );
  const cases = rows(b?.cases),
    routes = APP_ROUTES.filter((x) => !x.public);
  check(
    'fifteen-distinct-browser-role-cases',
    exact(
      cases.map((x) => x.browser + ':' + x.role),
      BROWSERS.flatMap((n) => ROLES.map((role) => n + ':' + role)),
    ),
  );
  for (const c of cases) {
    const id = c.browser + ':' + c.role;
    check(id + ':case-pass', c.status === 'PASS' && rows(c.checks).every((x) => x.result === 'PASS'));
    check(
      id + ':all-source-routes',
      exact(
        rows(c.routes).map((x) => x.path),
        routes.map((x) => x.path),
      ) &&
        routes.every((route) => {
          const q = rows(c.routes).find((x) => x.path === route.path);
          return (
            q?.result === 'PASS' &&
            q.expected === (route.roles.includes(c.role) ? 'ALLOWED' : 'FORBIDDEN') &&
            q.actualPath === route.path &&
            q.forbiddenRendered === !route.roles.includes(c.role) &&
            q.viewport?.width === 1366 &&
            q.viewport?.height === 768 &&
            q.horizontalOverflow === false
          );
        }),
    );
    const required = [
      'real-ui-login',
      'role-menu-exact',
      'nonempty-owned-site-detail',
      'desktop-1440x900',
      'english-layout',
      'language-persists-reload',
      'logout',
      ...(c.role === 'PlatformOperator'
        ? ['operator-device-user-route-denied']
        : ['nonempty-owned-device-user-detail', 'device-user-controls']),
      ...(['PlatformSuperAdmin', 'CustomerAdmin'].includes(c.role) ? ['edit-modal-focus-and-required-reason'] : []),
    ];
    check(
      id + ':required-UI-checks',
      required.every((key) => rows(c.checks).some((x) => x.id === key && x.result === 'PASS')),
    );
    if (['PlatformSuperAdmin', 'CustomerAdmin'].includes(c.role)) {
      const owned = created.find((x) => x.kind === 'device-users' && x.customerId === customers[0]?.id);
      // The immutable executed collector spread detail.id over the check ID. Bind its
      // persisted readback to the exact owned record AND the hashed persisted screenshot.
      // Keep the historical receipt/executor unchanged; corrected future collectors use deviceUserId.
      check(
        id + ':owned-edit-persisted',
        owned !== undefined &&
          rows(c.checks).some((x) => x.id === owned.id && x.customerId === owned.customerId && x.result === 'PASS') &&
          rows(c.artifacts).some((x) => x.path.endsWith('-edit-persisted.png') && digestFile(x.path, x.sha256)),
      );
    }
    const writes = rows(c.checks).find((x) => x.id === 'device-user-controls')?.writeControlIds;
    check(
      id + ':write-controls',
      c.role === 'PlatformOperator' ||
        (['PlatformSuperAdmin', 'CustomerAdmin'].includes(c.role)
          ? exact(rows(writes), ['create', 'edit', 'password-reset', 'disable', 'assign', 'revoke'])
          : rows(writes).length === 0),
    );
    check(
      id + ':screenshots-bound',
      rows(c.artifacts).length >= 3 &&
        rows(c.artifacts).every((x) => /^[a-z0-9-]+\.png$/.test(x.path) && digestFile(x.path, x.sha256)),
    );
  }
  check(
    'all-owned-records-cleaned',
    a?.cleanupComplete === true &&
      rows(a?.cleanup).length === 13 &&
      rows(a?.cleanup).every((x) => x.result?.startsWith('PASS_')) &&
      [...accounts, ...customers, ...created].length === 13 &&
      [...accounts, ...customers, ...created].every((x) => x.cleanup?.startsWith('PASS_')),
  );
  check(
    'cleanup-IDs-bound',
    exact(
      rows(a?.cleanup).map((x) => x.id),
      [...accounts, ...customers, ...created].map((x) => x.id),
    ) &&
      rows(a?.cleanup).filter((x) => x.kind === 'account').length === 5 &&
      exact(
        rows(a?.cleanup)
          .filter((x) => x.kind === 'account')
          .map((x) => x.role),
        ROLES,
      ),
  );
  check(
    'private-credentials-removed',
    a?.privateLoginFileRemoved === true &&
      bundle.privateLoginFileExists === false &&
      b?.browserProcessCleanupFailure !== true,
  );
  return {
    status: errors.length ? 'FAIL' : 'PASS_SCOPED_FIVE_ROLE_TWO_CUSTOMER_THREE_BROWSER',
    sourceCommit: SOURCE_COMMIT,
    productionAccepted: false,
    fullAdminTargetAccepted: false,
    checks: passed.length + errors.length,
    passed,
    errors,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const receipt = validateFormalBundle(readFormalBundle(process.argv[2] ?? FORMAL_FOLDER));
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
  process.exitCode = receipt.errors.length ? 1 : 0;
}
