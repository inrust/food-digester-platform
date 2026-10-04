/** Limited real target probes; only the explicitly confirmed UI-ACCEPT-20261004 identities and fixtures. */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';

const base = 'https://api.bio-nexa.com/api/v1';
const pool = 'ap-southeast-1_hZMX8LpFo';
const region = 'ap-southeast-1';
const output = 'docs/audit/evidence/admin-ui-target-2026-10-04/scoped-api-verification.json';
const privateOutput = '/tmp/fdp-admin-ui-20261004-private-logins.json';
const ledger = JSON.parse(readFileSync('docs/audit/evidence/admin-ui-target-2026-10-04/owned-fixture-ledger.json'));
const expected = [
  ['ui-accept-20261004-a@example.invalid', 'CustomerAdmin', '94371262-8afe-4fab-b748-2fb6d95c2bcd'],
  ['ui-accept-20261004-b@example.invalid', 'CustomerViewer', '54bcc341-d8c5-4624-b694-d0702282105d'],
];
if (
  ledger.environment !== 'fdp-test-app' ||
  ledger.accounts.length !== 2 ||
  !expected.every(([username, role, customerId]) =>
    ledger.accounts.some((x) => x.username === username && x.role === role && x.customerId === customerId),
  )
)
  throw Error('OWN_FIXTURE_SCOPE_REQUIRED');
