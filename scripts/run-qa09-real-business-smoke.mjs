import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CURRENT_TEST_CONFIG } from './qa09-current-environment.mjs';
const pool = 'ap-southeast-1_hZMX8LpFo',
  clientId = '5ljdjsf9g563mc1vdc7vjdjm09';
const roles = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
export function assertOwnedIdentity(username, prefix) {
  if (
    !/^qa09-[0-9a-f]{16}$/.test(prefix) ||
    !roles.some((r) => username === `${prefix}-${r.toLowerCase()}@example.invalid`)
  )
    throw Error('NOT_OWN_TEST_IDENTITY');
}
export function assertOwnedRecord(record, prefix) {
  if (!/^qa09-[0-9a-f]{16}$/.test(prefix) || !record?.name?.startsWith(prefix + '-'))
    throw Error('NOT_OWN_TEST_RECORD');
}
let cognito;
async function aws(operation, payload) {
  const sdk = await import('@aws-sdk/client-cognito-identity-provider');
  const { fromIni } = await import('@aws-sdk/credential-provider-ini');
  cognito ??= new sdk.CognitoIdentityProviderClient({
    region: CURRENT_TEST_CONFIG.region,
    credentials: fromIni({ profile: 'esgiot-infra' }),
    maxAttempts: 1,
  });
  const commands = {
    'admin-create-user': 'AdminCreateUserCommand',
    'admin-add-user-to-group': 'AdminAddUserToGroupCommand',
    'admin-delete-user': 'AdminDeleteUserCommand',
    'admin-get-user': 'AdminGetUserCommand',
  };
  if (!commands[operation]) throw Error('UNSUPPORTED_IDENTITY_OPERATION');
  try {
    return await cognito.send(new sdk[commands[operation]](payload), { abortSignal: AbortSignal.timeout(30000) });
  } catch (error) {
    const failure = Error('COGNITO_OPERATION_FAILED');
    failure.code = /^[A-Za-z]+(?:Exception|Denied)$/.test(error.name ?? '') ? error.name : 'AWS_CALL_FAILED';
    throw failure;
  }
}

