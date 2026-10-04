/** Historical real-target execution: fresh confirmed fixtures only; never replay disabled accounts. */
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { hasPermission } from '../packages/auth/src/permissions.ts';
import { APP_ROUTES } from '../apps/admin-web/src/router/routes.ts';

const folder = 'docs/audit/evidence/admin-ui-811a895-formal-2026-10-04/';
const privatePath = '/tmp/fdp-811a895-formal-private-logins.json';
const commit = '811a8959477d7b2608f2562b5d221f8b40370944';
const prefix = 'UI-FORMAL-811A895-20261004-R2';
const pool = 'ap-southeast-1_hZMX8LpFo',
  region = 'ap-southeast-1';
const base = 'https://api.bio-nexa.com/api/v1/admin';
const ledger = JSON.parse(readFileSync(folder + 'owned-fixture-ledger.json'));
const version = JSON.parse(readFileSync(folder + 'application-version.json'));
const digest = (b) => createHash('sha256').update(b).digest('hex');
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
if (!process.stdin.isTTY || head !== commit || existsSync(privatePath) || existsSync(folder + 'real-business.json'))
  throw Error('FRESH_INTERACTIVE_EXACT_SOURCE_REQUIRED');
if (
  version.sourceCommit !== commit ||
  version.gate !== 'PASS' ||
  ledger.sourceCommit !== commit ||
  ledger.prefix !== prefix ||
  ledger.accounts.length !== 5 ||
  ledger.customers.length !== 2 ||
  ledger.accounts.some((x) => x.cleanup !== 'PENDING') ||
  ledger.created.length
)
  throw Error('DEPLOYMENT_AND_FRESH_OWN_FIXTURES_REQUIRED');
function aws(args) {
  const p = spawnSync('aws', args, { encoding: 'utf8', timeout: 30000 });
  if (p.status !== 0) throw Error('AWS_UNAVAILABLE');
  return JSON.parse(p.stdout);
}
if (aws(['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--output', 'json']).Account !== '065986019555')
  throw Error('WRONG_ACCOUNT');
const c = aws(['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process']);
const cognito = new sdk.CognitoIdentityProviderClient({
  region,
  maxAttempts: 1,
  credentials: {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
  },
});
const call = (Cmd, input) =>
  cognito.send(new Cmd({ UserPoolId: pool, ...input }), { abortSignal: AbortSignal.timeout(30000) });
const sessions = new Map(),
  logins = [];
const r = {
  schemaVersion: '1.0',
  sourceCommit: commit,
  scope: 'FIVE_ROLES_TWO_CUSTOMER_NONEMPTY_SITE_DEVICE_USER_CONTRACT',
  environment: 'fdp-test-app',
  apiBase: base,
  startedAt: new Date().toISOString(),
  status: 'RUNNING',
  productionAccepted: false,
  fullAdminTargetAccepted: false,
  mockedRequestCount: 0,
  executorSha256: digest(readFileSync(new URL(import.meta.url))),
  applicationVersionReceiptSha256: digest(readFileSync(folder + 'application-version.json')),
  identities: [],
  requests: [],
  assertions: [],
  cleanup: [],
  uiRouteMatrix: APP_ROUTES.filter((x) => !x.public).map((x) => ({
    path: x.path,
    roles: x.roles,
    menu: x.menuGroup !== null,
  })),
};
const save = () => writeFileSync(folder + 'real-business.json', JSON.stringify(r, null, 2) + '\n');
const saveLedger = () => writeFileSync(folder + 'owned-fixture-ledger.json', JSON.stringify(ledger, null, 2) + '\n');
function check(id, ok, detail = {}) {
  r.assertions.push({ id, result: ok ? 'PASS' : 'FAIL', ...detail });
  save();
  if (!ok) throw Error(id);
}
async function api(id, role, method, path, expected, body, headers = {}) {
  const token = sessions.get(role)?.idToken;
  if (!token) throw Error('AUTHENTICATED_ID_TOKEN_REQUIRED');
  if (id.includes(':old-token-')) {
    const identity = r.identities.find((x) => x.role === role);
    check(
      id + ':same-unexpired-token',
      digest(token) === identity.tokenSha256 && identity.expiresAt > Math.floor(Date.now() / 1000),
    );
  }
  const start = performance.now(),
    startedAt = new Date().toISOString();
  const response = await fetch(base + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25000),
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
    method,
    path,
    status: response.status,
    expected,
    startedAt,
    latencyMs: Math.round(performance.now() - start),
    requestId: parsed?.meta?.requestId ?? parsed?.error?.requestId ?? response.headers.get('x-amzn-requestid'),
    errorCode: parsed?.error?.code ?? null,
    result: expected.includes(response.status) ? 'PASS' : 'FAIL',
    ...(id.includes(':old-token-')
      ? { tokenSha256: digest(token), tokenExpiresAt: r.identities.find((x) => x.role === role).expiresAt }
      : {}),
  };
  r.requests.push(row);
  save();
  check(id + ':redacted', !/"(?:password|passwordHash|accessToken|idToken|refreshToken)"\s*:/i.test(text));
  // Save all returned IDs immediately so an assertion failure cannot orphan a successful creation.
  if (method === 'POST' && response.status === 201 && ['/sites', '/device-users', '/contracts'].includes(path)) {
    const d = parsed?.data,
      item = {
        kind: path.slice(1),
        id: d?.id ?? d?.deviceUserId ?? d?.contractId,
        customerId: d?.customerId,
        name: d?.name ?? d?.username,
        version: d?.version,
        cleanup: 'PENDING',
      };
    ledger.created.push(item);
    saveLedger();
    check(
      id + ':owned',
      !!item.id &&
        ledger.customers.some((x) => x.id === item.customerId) &&
        (item.name?.startsWith(prefix) || item.name?.startsWith('ui-formal-811a895-')),
    );
  }
  check(id + ':status', row.result === 'PASS', { status: row.status });
  if (id.includes(':old-token-') && id.endsWith('-denied'))
    check(id + ':unauthenticated', row.errorCode === 'UNAUTHENTICATED');
  return { status: response.status, data: parsed?.data };
}
const stdin = createInterface({ input: process.stdin }),
  lines = stdin[Symbol.asyncIterator]();
