import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { qa09VersionInputs } from './qa09-version-inputs.mjs';

const roles = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
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

export async function runSignedSessionTarget(output, versionPath) {
  const versionBytes = readFileSync(versionPath),
    version = JSON.parse(versionBytes);
  if (
    version.gate !== 'PASS' ||
    version.accountId !== '065986019555' ||
    version.region !== region ||
    version.stackName !== 'fdp-test-app' ||
    version.sourceCommit !== qa09VersionInputs().commit ||
    version.lambdaArtifacts?.length !== 19
  )
    throw Error('EXACT_DEPLOYED_VERSION_REQUIRED');
  const prefix = 'qa09-' + randomBytes(8).toString('hex');
  const r = {
    task: 'QA-09',
    scope: 'FRESH_SIGNED_TOKENS_BUSINESS_DISABLE_USER_ROLES_AND_SCOPE',
    sourceCommit: version.sourceCommit,
    prefix,
    startedAt: new Date().toISOString(),
    fullQa09Accepted: false,
    gate: 'RUNNING',
    checks: [],
    requests: [],
    users: [],
    customers: [],
    sites: [],
    cleanup: [],
    applicationVersionReceiptSha256: hash(versionBytes),
    credentialsExported: false,
    kmsAndIamManagementPerformed: false,
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  writeFileSync(
    output + '.sources.json',
    JSON.stringify(
      {
        frozenAt: r.startedAt,
        nodeVersion: process.version,
        sources: [
          'scripts/run-qa09-signed-session-target.mjs',
          'scripts/qa09-version-inputs.mjs',
          'apps/admin-web/src/auth/auth-flow.ts',
          'apps/admin-web/src/auth/cognito-idp.ts',
          'apps/cloud-api/src/admin/user/service.ts',
          'apps/cloud-api/src/admin/user/handler.ts',
          'packages/aws-clients/src/cognito-admin.ts',
          'packages/auth/src/permissions.ts',
          'pnpm-lock.yaml',
        ].map((path) => {
          const bytes = readFileSync(path);
          return { path, sha256: hash(bytes), sourceBase64: bytes.toString('base64') };
        }),
      },
      null,
      2,
    ) + '\n',
  );
  save();
  const check = (id, ok, data = {}) => {
    r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
    save();
    if (!ok) throw Error('SIGNED_SESSION_TARGET_ASSERTION_FAILED');
  };
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
  const bootstrap = {
    username: prefix + '-h01-bootstrap@example.invalid',
    password: 'A!z9' + randomBytes(24).toString('base64url'),
    created: false,
    creationAttempted: false,
  };
  let root, baseline;
  async function rootSession() {
    if (!root || JSON.parse(Buffer.from(root.idToken.split('.')[1], 'base64url')).exp * 1000 < Date.now() + 120000)
      root = await login(bootstrap.username, bootstrap.password);
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
    const existing = await call(sdk.AdminGetUserCommand, { Username: bootstrap.username }).then(
      () => true,
      (e) => {
        if (e.name === 'UserNotFoundException') return false;
        throw e;
      },
    );
    demand(!existing, 'FRESH_BOOTSTRAP_REQUIRED');
    bootstrap.creationAttempted = true;
    await call(sdk.AdminCreateUserCommand, {
      Username: bootstrap.username,
      MessageAction: 'SUPPRESS',
      TemporaryPassword: bootstrap.password,
      UserAttributes: [
        { Name: 'email', Value: bootstrap.username },
        { Name: 'email_verified', Value: 'true' },
      ],
    });
    bootstrap.created = true;
    await call(sdk.AdminAddUserToGroupCommand, { Username: bootstrap.username, GroupName: 'PlatformSuperAdmin' });
    await call(sdk.AdminSetUserPasswordCommand, {
      Username: bootstrap.username,
      Password: bootstrap.password,
      Permanent: true,
    });
    root = await login(bootstrap.username, bootstrap.password);
    check('bootstrap-real-srp', root.roles.length === 1 && root.roles[0] === 'PlatformSuperAdmin');
    const prior = await allUsers();
    baseline = outside(prior);
    check('fresh-business-prefix', !prior.some((u) => u.email.startsWith(prefix + '-')));
    r.originalUsers = {
      count: prior.length,
      sha256: baseline,
      eligibleSuperAdmins: prior.filter((u) => u.status !== 'DISABLED' && u.roles.includes('PlatformSuperAdmin'))
        .length,
    };
    save();
    for (const suffix of ['a', 'b']) {
      const customer = (
        await admin('create-customer-' + suffix, 'POST', '/api/v1/admin/customers', 201, {
          name: prefix + '-' + suffix,
        })
      ).data;
      check('own-customer-' + suffix, uuid.test(customer.id) && customer.name === prefix + '-' + suffix);
      r.customers.push({ id: customer.id, name: customer.name, suffix });
      save();
      const site = (
        await admin('create-site-' + suffix, 'POST', '/api/v1/admin/sites', 201, {
          customerId: customer.id,
          name: prefix + '-site-' + suffix,
          timezone: 'Asia/Shanghai',
        })
      ).data;
      assertOwnedSessionSite(prefix, r.customers.at(-1), site);
      r.sites.push(site);
      save();
    }
    for (const role of roles) {
      if (role === 'PlatformSuperAdmin' && r.originalUsers.eligibleSuperAdmins < 1) {
        r.checks.push({ id: role + ':last-superadmin-precondition', result: 'NOT_RUN' });
        save();
        continue;
      }
      const customerId =
        role === 'CustomerAdmin' ? r.customers[0].id : role === 'CustomerViewer' ? r.customers[1].id : null;
      const own = {
        role,
        email: prefix + '-h01-' + role.toLowerCase() + '@example.invalid',
        customerId,
        userId: null,
        businessDisabled: false,
        cognitoDeleted: false,
        invitationAttempted: false,
      };
      r.users.push(own);
      save();
      try {
        let absent = false;
        try {
          await call(sdk.AdminGetUserCommand, { Username: own.email });
        } catch (e) {
          absent = e.name === 'UserNotFoundException';
        }
        check(role + ':fresh-cognito-name', absent);
        own.invitationAttempted = true;
        save();
        const invited = (
          await admin(role + ':invite', 'POST', '/api/v1/admin/users', 201, {
            email: own.email,
            displayName: prefix + '-' + role,
            roles: [role],
            ...(customerId ? { customerId } : {}),
          })
        ).data;
        own.userId = assertOwnedBusinessUser(prefix, own, invited);
        own.invitedStatus = invited.status;
        save();
        check(role + ':invited-state', invited.status === 'INVITED');
        // Only this newly created test identity receives a dedicated permanent password.
        const password = 'A!z9' + randomBytes(24).toString('base64url');
        await call(sdk.AdminSetUserPasswordCommand, { Username: own.email, Password: password, Permanent: true });
        let session = await login(own.email, password);
        check(
          role + ':srp-claims',
          session.roles.length === 1 && session.roles[0] === role && session.customerId === customerId,
        );
        await api(
          role + ':first-authenticated-read',
          session,
          'GET',
          '/api/v1/admin/sites/' + r.sites[role === 'CustomerViewer' ? 1 : 0].id,
          200,
        );
        if (role === 'PlatformOperator') {
          for (const next of ['Auditor', 'PlatformOperator']) {
            const view = (
              await admin(role + ':set-roles-' + next, 'PUT', '/api/v1/admin/users/' + own.userId + '/roles', 200, {
                roles: [next],
              })
            ).data;
            assertOwnedBusinessUser(prefix, { ...own, role: next }, view);
            session = await login(own.email, password);
            check(role + ':fresh-role-' + next, session.roles.length === 1 && session.roles[0] === next);
          }
        }
        if (role === 'CustomerAdmin') {
          for (const [suffix, id] of [
            ['b', r.customers[1].id],
            ['a', customerId],
          ]) {
            const view = (
              await admin(role + ':set-scope-' + suffix, 'PUT', '/api/v1/admin/users/' + own.userId + '/scope', 200, {
                customerId: id,
              })
            ).data;
            assertOwnedBusinessUser(prefix, { ...own, customerId: id }, view);
            session = await login(own.email, password);
            check(role + ':fresh-scope-' + suffix, session.customerId === id);
          }
        }
        const tokenDigest = hash(session.idToken),
          expiresAt = JSON.parse(Buffer.from(session.idToken.split('.')[1], 'base64url')).exp * 1000;
        own.signedSession = {
          sha256: tokenDigest,
          expiresAt: new Date(expiresAt).toISOString(),
          credentialExported: false,
        };
        save();
        for (const [i, site] of r.sites.entries())
          await api(
            role + ':active-read-' + i,
            session,
            'GET',
            '/api/v1/admin/sites/' + site.id,
            !customerId || site.customerId === customerId ? 200 : 403,
          );
        const active = (await allUsers()).find((u) => u.userId === own.userId);
        assertOwnedBusinessUser(prefix, own, active);
        check(role + ':business-active', active.status === 'ACTIVE');
        const disabled = (await admin(role + ':disable', 'POST', '/api/v1/admin/users/' + own.userId + '/disable', 200))
          .data;
        assertOwnedBusinessUser(prefix, own, disabled);
        own.businessDisabled = disabled.status === 'DISABLED';
        save();
        check(role + ':business-disabled', own.businessDisabled);
        check(role + ':same-unexpired-token', hash(session.idToken) === tokenDigest && Date.now() + 120000 < expiresAt);
        await api(
          role + ':disabled-old-token-read',
          session,
          'GET',
          '/api/v1/admin/sites/' + r.sites[role === 'CustomerViewer' ? 1 : 0].id,
          401,
        );
        await api(role + ':disabled-old-token-write', session, 'POST', '/api/v1/admin/sites', 401, {
          qa09UnknownField: true,
        });
        check(role + ':post-requests-unexpired', Date.now() + 120000 < expiresAt);
      } catch (error) {
        own.failureCode = /^[A-Z_]+$/.test(error.message) ? error.message : 'OWN_SIGNED_SESSION_CASE_FAILED';
        save();
      }
    }
  } catch (error) {
    r.failureCode = /^[A-Z_]+$/.test(error.message) ? error.message : 'SIGNED_SESSION_TARGET_FAILED';
    save();
  } finally {
    for (const own of r.users) {
      try {
        if (!own.invitationAttempted) {
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
            current.UserCreateDate.getTime() < Date.parse(r.startedAt) - 5000)
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
          const found = (await admin('cleanup-site-read-' + site.id, 'GET', '/api/v1/admin/sites/' + site.id, 200))
            .data;
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
              current.UserCreateDate.getTime() >= Date.parse(r.startedAt) - 5000),
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
    root = undefined;
    bootstrap.password = undefined;
    r.finishedAt = new Date().toISOString();
    r.gate =
      !r.failureCode &&
      r.users.length === 5 &&
      r.users.every((u) => !u.failureCode && u.businessDisabled && u.cognitoDeleted) &&
      r.checks.every((c) => c.result === 'PASS') &&
      r.cleanup.every((c) => c.result === 'PASS')
        ? 'PASS_SCOPED_FIVE_ROLE_SIGNED_SESSION_AND_USER_WRITES'
        : 'FAIL';
    save();
    console.log(
      JSON.stringify({
        gate: r.gate,
        prefix,
        checks: r.checks.length,
        requests: r.requests.length,
        cleanup: r.cleanup,
      }),
    );
  }
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runSignedSessionTarget(...process.argv.slice(2))
    .then((r) => {
      process.exitCode = r.gate.startsWith('PASS_') ? 0 : 1;
    })
    .catch(() => {
      console.error('SIGNED_SESSION_TARGET_PRECONDITION_FAILED');
      process.exitCode = 1;
    });