const identity = spawnSync('aws', ['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--output', 'json'], {
  encoding: 'utf8',
  timeout: 30000,
});
if (identity.status !== 0 || JSON.parse(identity.stdout).Account !== '065986019555') throw Error('WRONG_AWS_ACCOUNT');
let cachedCredentials;
const credentials = () => {
  if (cachedCredentials) return cachedCredentials;
  const p = spawnSync('aws', ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (p.status !== 0) throw Error('AWS_CREDENTIALS_UNAVAILABLE');
  const x = JSON.parse(p.stdout);
  cachedCredentials = { accessKeyId: x.AccessKeyId, secretAccessKey: x.SecretAccessKey, sessionToken: x.SessionToken };
  return cachedCredentials;
};
const cognito = new sdk.CognitoIdentityProviderClient({ region, credentials, maxAttempts: 1 });
const call = (Command, args) => cognito.send(new Command(args), { abortSignal: AbortSignal.timeout(30000) });
const r = {
  schemaVersion: '1.0',
  scope: 'TWO_CONFIRMED_CUSTOMER_IDENTITIES_SITE_ISOLATION_DEVICE_USER_CONCURRENCY',
  sourceCommit: ledger.sourceCommit,
  environment: 'fdp-test-app',
  productionAccepted: false,
  fullAdminTargetAccepted: false,
  startedAt: new Date().toISOString(),
  status: 'RUNNING',
  identities: [],
  requests: [],
  assertions: [],
  cleanup: [],
  credentialsInRepository: false,
};
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
const check = (id, ok, detail = {}) => {
  r.assertions.push({ id, result: ok ? 'PASS' : 'FAIL', ...detail });
  save();
};
const sessions = new Map();
const logins = [];
let ownDeviceUser;
save();
async function api(id, role, method, path, statuses, body, headers = {}) {
  const start = performance.now();
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: 'Bearer ' + sessions.get(role).idToken, 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const row = {
    id,
    role,
    method,
    path,
    status: response.status,
    expectedStatuses: statuses,
    requestId: response.headers.get('x-amzn-requestid'),
    latencyMs: Math.round(performance.now() - start),
    result: statuses.includes(response.status) ? 'PASS' : 'FAIL',
  };
  // Never persist raw response bodies or authorization headers.
  r.requests.push(row);
  check(id + ':no-secret-fields', !/"(?:password|passwordHash|accessToken|idToken|refreshToken)"\s*:/i.test(text));
  save();
  return { status: response.status, data: data?.data, row };
}
try {
  // Validate both ownership bindings and existing grants before changing either new test credential.
  for (const [username, role, customerId] of expected) {
    const user = await call(sdk.AdminGetUserCommand, { UserPoolId: pool, Username: username });
    const groups = await call(sdk.AdminListGroupsForUserCommand, { UserPoolId: pool, Username: username });
    if (
      !user.Enabled ||
      new Date(user.UserCreateDate).toISOString().slice(0, 10) !== '2026-10-04' ||
      user.UserAttributes.find((a) => a.Name === 'custom:customer_id')?.Value !== customerId ||
      groups.Groups.length !== 1 ||
      groups.Groups[0].GroupName !== role
    )
      throw Error('IDENTITY_SCOPE_MISMATCH');
    r.identities.push({ username, role, customerId, sub: user.UserAttributes.find((a) => a.Name === 'sub')?.Value });
    save();
  }
  for (const [username, role, customerId] of expected) {
    const password = 'A!z9' + randomBytes(24).toString('base64url');
    await call(sdk.AdminSetUserPasswordCommand, {
      UserPoolId: pool,
      Username: username,
      Password: password,
      Permanent: true,
    });
    const auth = await new AuthFlow({
      idp: createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
      userPoolId: pool,
      sessionManager: { establish() {} },
    }).login(username, password);
    if (auth.status !== 'authenticated') throw Error('REAL_SRP_AUTH_REQUIRED');
    sessions.set(role, auth.session);
    const claims = JSON.parse(Buffer.from(auth.session.idToken.split('.')[1], 'base64url'));
    check(
      role + ':real-srp-claims',
      claims.iss === `https://cognito-idp.${region}.amazonaws.com/${pool}` &&
        claims['custom:customer_id'] === customerId &&
        claims['cognito:groups'].length === 1 &&
        claims['cognito:groups'][0] === role,
    );
    logins.push({ username, role, password });
  }
  writeFileSync(privateOutput, JSON.stringify(logins), { mode: 0o600 });
  const [siteA, siteB] = ledger.created.filter((x) => x.kind === 'site');
  for (const [role, own, foreign] of [
    ['CustomerAdmin', siteA, siteB],
    ['CustomerViewer', siteB, siteA],
  ]) {
    const yes = await api(role + ':own-site', role, 'GET', '/admin/sites/' + own.id, [200]);
    check(role + ':own-site-binding', yes.data?.customerId === own.customerId && yes.data?.id === own.id);
    await api(role + ':foreign-site-denied', role, 'GET', '/admin/sites/' + foreign.id, [403, 404]);
    const list = await api(role + ':own-sites-list', role, 'GET', '/admin/sites', [200]);
    check(
      role + ':list-isolation',
      Array.isArray(list.data) && list.data.length >= 1 && list.data.every((x) => x.customerId === own.customerId),
    );
    const filtered = await api(
      role + ':foreign-customer-filter',
      role,
      'GET',
      '/admin/sites?customerId=' + foreign.customerId,
      [200, 403, 404],
    );
    check(
      role + ':foreign-filter-no-leak',
      filtered.status !== 200 ||
        (Array.isArray(filtered.data) && filtered.data.every((x) => x.customerId === own.customerId)),
    );
    for (const path of ['/admin/users', '/admin/audit-logs', '/admin/settings'])
      await api(role + ':deny-' + path.split('/').at(-1), role, 'GET', path, [403]);
  }
  const created = await api('device-user-create-own', 'CustomerAdmin', 'POST', '/admin/device-users', [201], {
    customerId: expected[0][2],
    username: 'ui-accept-20261004-concurrency',
    displayName: 'UI Acceptance concurrency fixture',
    password: 'A!z9' + randomBytes(20).toString('base64url'),
    reason: 'UI-ACCEPT-20261004 own temporary fixture',
  });
  ownDeviceUser = created.data;
  r.ownDeviceUser = ownDeviceUser
    ? { id: ownDeviceUser.deviceUserId, customerId: ownDeviceUser.customerId, version: ownDeviceUser.version }
    : null;
  save();
  if (!ownDeviceUser?.deviceUserId || ownDeviceUser.customerId !== expected[0][2])
    throw Error('OWN_DEVICE_USER_CREATE_REQUIRED');
  const path = '/admin/device-users/' + ownDeviceUser.deviceUserId;
  await api('viewer-foreign-device-user-denied', 'CustomerViewer', 'GET', path, [403, 404]);
  await api(
    'viewer-write-denied',
    'CustomerViewer',
    'PATCH',
    path,
    [403],
    { displayName: 'must not persist', reason: 'UI-ACCEPT-20261004 denial' },
    { 'If-Match': String(ownDeviceUser.version) },
  );
  const pair = await Promise.all(
    [0, 1].map((i) =>
      api(
        'if-match-race-' + i,
        'CustomerAdmin',
        'PATCH',
        path,
        [200, 409],
        { displayName: 'UI-ACCEPT-20261004 race ' + i, reason: 'UI-ACCEPT-20261004 own concurrency probe' },
        { 'If-Match': String(ownDeviceUser.version) },
      ),
    ),
  );
  check(
    'if-match-exactly-one-winner',
    pair.filter((x) => x.status === 200).length === 1 && pair.filter((x) => x.status === 409).length === 1,
  );
  const after = await api('if-match-readback', 'CustomerAdmin', 'GET', path, [200]);
  check('if-match-version-incremented-once', after.data?.version === ownDeviceUser.version + 1);
  const reads = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      api('bounded-concurrent-read-' + i, 'CustomerAdmin', 'GET', '/admin/sites/' + siteA.id, [200]),
    ),
  );
  check(
    'bounded-eight-read-consistency',
    reads.every((x) => x.data?.id === siteA.id && x.data?.customerId === siteA.customerId),
  );
  r.loadTestClaim = 'Eight concurrent authenticated reads only; not sustained capacity/SLO acceptance';
} catch (error) {
  r.failure = { name: error.name, code: error.code ?? error.message };
} finally {
  if (ownDeviceUser?.deviceUserId) {
    try {
      const path = '/admin/device-users/' + ownDeviceUser.deviceUserId;
      const current = await api('cleanup-device-user-read', 'CustomerAdmin', 'GET', path, [200]);
      const disabled = await api(
        'cleanup-device-user-disable',
        'CustomerAdmin',
        'POST',
        path + '/disable',
        [200],
        { reason: 'UI-ACCEPT-20261004 cleanup own temporary fixture' },
        { 'If-Match': String(current.data.version) },
      );
      r.cleanup.push({
        kind: 'device-user',
        id: ownDeviceUser.deviceUserId,
        result: disabled.data?.status === 'DISABLED' ? 'PASS' : 'FAIL',
      });
    } catch (error) {
      r.cleanup.push({ kind: 'device-user', result: 'FAIL', code: error.name });
    }
  }
  cognito.destroy();
  r.finishedAt = new Date().toISOString();
  r.status =
    !r.failure &&
    r.requests.every((x) => x.result === 'PASS') &&
    r.assertions.every((x) => x.result === 'PASS') &&
    r.cleanup.every((x) => x.result === 'PASS')
      ? 'PASS_SCOPED_API_ONLY'
      : 'FAIL';
  r.identityCleanup = 'PENDING_UI_DISABLE_AFTER_BROWSER_CHECKS';
  save();
  console.log(
    JSON.stringify({
      status: r.status,
      requests: r.requests.length,
      assertions: r.assertions.length,
      failure: r.failure,
    }),
  );
}
process.exitCode = r.status === 'PASS_SCOPED_API_ONLY' ? 0 : 1;