async function wait(line) {
  console.log('WAITING_' + line);
  const next = await lines.next();
  if (next.done || next.value !== line) throw Error('EXPLICIT_PHASE_SIGNAL_REQUIRED');
}
const root = 'PlatformSuperAdmin';
let rootDisabled = false;
save();
try {
  for (const account of ledger.accounts) {
    check(
      account.role + ':own-identity',
      /^ui-formal-811a895-r2-(superadmin|operator|auditor|admin|viewer)@example\.invalid$/.test(account.username),
    );
    const user = await call(sdk.AdminGetUserCommand, { Username: account.username });
    const groups = await call(sdk.AdminListGroupsForUserCommand, { Username: account.username });
    check(
      account.role + ':fresh-grant',
      user.Enabled &&
        user.UserStatus === 'FORCE_CHANGE_PASSWORD' &&
        user.UserCreateDate.toISOString().slice(0, 10) === '2026-10-04' &&
        groups.Groups.length === 1 &&
        groups.Groups[0].GroupName === account.role &&
        (user.UserAttributes.find((x) => x.Name === 'custom:customer_id')?.Value ?? null) === account.customerId,
    );
    const password = 'A!z9' + randomBytes(24).toString('base64url');
    await call(sdk.AdminSetUserPasswordCommand, { Username: account.username, Password: password, Permanent: true });
    const flow = new AuthFlow({
      idp: createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
      userPoolId: pool,
      sessionManager: { establish() {} },
    });
    const auth = await flow.login(account.username, password);
    check(account.role + ':real-srp', auth.status === 'authenticated');
    const claims = JSON.parse(Buffer.from(auth.session.idToken.split('.')[1], 'base64url'));
    check(
      account.role + ':claims',
      claims.iss === `https://cognito-idp.${region}.amazonaws.com/${pool}` &&
        claims.token_use === 'id' &&
        claims['cognito:groups']?.length === 1 &&
        claims['cognito:groups'][0] === account.role &&
        (claims['custom:customer_id'] ?? null) === account.customerId,
    );
    sessions.set(account.role, auth.session);
    logins.push({ ...account, password });
    r.identities.push({
      username: account.username,
      role: account.role,
      customerId: account.customerId,
      sub: claims.sub,
      tokenSha256: digest(auth.session.idToken),
      issuedAt: claims.iat,
      expiresAt: claims.exp,
    });
    save();
  }
  const users = await api('five-business-identities', root, 'GET', '/users?q=ui-formal-811a895-r2-', [200]);
  check('five-business-identities:exact', users.data.length === 5);
  for (const a of ledger.accounts) {
    const u = users.data.find((x) => x.email === a.username);
    check(a.role + ':business-grant', u?.roles.length === 1 && u.roles[0] === a.role && u.customerId === a.customerId);
    a.id = u.userId;
  }
  saveLedger();
  writeFileSync(privatePath, JSON.stringify(logins), { mode: 0o600, flag: 'wx' });
  for (const customer of ledger.customers) {
    const own = await api('customer-binding-' + customer.id, root, 'GET', '/customers/' + customer.id, [200]);
    check('customer-owned-' + customer.id, own.data.name === customer.name && own.data.status === 'ACTIVE');
    await api('site-create-' + customer.id, 'PlatformOperator', 'POST', '/sites', [201], {
      customerId: customer.id,
      name: prefix + '-site-' + customer.name.slice(-1),
      timezone: 'Asia/Shanghai',
    });
  }
  const duBody = (i) => ({
    customerId: ledger.customers[i].id,
    username: 'ui-formal-811a895-r2-device-user-' + (i ? 'b' : 'a'),
    displayName: prefix + '-DeviceUser-' + (i ? 'B' : 'A'),
    password: 'A!z9' + randomBytes(24).toString('base64url'),
    reason: prefix,
  });
  const duplicate = duBody(0);
  const race = await Promise.all([
    api('duplicate-create-a', 'CustomerAdmin', 'POST', '/device-users', [201, 409], duplicate),
    api('duplicate-create-b', 'CustomerAdmin', 'POST', '/device-users', [201, 409], duplicate),
  ]);
  check(
    'duplicate-create-one-mutation',
    race
      .map((x) => x.status)
      .sort()
      .join(',') === '201,409',
  );
  await api('device-user-create-b', root, 'POST', '/device-users', [201], duBody(1));
  const dus = ledger.created.filter((x) => x.kind === 'device-users');
  const sites = ledger.created.filter((x) => x.kind === 'sites');
  for (const [i, customer] of ledger.customers.entries()) {
    await api('contract-create-' + i, root, 'POST', '/contracts', [201], {
      contractNumber: prefix + '-' + i,
      name: prefix + '-Contract-' + i,
      customerId: customer.id,
      startAt: new Date(Date.now() - 86400000).toISOString(),
      endAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    });
  }
  const reads = [
    ['customers', 'customer:read', '/customers'],
    ['sites', 'site:read', '/sites'],
    ['devices', 'device:read', '/devices'],
    ['contracts', 'contract:read', '/contracts'],
    ['licenses', 'license:read', '/licenses'],
    ['configurations', 'config:read', '/configurations'],
    ['device-users', 'device-user:read', '/device-users'],
    ['alarms', 'alarm:read', '/alarms'],
    ['dashboard', 'dashboard:read', '/dashboard/overview'],
    ['audit', 'audit:read', '/audit-logs'],
    ['users', 'user:read', '/users?q=ui-formal-811a895-r2-'],
    ['settings', 'settings:read', '/settings'],
    ['reports', 'report:read', '/esg/reports'],
  ];
  for (const a of ledger.accounts) {
    for (const [name, permission, path] of reads)
      await api(a.role + ':read:' + name, a.role, 'GET', path, [hasPermission(a.role, permission) ? 200 : 403]);
    for (const [i, customer] of ledger.customers.entries()) {
      const owned = !a.customerId || a.customerId === customer.id;
      await api(a.role + ':site:' + i, a.role, 'GET', '/sites/' + sites[i].id, [owned ? 200 : 403]);
      if (hasPermission(a.role, 'device-user:read')) {
        await api(
          a.role + ':device-user-detail:' + i,
          a.role,
          'GET',
          '/device-users/' + dus.find((x) => x.customerId === customer.id).id,
          [owned ? 200 : 404],
        );
        const list = await api(
          a.role + ':device-user-filter:' + i,
          a.role,
          'GET',
          '/device-users?customerId=' + customer.id + '&keyword=ui-formal-811a895-r2-',
          [200],
        );
        const effectiveCustomer = a.customerId ?? customer.id;
        const expectedDeviceUser = dus.find((x) => x.customerId === effectiveCustomer);
        check(
          a.role + ':nonempty-binding:' + i,
          Array.isArray(list.data) &&
            list.data.length === 1 &&
            list.data[0].customerId === effectiveCustomer &&
            list.data[0].deviceUserId === expectedDeviceUser.id,
          {
            requestedCustomerId: customer.id,
            effectiveCustomerId: effectiveCustomer,
            returnedIds: Array.isArray(list.data) ? list.data.map((x) => x.deviceUserId) : [],
            returnedCustomerIds: Array.isArray(list.data) ? list.data.map((x) => x.customerId) : [],
          },
        );
      }
    }
    if (!hasPermission(a.role, 'device-user:write'))
      await api(
        a.role + ':device-user-write-denied',
        a.role,
        'POST',
        '/device-users',
        [403],
        duBody(a.customerId === ledger.customers[1].id ? 1 : 0),
      );
    if (!hasPermission(a.role, 'contract:write'))
      await api(a.role + ':contract-write-denied', a.role, 'POST', '/contracts', [403], {
        contractNumber: prefix + '-forbidden',
        name: prefix,
        customerId: ledger.customers[0].id,
        startAt: new Date().toISOString(),
        endAt: new Date(Date.now() + 86400000).toISOString(),
      });
  }
  const a = dus.find((x) => x.customerId === ledger.customers[0].id),
    b = dus.find((x) => x.customerId === ledger.customers[1].id);
  const arace = await Promise.all(
    ['a', 'b'].map((x) =>
      api(
        'device-user-if-match-' + x,
        'CustomerAdmin',
        'PATCH',
        '/device-users/' + a.id,
        [200, 409],
        { displayName: prefix + '-concurrent-' + x, reason: prefix },
        { 'If-Match': String(a.version) },
      ),
    ),
  );
  check(
    'device-user-if-match-one-success-one-conflict',
    arace
      .map((x) => x.status)
      .sort()
      .join(',') === '200,409',
  );
  await api(
    'admin-cross-customer-write-denied',
    'CustomerAdmin',
    'PATCH',
    '/device-users/' + b.id,
    [403, 404],
    { displayName: prefix + '-forbidden', reason: prefix },
    { 'If-Match': String(b.version) },
  );
  for (const [method, suffix, body] of [
    ['PATCH', '', { displayName: prefix + '-forbidden', reason: prefix }],
    ['PATCH', '', { password: 'A!z9' + randomBytes(24).toString('base64url'), reason: prefix }],
    ['POST', '/disable', { reason: prefix }],
    ['POST', '/assignments', { deviceIds: ['00000000-0000-4000-8000-000000000000'], reason: prefix }],
    ['POST', '/assignments/revoke', { deviceIds: ['00000000-0000-4000-8000-000000000000'], reason: prefix }],
  ])
    await api(
      'viewer-write-denied-' + r.requests.length,
      'CustomerViewer',
      method,
      '/device-users/' + b.id + suffix,
      [403],
      body,
      { 'If-Match': String(b.version) },
    );
  const before = await api('viewer-denials-readback', root, 'GET', '/device-users/' + b.id, [200]);
  check('viewer-denials-no-mutation', before.data.version === b.version && before.data.status === 'ACTIVE');
  console.log('REAL_API_SCENARIOS_COMPLETE');
  await wait('BROWSERS_CHECKED');
  const browserReceipt = JSON.parse(readFileSync(folder + 'browsers.json'));
  check(
    'browser-scoped-complete',
    browserReceipt.sourceCommit === commit &&
      browserReceipt.status === 'PASS_SCOPED_THREE_VENDOR_BROWSERS' &&
      browserReceipt.cases.length === 15 &&
      browserReceipt.cases.every((x) => x.status === 'PASS'),
  );
  r.browserReceiptSha256 = digest(readFileSync(folder + 'browsers.json'));
  // Prove the same captured ID Tokens still read successfully after browser logout,
  // immediately before business disable, so logout cannot explain the later 401s.
  for (const account of ledger.accounts) {
    const site = ledger.created.find(
      (x) => x.kind === 'sites' && (!account.customerId || x.customerId === account.customerId),
    );
    await api(account.role + ':old-token-before-disable', account.role, 'GET', '/sites/' + site.id, [200]);
  }
  r.scenariosCompleted = true;
} catch (error) {
  r.failure = { code: /^[A-Za-z0-9:_-]+$/.test(error.message) ? error.message : 'EXECUTION_FAILED' };
  r.status = 'FAIL';
  save();
} finally {
  for (const record of [...ledger.created].reverse()) {
    try {
      const path = '/' + record.kind + '/' + record.id;
      const found = await api('cleanup-read-' + record.id, root, 'GET', path, [200]);
      check(
        'cleanup-own-' + record.id,
        ledger.customers.some((x) => x.id === found.data.customerId) &&
          (found.data.name?.startsWith(prefix) || found.data.username?.startsWith('ui-formal-811a895-')),
      );
      const suffix =
        record.kind === 'device-users' ? '/disable' : record.kind === 'contracts' ? '/terminate' : '/deactivate';
      const changed = await api(
        'cleanup-change-' + record.id,
        root,
        'POST',
        path + suffix,
        [200],
        { reason: prefix + ' cleanup' },
        { 'If-Match': String(found.data.version) },
      );
      const expected =
        record.kind === 'device-users' ? 'DISABLED' : record.kind === 'contracts' ? 'TERMINATED' : 'SUSPENDED';
      check('cleanup-status-' + record.id, changed.data.status === expected);
      record.cleanup = 'PASS_' + expected;
      r.cleanup.push({ kind: record.kind, id: record.id, result: record.cleanup });
      saveLedger();
      save();
    } catch {
      r.cleanup.push({ kind: record.kind, id: record.id, result: 'FAIL' });
      save();
    }
  }
  for (const customer of ledger.customers) {
    try {
      const found = await api('cleanup-customer-read-' + customer.id, root, 'GET', '/customers/' + customer.id, [200]);
      check('cleanup-customer-own-' + customer.id, found.data.name === customer.name);
      const changed = await api(
        'cleanup-customer-' + customer.id,
        root,
        'POST',
        '/customers/' + customer.id + '/deactivate',
        [200],
        { reason: prefix + ' cleanup' },
        { 'If-Match': String(found.data.version) },
      );
      check('cleanup-customer-status-' + customer.id, changed.data.status === 'SUSPENDED');
      customer.cleanup = 'PASS_SUSPENDED';
      r.cleanup.push({ kind: 'customer', id: customer.id, result: 'PASS_SUSPENDED' });
      saveLedger();
      save();
    } catch {
      r.cleanup.push({ kind: 'customer', id: customer.id, result: 'FAIL' });
      save();
    }
  }
  for (const a of ledger.accounts.filter((x) => x.role !== root)) {
    try {
      const disabled = await api('cleanup-user-' + a.role, root, 'POST', '/users/' + a.id + '/disable', [200]);
      check(a.role + ':business-disabled', disabled.data.status === 'DISABLED');
      await api(
        a.role + ':old-token-read-denied',
        a.role,
        'GET',
        '/sites/' +
          ledger.created.find((x) => x.kind === 'sites' && (!a.customerId || x.customerId === a.customerId)).id,
        [401],
      );
      await api(a.role + ':old-token-write-denied', a.role, 'POST', '/device-users', [401], {
        customerId: a.customerId ?? ledger.customers[0].id,
        username: 'ui-formal-811a895-after-disable',
        password: 'A!z9' + randomBytes(24).toString('base64url'),
      });
      const user = await call(sdk.AdminGetUserCommand, { Username: a.username });
      check(a.role + ':cognito-disabled', !user.Enabled);
      a.cleanup = 'PASS_DISABLED';
      r.cleanup.push({ kind: 'account', role: a.role, id: a.id, result: 'PASS_DISABLED' });
      saveLedger();
      save();
    } catch {
      r.cleanup.push({ kind: 'account', role: a.role, result: 'FAIL' });
      save();
    }
  }
  if (sessions.has(root)) {
    try {
      await wait('SUPERADMIN_BUSINESS_DISABLED');
      const a = ledger.accounts.find((x) => x.role === root);
      const user = await call(sdk.AdminGetUserCommand, { Username: a.username });
      check(root + ':cognito-disabled', !user.Enabled);
      await api(
        root + ':old-token-read-denied',
        root,
        'GET',
        '/sites/' + ledger.created.find((x) => x.kind === 'sites').id,
        [401],
      );
      await api(root + ':old-token-write-denied', root, 'POST', '/device-users', [401], {
        customerId: ledger.customers[0].id,
        username: 'ui-formal-811a895-after-disable',
        password: 'A!z9' + randomBytes(24).toString('base64url'),
      });
      a.cleanup = 'PASS_DISABLED';
      r.cleanup.push({ kind: 'account', role: root, id: a.id, result: 'PASS_DISABLED' });
      rootDisabled = true;
      saveLedger();
    } catch {
      r.cleanup.push({ kind: 'account', role: root, result: 'FAIL' });
    }
  }
  if (existsSync(privatePath)) unlinkSync(privatePath);
  r.privateLoginFileRemoved = !existsSync(privatePath);
  sessions.clear();
  logins.length = 0;
  cognito.destroy();
  stdin.close();
  r.finishedAt = new Date().toISOString();
  r.cleanupComplete = rootDisabled && r.cleanup.length === 13 && r.cleanup.every((x) => x.result.startsWith('PASS_'));
  r.status =
    r.scenariosCompleted && r.cleanupComplete && r.assertions.every((x) => x.result === 'PASS')
      ? 'PASS_SCOPED_FIVE_ROLE_CROSS_CUSTOMER'
      : 'FAIL';
  save();
  console.log(
    JSON.stringify({
      status: r.status,
      requests: r.requests.length,
      assertions: r.assertions.length,
      cleanup: r.cleanupComplete,
    }),
  );
}
process.exitCode = r.status.startsWith('PASS_') ? 0 : 1;
