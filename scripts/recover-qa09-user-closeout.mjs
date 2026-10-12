import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';

const pool = 'ap-southeast-1_hZMX8LpFo',
  clientId = '5ljdjsf9g563mc1vdc7vjdjm09',
  region = 'ap-southeast-1';
const host = 'https://api.bio-nexa.com';
const hash = (v) => createHash('sha256').update(v).digest('hex');
function demand(ok, code) {
  if (!ok) throw Error(code);
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function assertOwnedBusinessUser(prefix, expected, view) {
  if (
    !/^qa09-[a-f0-9]{16}$/.test(prefix) ||
    !new RegExp(
      '^' +
        prefix +
        '-h01-(?:platformsuperadmin|platformoperator|auditor|customeradmin|customerviewer)@example\\.invalid$',
    ).test(expected.email) ||
    !uuid.test(view?.userId ?? '') ||
    (expected.userId && view.userId !== expected.userId) ||
    view.email !== expected.email ||
    view.customerId !== expected.customerId ||
    view.roles?.length !== 1 ||
    view.roles[0] !== expected.role ||
    !['INVITED', 'ACTIVE', 'DISABLED'].includes(view.status)
  )
    throw Error('OWN_BUSINESS_USER_SCOPE_REQUIRED');
  return view.userId;
}
export function assertOwnedSessionSite(prefix, customer, site) {
  if (
    !/^qa09-[a-f0-9]{16}$/.test(prefix) ||
    !['a', 'b'].includes(customer?.suffix) ||
    customer.name !== prefix + '-' + customer.suffix ||
    !uuid.test(customer.id) ||
    !uuid.test(site?.id ?? '') ||
    site.customerId !== customer.id ||
    site.name !== prefix + '-site-' + customer.suffix
  )
    throw Error('OWN_SESSION_SITE_REQUIRED');
}

const [originalFile, output] = process.argv.slice(2);
if (!originalFile || !output || existsSync(output) || existsSync(output + '.sources.json'))
  throw Error('FRESH_RECOVERY_REQUIRED');
const raw = readFileSync(originalFile),
  original = JSON.parse(raw);
const prefix = original.prefix;
if (
  !/^qa09-[a-f0-9]{16}$/.test(prefix) ||
  original.userProvisioningMode !== 'SUPPRESSED_COGNITO_AND_INVITED_DATABASE_FIXTURE' ||
  !original.originalUsers?.sha256 ||
  original.users.length > 5
)
  throw Error('EXACT_OWN_USER_RECEIPT_REQUIRED');
for (const c of original.customers)
  if (!uuid.test(c.id) || !['a', 'b'].includes(c.suffix) || c.name !== prefix + '-' + c.suffix)
    throw Error('OWN_CUSTOMER_REQUIRED');
for (const site of original.sites)
  assertOwnedSessionSite(
    prefix,
    original.customers.find((c) => c.id === site.customerId),
    site,
  );
for (const own of original.users)
  assertOwnedBusinessUser(prefix, own, {
    ...own,
    userId: own.userId ?? own.preparedUserId,
    roles: [own.role],
    status: 'INVITED',
  });
const r = {
  ...structuredClone(original),
  scope: 'EXACT_OWN_USER_CLEANUP_RECOVERY_NO_SEED_OR_INVITATION',
  gate: 'RUNNING',
  originalReceiptSha256: hash(raw),
  originalGate: original.gate,
  requests: [],
  checks: [],
  cleanup: [],
  startedAt: new Date().toISOString(),
  fullQa09Accepted: false,
};
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
const check = (id, ok) => {
  r.checks.push({ id, result: ok ? 'PASS' : 'FAIL' });
  save();
  if (!ok) throw Error('RECOVERY_ASSERTION_FAILED');
};
writeFileSync(
  output + '.sources.json',
  JSON.stringify(
    {
      sources: ['scripts/recover-qa09-user-closeout.mjs', 'scripts/run-qa09-signed-session-target.mjs'].map((path) => {
        const b = readFileSync(path);
        return { path, sha256: hash(b), sourceBase64: b.toString('base64') };
      }),
    },
    null,
    2,
  ) + '\n',
);
save();
function aws(args) {
  const p = spawnSync('aws', [...args, '--profile', 'esgiot-infra', '--region', region, '--output', 'json'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (p.status !== 0) throw Error('TEST_SSO_UNAVAILABLE');
  return JSON.parse(p.stdout);
}
const identity = aws(['sts', 'get-caller-identity']);
if (identity.Account !== '065986019555' || !identity.Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_'))
  throw Error('WRONG_TEST_ACCOUNT_OR_ROLE');
const credentials = async () => {
  const c = aws(['configure', 'export-credentials', '--format', 'process']);
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
};
const cognito = new sdk.CognitoIdentityProviderClient({ region, credentials, maxAttempts: 1 });
const call = (Cmd, input) =>
  cognito.send(new Cmd({ UserPoolId: pool, ...input }), { abortSignal: AbortSignal.timeout(30000) });
const idp = createCognitoIdpClient({ region, clientId });
const login = async (username, password) => {
  const flow = new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } });
  const auth = await flow.login(username, password);
  if (auth.status !== 'authenticated') throw Error('REAL_SRP_SESSION_REQUIRED');
  return auth.session;
};
const bootstrap = { username: prefix + '-h01-bootstrap@example.invalid', creationAttempted: true };
const recovery = {
  username: prefix + '-cleanup-' + randomBytes(4).toString('hex') + '@example.invalid',
  password: 'A!z9' + randomBytes(24).toString('base64url'),
};
let root,
  baseline = original.originalUsers.sha256,
  recoveryAttempted = false;
async function rootSession() {
  return root;
}
async function api(id, session, method, path, expected, body, headers = {}) {
  const startedAt = new Date().toISOString(),
    start = performance.now();
  const res = await fetch(host + path, {
    method,
    headers: { Authorization: 'Bearer ' + session.idToken, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => null);
  r.requests.push({
    id,
    method,
    path: path.split('?')[0],
    startedAt,
    status: res.status,
    expected,
    gatewayRequestId: res.headers.get('x-amzn-requestid'),
    errorCode: data?.error?.code ?? null,
    latencyMs: Math.round(performance.now() - start),
  });
  check(id, res.status === expected);
  return data;
}
const admin = async (...args) => api(args[0], await rootSession(), ...args.slice(1));
async function allUsers() {
  const rows = [],
    cursors = new Set();
  let cursor;
  for (let page = 0; page < 40; page++) {
    const value = await admin(
      'user-ledger-' + r.requests.length,
      'GET',
      '/api/v1/admin/users?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      200,
    );
    if (!Array.isArray(value.data)) throw Error('USER_LEDGER_RESPONSE_REQUIRED');
    rows.push(...value.data);
    cursor = value.meta?.nextCursor;
    if (!cursor) return rows;
    if (cursors.has(cursor)) throw Error('USER_LEDGER_CURSOR_LOOP');
    cursors.add(cursor);
  }
  throw Error('USER_LEDGER_PAGE_BOUND');
}
const outside = (rows) =>
  hash(
    JSON.stringify(
      rows.filter((u) => !u.email.startsWith(prefix + '-')).sort((a, b) => a.userId.localeCompare(b.userId)),
    ),
  );
try {
  recoveryAttempted = true;
  await call(sdk.AdminCreateUserCommand, {
    Username: recovery.username,
    MessageAction: 'SUPPRESS',
    TemporaryPassword: recovery.password,
    UserAttributes: [
      { Name: 'email', Value: recovery.username },
      { Name: 'email_verified', Value: 'true' },
    ],
  });
  await call(sdk.AdminAddUserToGroupCommand, { Username: recovery.username, GroupName: 'PlatformSuperAdmin' });
  await call(sdk.AdminSetUserPasswordCommand, {
    Username: recovery.username,
    Password: recovery.password,
    Permanent: true,
  });
  root = await login(recovery.username, recovery.password);
  for (const own of r.users) {
    try {
      if (!own.invitationAttempted && !own.identityProvisionAttempted) {
        r.cleanup.push({ type: 'identity-not-created', email: own.email, result: 'PASS' });
        save();
        continue;
      }
      if (!own.userId) {
        const candidate = (await allUsers()).find((u) => u.email === own.email);
        if (candidate) own.userId = assertOwnedBusinessUser(prefix, own, candidate);
      }
      if (own.userId && !own.businessDisabled) {
        const disabled = (
          await admin(own.role + ':cleanup-disable', 'POST', '/api/v1/admin/users/' + own.userId + '/disable', 200)
        ).data;
        if (disabled.userId !== own.userId || disabled.email !== own.email)
          demand(false, 'OWN_BUSINESS_USER_SCOPE_REQUIRED');
        own.businessDisabled = disabled.status === 'DISABLED';
      }
      demand(!own.userId || own.businessDisabled, 'DISABLED_TOMBSTONE_REQUIRED');
      const current = await call(sdk.AdminGetUserCommand, { Username: own.email }).catch((e) => {
        if (e.name === 'UserNotFoundException') return null;
        throw e;
      });
      if (
        current &&
        (current.UserAttributes?.find((a) => a.Name === 'email')?.Value !== own.email ||
          current.UserCreateDate.getTime() < Date.parse(original.startedAt) - 5000)
      )
        demand(false, 'OWN_COGNITO_CREATION_REQUIRED');
      if (current) await call(sdk.AdminDeleteUserCommand, { Username: own.email });
      let gone = false;
      try {
        await call(sdk.AdminGetUserCommand, { Username: own.email });
      } catch (e) {
        gone = e.name === 'UserNotFoundException';
      }
      check(own.role + ':cognito-absent', gone);
      own.cognitoDeleted = gone;
      r.cleanup.push({
        type: 'own-user-retired',
        email: own.email,
        userId: own.userId,
        result: 'PASS',
        disabledTombstoneRetained: true,
      });
    } catch {
      r.cleanup.push({ type: 'own-user-retired', email: own.email, result: 'FAIL' });
    }
    save();
  }
  if (root) {
    try {
      const final = await allUsers();
      check('outside-user-records-preserved', baseline === outside(final));
      const ownRows = final.filter((u) => u.email.startsWith(prefix + '-'));
      check(
        'own-business-users-all-disabled',
        ownRows.length === r.users.filter((u) => u.userId).length && ownRows.every((u) => u.status === 'DISABLED'),
      );
      r.disabledTombstones = ownRows.map((u) => ({ userId: u.userId, email: u.email, status: u.status }));
      r.tombstoneRetentionReason =
        'Business DISABLED records prevent still-valid signed tokens from falling back to bootstrap behavior; no credentials are retained.';
    } catch {
      r.cleanup.push({ type: 'business-readback', result: 'FAIL' });
      save();
    }
    for (const site of [...r.sites].reverse()) {
      try {
        const found = (await admin('cleanup-site-read-' + site.id, 'GET', '/api/v1/admin/sites/' + site.id, 200)).data;
        assertOwnedSessionSite(
          prefix,
          r.customers.find((c) => c.id === site.customerId),
          found,
        );
        await admin('cleanup-site-' + site.id, 'DELETE', '/api/v1/admin/sites/' + site.id, 200, undefined, {
          'If-Match': String(found.version),
        });
        await admin('cleanup-site-absent-' + site.id, 'GET', '/api/v1/admin/sites/' + site.id, 404);
        r.cleanup.push({ type: 'site', id: site.id, result: 'PASS' });
        save();
      } catch {
        r.cleanup.push({ type: 'site', id: site.id, result: 'FAIL' });
        save();
      }
    }
    for (const customer of [...r.customers].reverse()) {
      try {
        const found = (
          await admin('cleanup-customer-read-' + customer.id, 'GET', '/api/v1/admin/customers/' + customer.id, 200)
        ).data;
        check('cleanup-customer-owned-' + customer.id, found.id === customer.id && found.name === customer.name);
        await admin(
          'cleanup-customer-' + customer.id,
          'DELETE',
          '/api/v1/admin/customers/' + customer.id,
          200,
          undefined,
          { 'If-Match': String(found.version) },
        );
        await admin('cleanup-customer-absent-' + customer.id, 'GET', '/api/v1/admin/customers/' + customer.id, 404);
        r.cleanup.push({ type: 'customer', id: customer.id, result: 'PASS' });
        save();
      } catch {
        r.cleanup.push({ type: 'customer', id: customer.id, result: 'FAIL' });
        save();
      }
    }
  }
  if (bootstrap.creationAttempted) {
    try {
      const current = await call(sdk.AdminGetUserCommand, { Username: bootstrap.username }).catch((e) => {
        if (e.name === 'UserNotFoundException') return null;
        throw e;
      });
      demand(
        !current ||
          (current.UserAttributes?.find((a) => a.Name === 'email')?.Value === bootstrap.username &&
            current.UserCreateDate.getTime() >= Date.parse(original.startedAt) - 5000),
        'OWN_BOOTSTRAP_CREATION_REQUIRED',
      );
      if (current) await call(sdk.AdminDeleteUserCommand, { Username: bootstrap.username });
      let gone = false;
      try {
        await call(sdk.AdminGetUserCommand, { Username: bootstrap.username });
      } catch (e) {
        gone = e.name === 'UserNotFoundException';
      }
      check('bootstrap-cognito-absent', gone);
      r.cleanup.push({ type: 'bootstrap', result: 'PASS' });
    } catch {
      r.cleanup.push({ type: 'bootstrap', result: 'FAIL' });
    }
  }
} catch (e) {
  r.failureCode = /^[A-Z_]+$/.test(e.message) ? e.message : 'RECOVERY_FAILED';
  save();
} finally {
  if (recoveryAttempted) {
    try {
      const current = await call(sdk.AdminGetUserCommand, { Username: recovery.username });
      if (current.UserAttributes?.find((a) => a.Name === 'email')?.Value !== recovery.username)
        demand(false, 'OWN_RECOVERY_REQUIRED');
      await call(sdk.AdminDeleteUserCommand, { Username: recovery.username });
      let gone = false;
      try {
        await call(sdk.AdminGetUserCommand, { Username: recovery.username });
      } catch (e) {
        gone = e.name === 'UserNotFoundException';
      }
      r.cleanup.push({ type: 'recovery-identity', result: gone ? 'PASS' : 'FAIL' });
    } catch {
      r.cleanup.push({ type: 'recovery-identity', result: 'FAIL' });
    }
  }
  recovery.password = undefined;
  root = undefined;
  r.finishedAt = new Date().toISOString();
  r.gate =
    !r.failureCode &&
    r.cleanup.length > 0 &&
    r.cleanup.every((c) => c.result === 'PASS') &&
    r.checks.every((c) => c.result === 'PASS')
      ? 'PASS_CLEANUP_ONLY'
      : 'FAIL';
  save();
}
console.log(JSON.stringify({ gate: r.gate, cleanup: r.cleanup }));
process.exitCode = r.gate === 'PASS_CLEANUP_ONLY' ? 0 : 1;
