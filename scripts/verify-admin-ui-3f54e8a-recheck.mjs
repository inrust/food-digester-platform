/** Historical, narrowly scoped real-target collector. Never reuse disabled fixtures or stored tokens. */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';

const folder = 'docs/audit/evidence/admin-ui-3f54e8a-recheck-2026-10-04/';
const ledgerPath = folder + 'owned-fixture-ledger.json';
const privatePath = '/tmp/fdp-3f54e8a-recheck-private-logins.json';
const output = folder + 'session-and-viewer-recheck.json';
const sourceCommit = '3f54e8a18314c90a366d2d919c11f33faf1e209b';
const customerId = '812d9906-9b86-4c52-81fd-b1ad491181d9';
const foreignCustomerId = '88a40e32-7c0a-4eeb-8524-d7cc5756f8f2';
const siteId = 'de61e0ee-d5db-4ab8-ae72-698673c16a1b';
const foreignSiteId = '64bc8039-7a09-4498-bfb4-f37d944a716e';
const prefix = 'UI-RECHECK-3F54E8A-20261004';
const pool = 'ap-southeast-1_hZMX8LpFo';
const region = 'ap-southeast-1';
const base = 'https://api.bio-nexa.com/api/v1';
const expected = [
  ['ui-recheck-3f54e8a-admin@example.invalid', 'CustomerAdmin'],
  ['ui-recheck-3f54e8a-viewer@example.invalid', 'CustomerViewer'],
];
if (!process.stdin.isTTY) throw Error('INTERACTIVE_INPUT_REQUIRED_BEFORE_ANY_TARGET_CHANGE');
const resume = process.argv.includes('--resume-input-closure');
const prior = resume ? JSON.parse(readFileSync(folder + 'attempt-1-input-closed.json')) : null;
if (
  resume &&
  (prior.sourceCommit !== sourceCommit ||
    prior.status !== 'FAIL' ||
    prior.failure?.code !== 'EXPLICIT_PHASE_SIGNAL_REQUIRED' ||
    !prior.privateLoginFileRemoved ||
    prior.assertions.some((x) => x.result !== 'PASS') ||
    prior.requests.some(
      (x) =>
        x.result !== 'PASS' && !(x.tokenKind === 'accessToken' && x.status === 401 && x.id.endsWith(':active-read')),
    ) ||
    prior.cleanup.length !== 0 ||
    !prior.deviceUser?.id)
)
  throw Error('EXACT_INPUT_CLOSURE_RESUME_REQUIRED');
const ledger = JSON.parse(readFileSync(ledgerPath));
const version = JSON.parse(readFileSync(folder + 'application-version.json'));
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
if (head.status !== 0 || head.stdout.trim() !== sourceCommit) throw Error('EXACT_SOURCE_COMMIT_REQUIRED');
if (version.gate !== 'PASS' || version.sourceCommit !== sourceCommit || version.accountId !== '065986019555')
  throw Error('DEPLOYED_VERSION_PASS_REQUIRED');
if (
  ledger.sourceCommit !== sourceCommit ||
  ledger.environment !== 'fdp-test-app' ||
  ledger.prefix !== prefix ||
  ledger.accounts.length !== 2 ||
  existsSync(privatePath) ||
  existsSync(output) ||
  !expected.every(([username, role]) =>
    ledger.accounts.some(
      (x) => x.username === username && x.role === role && x.customerId === customerId && x.cleanup === 'PENDING',
    ),
  ) ||
  ![customerId, foreignCustomerId, siteId, foreignSiteId].every((id) =>
    ledger.created.some((x) => x.id === id && x.cleanup === 'PENDING'),
  )
)
  throw Error('FRESH_OWN_FIXTURE_SCOPE_REQUIRED');

function aws(args) {
  const p = spawnSync('aws', args, { encoding: 'utf8', timeout: 30000 });
  if (p.status !== 0) throw Error('AWS_UNAVAILABLE');
  return JSON.parse(p.stdout);
}
if (aws(['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--output', 'json']).Account !== '065986019555')
  throw Error('WRONG_AWS_ACCOUNT');
const creds = aws(['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process']);
const cognito = new sdk.CognitoIdentityProviderClient({
  region,
  maxAttempts: 1,
  credentials: {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  },
});
const call = (Command, args) =>
  cognito.send(new Command({ UserPoolId: pool, ...args }), { abortSignal: AbortSignal.timeout(30000) });
