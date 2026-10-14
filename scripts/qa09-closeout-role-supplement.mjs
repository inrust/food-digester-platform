import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { runCloseoutBrowserGaps } from './qa09-closeout-browser-gaps.mjs';
import { recheckDeviceUserLayout } from './qa09-device-user-layout-recheck.mjs';
const pool = 'ap-southeast-1_hZMX8LpFo';
export async function runRoleSupplement({ r, save, cognito, rootLogin, rootSession, viewerOnly = false }) {
  r.childIdentities = [];
  r.customers = [];
  r.reads = [];
  const logins = new Map([['PlatformSuperAdmin', rootLogin]]);
  const sessions = new Map();
  async function api(id, method, path, expected, body, headers = {}) {
    const res = await fetch('https://api.bio-nexa.com' + path, {
      method,
      headers: { Authorization: 'Bearer ' + rootSession.idToken, 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    const x = await res.json();
    const requestId = x.meta?.requestId ?? x.error?.requestId ?? res.headers.get('x-amzn-requestid');
    r.reads.push({ id, method, path, status: res.status, requestId });
    save();
    if (!(Array.isArray(expected) ? expected.includes(res.status) : expected === res.status) || !requestId)
      throw Error('ROLE_SUPPLEMENT_API_FAILED');
    return x;
  }
  const call = (Cmd, input) =>
    cognito.send(new Cmd({ UserPoolId: pool, ...input }), { abortSignal: AbortSignal.timeout(30000) });
  try {
    const c = (await api('create-own-scope', 'POST', '/api/v1/admin/customers', 201, { name: r.prefix + '-a' })).data;
    r.customers.push(c);
    save();
    for (const role of viewerOnly
      ? ['CustomerViewer']
      : ['PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer']) {
      const username = r.prefix + '-' + role.toLowerCase() + '@example.invalid',
        temporary = 'A!z9' + randomBytes(24).toString('base64url');
      await call(sdk.AdminCreateUserCommand, {
        Username: username,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: temporary,
        UserAttributes: [
          { Name: 'email', Value: username },
          { Name: 'email_verified', Value: 'true' },
          ...(role.startsWith('Customer') ? [{ Name: 'custom:customer_id', Value: c.id }] : []),
        ],
      });
      r.childIdentities.push({ role, username });
      save();
      await call(sdk.AdminAddUserToGroupCommand, { Username: username, GroupName: role });
      const flow = new AuthFlow({
        idp: createCognitoIdpClient({ region: 'ap-southeast-1', clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
        userPoolId: pool,
        sessionManager: { establish() {} },
      });
      if ((await flow.login(username, temporary)).status !== 'new-password-required')
        throw Error('REAL_ROLE_CHALLENGE_REQUIRED');
      const password = 'A!z9' + randomBytes(24).toString('base64url'),
        auth = await flow.submitNewPassword(password);
      if (auth.status !== 'authenticated') throw Error('REAL_ROLE_SRP_REQUIRED');
      sessions.set(role, auth.session);
      logins.set(role, { username, password });
    }
    r.remaining = {};
    const ctx = { logins, devices: [r.prefix + '-01'], businessReceipt: r, save };
    if (viewerOnly) {
      r.viewerDeviceUser = await recheckDeviceUserLayout({
        ...logins.get('CustomerViewer'),
        requireOverflow: false,
        emptyCustomerScope: true,
      });
      r.viewerDeviceUser.role = 'CustomerViewer';
      r.viewerDeviceUser.scope = 'ONLY_CHANGED_VIEWER_DEVICE_USER_READ_ACCESS_AT_375_EN';
    } else {
      r.browserSupplement = await runCloseoutBrowserGaps(ctx, null, { roleControlsOnly: true });
      r.unknownContainment = await readUnknownContainment(api, call, save);
    }
  } finally {
    for (const own of [...r.childIdentities].reverse()) {
      try {
        await call(sdk.AdminUserGlobalSignOutCommand, { Username: own.username });
        await call(sdk.AdminDeleteUserCommand, { Username: own.username });
        await (async () => {
          try {
            await call(sdk.AdminGetUserCommand, { Username: own.username });
            throw Error('OWN_ROLE_IDENTITY_REMAINS');
          } catch (e) {
            if (e.name !== 'UserNotFoundException') throw e;
          }
        })();
        r.cleanup.push({ type: 'role-identity', role: own.role, result: 'PASS', absent: true });
      } catch {
        r.cleanup.push({ type: 'role-identity', role: own.role, result: 'FAIL' });
      }
      save();
    }
    for (const c of r.customers) {
      try {
        const x = (await api('own-customer-before-cleanup', 'GET', '/api/v1/admin/customers/' + c.id, 200)).data;
        await (async () => {
          if (x.name !== r.prefix + '-a') throw Error('OWN_CUSTOMER_NAME_REQUIRED');
        })();
        await api('own-customer-delete', 'DELETE', '/api/v1/admin/customers/' + c.id, 200, undefined, {
          'If-Match': String(x.version),
        });
        await api('own-customer-absent', 'GET', '/api/v1/admin/customers/' + c.id, 404);
        r.cleanup.push({ type: 'customer', result: 'PASS', absent: true });
      } catch {
        r.cleanup.push({ type: 'customer', result: 'FAIL' });
      }
      save();
    }
  }
  if (r.cleanup.some((c) => c.result !== 'PASS')) throw Error('ROLE_SUPPLEMENT_CLEANUP_FAILED');
}
async function readUnknownContainment(api, call, save) {
  const path =
      'docs/audit/evidence/qa-09-close-01-2026-10-12/user-target.json.seed-PlatformSuperAdmin.json.preparation.json',
    bytes = readFileSync(path),
    plan = JSON.parse(bytes).plan;
  if (
    plan.action !== 'business-seed-user' ||
    plan.prefix !== 'qa09-14197706b32ec5b0' ||
    plan.ownUser.role !== 'PlatformSuperAdmin'
  )
    throw Error('EXACT_UNKNOWN_PLAN_REQUIRED');
  const r = {
    originalPlanSha256: createHash('sha256').update(bytes).digest('hex'),
    originalStartGate: 'UNKNOWN',
    restartAllowed: false,
    executionSuccessClaimed: false,
    writes: 0,
    reads: [],
  };
  const u = (await api('historical-user', 'GET', '/api/v1/admin/users/' + plan.ownUser.userId, [200, 404])).data;
  if (u) {
    if (
      u.email !== plan.ownUser.email ||
      u.customerId !== null ||
      u.roles.length !== 1 ||
      u.roles[0] !== plan.ownUser.role
    )
      throw Error('HISTORICAL_USER_SCOPE_DRIFT');
    if (u.status !== 'DISABLED') {
      await api(
        'disable-exact-historical-user',
        'POST',
        '/api/v1/admin/users/' + plan.ownUser.userId + '/disable',
        200,
        { reason: plan.prefix },
        { 'If-Match': String(u.version) },
      );
      r.writes++;
    }
    const after = (await api('historical-disabled-readback', 'GET', '/api/v1/admin/users/' + plan.ownUser.userId, 200))
      .data;
    if (after.status !== 'DISABLED') throw Error('HISTORICAL_USER_NOT_INERT');
    r.businessUser = 'DISABLED_TOMBSTONE';
  } else r.businessUser = 'ABSENT';
  try {
    await call(sdk.AdminGetUserCommand, { Username: plan.ownUser.email });
    throw Error('HISTORICAL_COGNITO_IDENTITY_REMAINS');
  } catch (e) {
    if (e.name !== 'UserNotFoundException') throw e;
    r.cognitoIdentity = 'ABSENT';
  }
  for (const c of plan.customers) {
    await api('historical-customer-' + c.suffix, 'GET', '/api/v1/admin/customers/' + c.id, 404);
    r.reads.push({ type: 'customer', absent: true });
  }
  r.gate = 'PASS_CONTAINMENT_ONLY_UNKNOWN_EXECUTION_PRESERVED';
  save();
  return r;
}