export async function main(output) {
  if (!output) throw Error('OUTPUT_PATH_REQUIRED');
  const sts = spawnSync(
    'aws',
    [
      'sts',
      'get-caller-identity',
      '--profile',
      'esgiot-infra',
      '--region',
      CURRENT_TEST_CONFIG.region,
      '--output',
      'json',
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (sts.status !== 0) throw Error('SSO_NOT_AVAILABLE');
  const identity = JSON.parse(sts.stdout);
  if (
    identity.Account !== CURRENT_TEST_CONFIG.accountId ||
    !identity.Arn?.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_')
  )
    throw Error('WRONG_TEST_ACCOUNT_OR_ROLE');
  const { AuthFlow } = await import('../apps/admin-web/src/auth/auth-flow.ts');
  const { createCognitoIdpClient } = await import('../apps/admin-web/src/auth/cognito-idp.ts');
  const prefix = `qa09-${randomBytes(8).toString('hex')}`,
    sessions = new Map();
  const receipt = {
    task: 'QA-09',
    scope: 'FIVE_ROLE_SRP_AND_CUSTOMER_SITE_SMOKE',
    mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
    target: CURRENT_TEST_CONFIG,
    sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    startedAt: new Date().toISOString(),
    prefix,
    sourceHashes: Object.fromEntries(
      [
        'scripts/run-qa09-real-business-smoke.mjs',
        'infra/environments/qa09-current-test.json',
        'apps/admin-web/src/auth/auth-flow.ts',
        'apps/admin-web/src/auth/cognito-idp.ts',
        'apps/admin-web/src/auth/srp.ts',
      ].map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]),
    ),
    checks: [],
    createdIdentities: [],
    createdRecords: [],
    cleanup: [],
    gate: 'RUNNING',
    fullQa09Gate: 'NOT RUN / NO RECEIPT',
  };
  const save = () => writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  save();
  const check = (id, ok, data = {}) => {
    receipt.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
    save();
    if (!ok) throw Object.assign(Error('ASSERTION_FAILED'), { code: id });
  };
  async function api(id, role, method, path, expected, body, headers = {}) {
    const token = sessions.get(role)?.idToken;
    if (!token) throw Error('NO_AUTHENTICATED_SESSION');
    const response = await fetch(`https://api.bio-nexa.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    const parsed = await response.json().catch(() => null);
    check(id, response.status === expected, {
      httpStatus: response.status,
      expectedStatus: expected,
      requestId: parsed?.meta?.requestId ?? parsed?.error?.requestId ?? response.headers.get('x-amzn-requestid'),
      errorCode: parsed?.error?.code ?? null,
    });
    return parsed;
  }
  async function createIdentity(role, customerId) {
    const username = `${prefix}-${role.toLowerCase()}@example.invalid`;
    assertOwnedIdentity(username, prefix);
    const password = `A!z9${randomBytes(24).toString('base64url')}`;
    const attrs = [
      { Name: 'email', Value: username },
      { Name: 'email_verified', Value: 'true' },
    ];
    if (customerId) attrs.push({ Name: 'custom:customer_id', Value: customerId });
    await aws('admin-create-user', {
      UserPoolId: pool,
      Username: username,
      TemporaryPassword: password,
      MessageAction: 'SUPPRESS',
      UserAttributes: attrs,
    });
    receipt.createdIdentities.push({ username, role, customerId: customerId ?? null });
    save();
    await aws('admin-add-user-to-group', { UserPoolId: pool, Username: username, GroupName: role });
    const idp = createCognitoIdpClient({ region: CURRENT_TEST_CONFIG.region, clientId });
    const flow = new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } });
    const first = await flow.login(username, password);
    check(`${role}:first-login-challenge`, first.status === 'new-password-required');
    const outcome = await flow.submitNewPassword(`A!z9${randomBytes(24).toString('base64url')}`);
    check(`${role}:srp-login`, outcome.status === 'authenticated');
    sessions.set(role, outcome.session);
    check(
      `${role}:role-scope`,
      outcome.session.roles.length === 1 &&
        outcome.session.roles[0] === role &&
        outcome.session.customerId === (customerId ?? null),
    );
    const refreshed = await idp.refreshAuth(outcome.session.refreshToken);
    check(`${role}:refresh`, typeof refreshed.idToken === 'string' && typeof refreshed.accessToken === 'string');
    check(
      `${role}:wrong-password`,
      await flow.login(username, `Wrong!9${randomBytes(12).toString('hex')}`).then(
        () => false,
        (e) => e.code === 'INVALID_CREDENTIALS',
      ),
    );
  }
  try {
    await createIdentity('PlatformSuperAdmin');
    const customers = [];
    for (const suffix of ['a', 'b']) {
      const c = await api(`customer-create-${suffix}`, 'PlatformSuperAdmin', 'POST', '/api/v1/admin/customers', 201, {
        name: `${prefix}-${suffix}`,
      });
      const record = { type: 'customers', id: c.data.id, name: c.data.name, version: c.data.version };
      receipt.createdRecords.push(record);
      customers.push(record);
      save();
    }
    await createIdentity('PlatformOperator');
    await createIdentity('Auditor');
    await createIdentity('CustomerAdmin', customers[0].id);
    await createIdentity('CustomerViewer', customers[0].id);
    const sites = [];
    for (const [i, c] of customers.entries()) {
      const s = await api(`site-create-${i}`, 'PlatformOperator', 'POST', '/api/v1/admin/sites', 201, {
        customerId: c.id,
        name: `${prefix}-site-${i}`,
        timezone: 'Asia/Shanghai',
      });
      const record = { type: 'sites', id: s.data.id, name: s.data.name, version: s.data.version };
      receipt.createdRecords.push(record);
      sites.push(record);
      save();
    }
    for (const role of roles) {
      await api(`${role}:site-read-own`, role, 'GET', `/api/v1/admin/sites/${sites[0].id}`, 200);
      if (role.startsWith('Customer'))
        await api(`${role}:cross-customer-denied`, role, 'GET', `/api/v1/admin/sites/${sites[1].id}`, 403);
      if (['Auditor', 'CustomerAdmin', 'CustomerViewer'].includes(role))
        await api(`${role}:site-write-denied`, role, 'POST', '/api/v1/admin/sites', 403, {
          customerId: customers[0].id,
          name: `${prefix}-forbidden`,
        });
    }
    for (const role of ['PlatformSuperAdmin', 'Auditor'])
      await api(`${role}:users-read`, role, 'GET', '/api/v1/admin/users?limit=1', 200);
    await api('PlatformOperator:users-read-denied', 'PlatformOperator', 'GET', '/api/v1/admin/users?limit=1', 403);
    const c = customers[0];
    const changed = await api(
      'customer-update',
      'PlatformOperator',
      'PATCH',
      `/api/v1/admin/customers/${c.id}`,
      200,
      { name: `${prefix}-updated` },
      { 'If-Match': String(c.version) },
    );
    c.version = changed.data.version;
    c.name = changed.data.name;
    save();
    await api(
      'customer-stale-version',
      'PlatformOperator',
      'PATCH',
      `/api/v1/admin/customers/${c.id}`,
      409,
      { name: `${prefix}-stale` },
      { 'If-Match': String(c.version - 1) },
    );
    receipt.scenariosPassed = true;
  } catch (e) {
    receipt.gate = 'FAIL';
    receipt.failureCode = e.code ?? 'EXECUTION_FAILED';
  } finally {
    for (const record of [...receipt.createdRecords].reverse()) {
      try {
        const found = await api(
          `cleanup-read-${record.type}-${record.id}`,
          'PlatformSuperAdmin',
          'GET',
          `/api/v1/admin/${record.type}/${record.id}`,
          200,
        );
        assertOwnedRecord(found.data, prefix);
        await api(
          `cleanup-delete-${record.type}-${record.id}`,
          'PlatformSuperAdmin',
          'DELETE',
          `/api/v1/admin/${record.type}/${record.id}`,
          200,
          undefined,
          { 'If-Match': String(found.data.version) },
        );
        await api(
          `cleanup-verify-${record.type}-${record.id}`,
          'PlatformSuperAdmin',
          'GET',
          `/api/v1/admin/${record.type}/${record.id}`,
          404,
        );
        receipt.cleanup.push({ type: record.type, id: record.id, status: 'SOFT_DELETED_AND_NOT_VISIBLE' });
      } catch (e) {
        receipt.cleanup.push({ type: record.type, id: record.id, status: 'FAILED', code: e.code ?? 'CLEANUP_FAILED' });
        receipt.gate = 'FAIL';
      }
      save();
    }
    for (const own of [...receipt.createdIdentities].reverse()) {
      try {
        assertOwnedIdentity(own.username, prefix);
        const session = sessions.get(own.role);
        if (session)
          await createCognitoIdpClient({ region: CURRENT_TEST_CONFIG.region, clientId }).globalSignOut(
            session.accessToken,
          );
        await aws('admin-delete-user', { UserPoolId: pool, Username: own.username });
        let absent = false;
        try {
          await aws('admin-get-user', { UserPoolId: pool, Username: own.username });
        } catch (e) {
          absent = e.code === 'UserNotFoundException';
        }
        if (!absent) receipt.gate = 'FAIL';
        receipt.cleanup.push({ type: 'cognito-user', username: own.username, status: 'DELETED' });
      } catch (e) {
        receipt.cleanup.push({
          type: 'cognito-user',
          username: own.username,
          status: 'FAILED',
          code: e.code ?? 'CLEANUP_FAILED',
        });
        receipt.gate = 'FAIL';
      }
      save();
    }
    receipt.gate =
      receipt.scenariosPassed && receipt.gate !== 'FAIL' && receipt.cleanup.every((c) => c.status !== 'FAILED')
        ? 'PASS'
        : 'FAIL';
    receipt.finishedAt = new Date().toISOString();
    save();
  }
  console.log(
    JSON.stringify(
      {
        gate: receipt.gate,
        checks: receipt.checks.length,
        identities: receipt.createdIdentities.length,
        records: receipt.createdRecords.length,
        cleanup: receipt.cleanup,
        failureCode: receipt.failureCode,
      },
      null,
      2,
    ),
  );
  if (receipt.gate !== 'PASS') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv[2]).catch(() => {
    console.error('QA09_SETUP_FAILED');
    process.exitCode = 1;
  });