const digest = (x) => createHash('sha256').update(x).digest('hex');
const r = {
  schemaVersion: '1.0',
  sourceCommit,
  executorSha256: digest(readFileSync(new URL(import.meta.url))),
  applicationVersionReceiptSha256: digest(readFileSync(folder + 'application-version.json')),
  environment: 'fdp-test-app',
  scope: 'H01_BUSINESS_DISABLE_OLD_ID_TOKEN_M01_OWN_NONEMPTY_VIEWER_READ_ONLY',
  accessTokenScope: 'REST_GATEWAY_REJECTION_BEFORE_AND_AFTER_DISABLE_NOT_REVOCATION_PROOF',
  resumedFrom: resume ? 'attempt-1-input-closed.json' : null,
  accountId: '065986019555',
  region,
  startedAt: new Date().toISOString(),
  status: 'RUNNING',
  productionAccepted: false,
  fullAdminTargetAccepted: false,
  sustainedConcurrencyAccepted: false,
  identities: [],
  requests: [],
  assertions: [],
  cleanup: [],
  credentialsInRepository: false,
};
const sessions = new Map(),
  logins = [],
  flows = new Map();
const stdin = createInterface({ input: process.stdin });
const lines = stdin[Symbol.asyncIterator]();
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
const saveLedger = () => writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
function check(id, ok, detail = {}, fatal = false) {
  r.assertions.push({ id, result: ok ? 'PASS' : 'FAIL', ...detail });
  save();
  if (!ok && fatal) throw Error(id);
}
async function waitFor(expectedLine) {
  console.log('WAITING_' + expectedLine);
  const line = await lines.next();
  if (line.done || line.value.trim() !== expectedLine) throw Error('EXPLICIT_PHASE_SIGNAL_REQUIRED');
}
async function api(id, role, method, path, expectedStatuses, body, headers = {}, tokenKind = 'idToken') {
  const token = sessions.get(role)[tokenKind];
  const start = performance.now();
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const row = {
    id,
    role,
    tokenKind,
    method,
    path,
    status: response.status,
    expectedStatuses,
    errorCode: parsed?.error?.code ?? null,
    requestId: response.headers.get('x-amzn-requestid') ?? parsed?.meta?.requestId ?? parsed?.error?.requestId,
    latencyMs: Math.round(performance.now() - start),
    result: expectedStatuses.includes(response.status) ? 'PASS' : 'FAIL',
  };
  r.requests.push(row);
  check(id + ':no-secret-fields', !/"(?:password|passwordHash|accessToken|idToken|refreshToken)"\s*:/i.test(text));
  if (method === 'POST' && path === '/admin/device-users' && parsed?.data?.deviceUserId) {
    const data = parsed.data;
    check(
      id + ':created-owned-binding',
      data.customerId === customerId && data.username.startsWith('ui-recheck-3f54e8a-'),
      {},
      true,
    );
    ledger.created.push({
      kind: 'device-user',
      id: data.deviceUserId,
      customerId,
      name: data.username,
      cleanup: 'PENDING',
    });
    saveLedger();
  }
  save();
  return { status: response.status, data: parsed?.data, row };
}
const createBody = (suffix) => ({
  customerId,
  username: 'ui-recheck-3f54e8a-' + suffix,
  displayName: prefix + '-' + suffix,
  password: 'A!z9' + randomBytes(24).toString('base64url'),
  reason: prefix + ' isolated acceptance fixture',
});
const ownBinding = (data) => data?.customerId === customerId;
let deviceUser;
save();
try {
  // Inspect both freshly invited identities before changing either test credential. Never broaden a grant.
  for (const [username, role] of expected) {
    const user = await call(sdk.AdminGetUserCommand, { Username: username });
    const groups = await call(sdk.AdminListGroupsForUserCommand, { Username: username });
    check(
      role + ':fresh-existing-grant',
      user.Enabled &&
        user.UserStatus === (resume ? 'CONFIRMED' : 'FORCE_CHANGE_PASSWORD') &&
        new Date(user.UserCreateDate).toISOString().slice(0, 10) === '2026-10-04' &&
        user.UserAttributes.find((a) => a.Name === 'custom:customer_id')?.Value === customerId &&
        groups.Groups.length === 1 &&
        groups.Groups[0].GroupName === role,
      {},
      true,
    );
    const sub = user.UserAttributes.find((a) => a.Name === 'sub')?.Value;
    if (resume && prior.identities.find((x) => x.role === role)?.sub !== sub) throw Error('RESUME_IDENTITY_CHANGED');
    r.identities.push({ username, role, customerId, sub, tokens: {} });
    ledger.accounts.find((x) => x.username === username).id = sub;
    saveLedger();
    save();
  }
  for (const [username, role] of expected) {
    const password = 'A!z9' + randomBytes(24).toString('base64url');
    await call(sdk.AdminSetUserPasswordCommand, { Username: username, Password: password, Permanent: true });
    const flow = new AuthFlow({
      idp: createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
      userPoolId: pool,
      sessionManager: { establish() {} },
    });
    const auth = await flow.login(username, password);
    check(role + ':real-srp-authenticated', auth.status === 'authenticated', {}, true);
    sessions.set(role, auth.session);
    flows.set(role, flow);
    logins.push({ username, role, password });
    const identity = r.identities.find((x) => x.role === role);
    for (const tokenKind of ['idToken', 'accessToken']) {
      const token = auth.session[tokenKind],
        claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
      check(
        role + ':' + tokenKind + ':issuer-role-sub',
        claims.iss === `https://cognito-idp.${region}.amazonaws.com/${pool}` &&
          claims.sub === identity.sub &&
          claims.token_use === (tokenKind === 'idToken' ? 'id' : 'access') &&
          claims['cognito:groups']?.length === 1 &&
          claims['cognito:groups'][0] === role,
        {},
        true,
      );
      if (tokenKind === 'idToken')
        check(role + ':customer-claim', claims['custom:customer_id'] === customerId, {}, true);
      identity.tokens[tokenKind] = {
        sha256: digest(token),
        issuedAt: new Date(claims.iat * 1000).toISOString(),
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      };
      await api(
        role + ':' + tokenKind + ':active-read',
        role,
        'GET',
        '/admin/sites/' + siteId,
        tokenKind === 'idToken' ? [200] : [401],
        undefined,
        {},
        tokenKind,
      );
      if (tokenKind === 'accessToken')
        await api(
          role + ':accessToken:active-write-rejected-by-gateway',
          role,
          'POST',
          '/admin/device-users',
          [401],
          createBody('access-baseline-' + role.toLowerCase()),
          {},
          tokenKind,
        );
    }
  }
  writeFileSync(privatePath, JSON.stringify(logins), { mode: 0o600, flag: 'wx' });
  for (const [, role] of expected) {
    const own = await api(role + ':own-site', role, 'GET', '/admin/sites/' + siteId, [200]);
    check(role + ':own-site-binding', ownBinding(own.data) && own.data?.id === siteId, {}, true);
    await api(role + ':foreign-site', role, 'GET', '/admin/sites/' + foreignSiteId, [403, 404]);
    const foreign = await api(
      role + ':foreign-customer-filter',
      role,
      'GET',
      '/admin/sites?customerId=' + foreignCustomerId,
      [200, 403, 404],
    );
    check(
      role + ':foreign-filter-no-leak',
      foreign.status !== 200 || (Array.isArray(foreign.data) && foreign.data.every(ownBinding)),
    );
  }
  const created = resume
    ? await api(
        'admin-resume-owned-device-user',
        'CustomerAdmin',
        'GET',
        '/admin/device-users/' + prior.deviceUser.id,
        [200],
      )
    : await api(
        'admin-write-baseline',
        'CustomerAdmin',
        'POST',
        '/admin/device-users',
        [201],
        createBody('readonly-fixture'),
      );
  deviceUser = created.data;
  check(
    'admin-created-own-device-user',
    created.status === (resume ? 200 : 201) &&
      ownBinding(deviceUser) &&
      !!deviceUser.deviceUserId &&
      deviceUser.username === 'ui-recheck-3f54e8a-readonly-fixture' &&
      deviceUser.status === 'ACTIVE' &&
      (!resume || deviceUser.version === prior.deviceUser.version),
    {},
    true,
  );
  r.deviceUser = {
    id: deviceUser.deviceUserId,
    customerId,
    username: deviceUser.username,
    version: deviceUser.version,
  };
  save();
  const path = '/admin/device-users/' + deviceUser.deviceUserId;
  const list = await api('viewer-nonempty-list', 'CustomerViewer', 'GET', '/admin/device-users', [200]);
  check(
    'viewer-own-list-binding',
    Array.isArray(list.data) &&
      list.data.some((x) => x.deviceUserId === deviceUser.deviceUserId) &&
      list.data.every(ownBinding),
  );
  const detail = await api('viewer-own-detail', 'CustomerViewer', 'GET', path, [200]);
  check('viewer-own-detail-binding', detail.data?.deviceUserId === deviceUser.deviceUserId && ownBinding(detail.data));
  const denialHeaders = { 'If-Match': String(deviceUser.version) };
  await api(
    'viewer-create-denied',
    'CustomerViewer',
    'POST',
    '/admin/device-users',
    [403],
    createBody('viewer-denied'),
  );
  await api(
    'viewer-edit-denied',
    'CustomerViewer',
    'PATCH',
    path,
    [403],
    { displayName: prefix + '-must-not-persist', reason: prefix },
    denialHeaders,
  );
  await api(
    'viewer-password-rotation-denied',
    'CustomerViewer',
    'PATCH',
    path,
    [403],
    { password: 'A!z9' + randomBytes(24).toString('base64url'), reason: prefix },
    denialHeaders,
  );
  await api(
    'viewer-disable-denied',
    'CustomerViewer',
    'POST',
    path + '/disable',
    [403],
    { reason: prefix },
    denialHeaders,
  );
  // A random nonexistent UUID avoids touching any real device; permission must reject before business lookup.
  for (const action of ['assignments', 'assignments/revoke'])
    await api(
      'viewer-' + action + '-denied',
      'CustomerViewer',
      'POST',
      path + '/' + action,
      [403],
      { deviceIds: ['00000000-0000-4000-8000-000000000000'], reason: prefix },
      denialHeaders,
    );
  const readback = await api('admin-after-viewer-denials', 'CustomerAdmin', 'GET', path, [200]);
  check(
    'viewer-denials-no-mutation',
    readback.data?.version === deviceUser.version &&
      readback.data?.displayName === deviceUser.displayName &&
      readback.data?.status === deviceUser.status,
  );
  await waitFor('VIEWER_BROWSER_CHECKED');
  const browser = JSON.parse(readFileSync(folder + 'viewer-browser.json'));
  check(
    'viewer-real-browser-pass',
    browser.sourceCommit === sourceCommit &&
      browser.deviceUserId === deviceUser.deviceUserId &&
      browser.status === 'PASS',
    {},
    true,
  );
  const disabled = await api(
    'cleanup-device-user-disable',
    'CustomerAdmin',
    'POST',
    path + '/disable',
    [200],
    { reason: prefix + ' cleanup' },
    denialHeaders,
  );
  check('cleanup-device-user-disabled', disabled.data?.status === 'DISABLED', {}, true);
  ledger.created.find((x) => x.id === deviceUser.deviceUserId).cleanup = 'PASS_DISABLED';
  saveLedger();
  r.cleanup.push({ kind: 'device-user', id: deviceUser.deviceUserId, result: 'PASS_DISABLED' });
  save();
  for (const [username, role] of expected) {
    await waitFor(role + '_BUSINESS_DISABLED');
    const user = await call(sdk.AdminGetUserCommand, { Username: username });
    check(role + ':cognito-disabled-after-ui', user.Enabled === false, {}, true);
    const identity = r.identities.find((x) => x.role === role);
    for (const tokenKind of ['idToken', 'accessToken']) {
      const token = sessions.get(role)[tokenKind],
        receipt = identity.tokens[tokenKind];
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
      check(
        role + ':' + tokenKind + ':same-unexpired-old-token',
        digest(token) === receipt.sha256 && claims.exp * 1000 > Date.now(),
        { checkedAt: new Date().toISOString() },
        true,
      );
      for (const method of ['GET', 'POST']) {
        const response = await api(
          role + ':' + tokenKind + ':disabled-' + method,
          role,
          method,
          method === 'GET' ? '/admin/sites/' + siteId : '/admin/device-users',
          [401],
          method === 'POST' ? createBody('disabled-' + role.toLowerCase() + '-' + tokenKind.toLowerCase()) : undefined,
          {},
          tokenKind,
        );
        check(
          role + ':' + tokenKind + ':' + method + ':authentication-denied',
          tokenKind === 'idToken' ? response.row.errorCode === 'UNAUTHENTICATED' : response.status === 401,
        );
      }
    }
    if (role === 'CustomerAdmin')
      await api('unaffected-viewer-control', 'CustomerViewer', 'GET', '/admin/sites/' + siteId, [200]);
    let loginDenied = false;
    try {
      const auth = await flows.get(role).login(username, logins.find((x) => x.role === role).password);
      loginDenied = auth.status !== 'authenticated';
    } catch (error) {
      loginDenied = error.code === 'INVALID_CREDENTIALS';
      identity.newLoginErrorCode = error.code ?? error.name;
    }
    check(role + ':new-login-denied', loginDenied);
    ledger.accounts.find((x) => x.username === username).cleanup = 'PASS_DISABLED';
    saveLedger();
    r.cleanup.push({ kind: 'account', username, result: 'PASS_DISABLED' });
    save();
  }
} catch (error) {
  r.failure = { name: error.name, code: error.code ?? error.message };
} finally {
  stdin.close();
  cognito.destroy();
  sessions.clear();
  flows.clear();
  logins.length = 0;
  if (existsSync(privatePath)) unlinkSync(privatePath);
  r.privateLoginFileRemoved = !existsSync(privatePath);
  r.finishedAt = new Date().toISOString();
  r.status =
    !r.failure &&
    r.privateLoginFileRemoved &&
    r.requests.every((x) => x.result === 'PASS' && !!x.requestId) &&
    r.assertions.every((x) => x.result === 'PASS') &&
    r.cleanup.length === 3 &&
    r.cleanup.every((x) => x.result === 'PASS_DISABLED')
      ? 'PASS_SCOPED_H01_M01'
      : 'FAIL';
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
process.exitCode = r.status === 'PASS_SCOPED_H01_M01' ? 0 : 1;
