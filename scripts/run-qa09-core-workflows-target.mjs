import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { runBusinessTarget } from './qa09-business-target.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { validateBusinessVersion, validateBusinessDatabaseReceipts } from './check-qa09-business-target.mjs';
import { validateTargetStage, ROLES } from './qa09-business-target.mjs';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
const [output, versionFile] = process.argv.slice(2);
if (!output || !versionFile) throw Error('OUTPUT_AND_VERSION_REQUIRED');
const version = JSON.parse(readFileSync(versionFile));
validateBusinessVersion(version, version.sourceCommit);
const identity = spawnSync(
  'aws',
  ['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--region', 'ap-southeast-1', '--output', 'json'],
  { encoding: 'utf8', timeout: 30000 },
);
if (
  identity.status !== 0 ||
  JSON.parse(identity.stdout).Account !== '065986019555' ||
  !JSON.parse(identity.stdout).Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_')
)
  throw Error('WRONG_AWS_IDENTITY');
const sourcePaths = [
  'scripts/run-qa09-core-workflows-target.mjs',
  'scripts/qa09-business-target.mjs',
  'scripts/qa09-license-lifecycle.mjs',
  'scripts/qa09-db-log-frames.mjs',
  'scripts/qa09-db-frame-wait.mjs',
  'scripts/check-qa09-business-target.mjs',
  'scripts/qa09-ten-device-db.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'scripts/qa09-owned-domain-cleanup.mjs',
  'scripts/qa09-current-environment.mjs',
  'infra/environments/qa09-current-test.json',
  'apps/admin-web/src/router/routes.ts',
  'packages/auth/src/permissions.ts',
];
writeFileSync(
  output + '.sources.json',
  JSON.stringify(
    {
      task: 'QA-09',
      sources: sourcePaths.map((path) => {
        const b = readFileSync(path);
        return { path, sha256: createHash('sha256').update(b).digest('hex'), sourceBase64: b.toString('base64') };
      }),
    },
    null,
    2,
  ) + '\n',
);
const prefix = 'qa09-' + randomBytes(8).toString('hex'),
  devices = Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`);
const r = {
  task: 'QA-09',
  scope: 'CORE_BUSINESS_REAL_RDS_STATE_FIXTURE',
  mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
  target: { accountId: '065986019555', region: 'ap-southeast-1' },
  fixtureMode: 'REAL_RDS_ONBOARDED_STATE_FOR_BUSINESS_APIS_NO_DEVICE_AUTH_CLAIM',
  prefix,
  devices,
  customers: [],
  checks: [],
  cleanup: [],
  databaseBuilds: [],
  sourceCommit: version.sourceCommit,
  versionReceipt: versionFile,
  startedAt: new Date().toISOString(),
  gate: 'RUNNING',
  fullQa09Accepted: false,
  credentialsExported: false,
};
const save = () => writeFileSync(output + '.fixtures.json', JSON.stringify(r, null, 2) + '\n');
let cachedCredentials;
const credentials = async () => {
  if (!cachedCredentials || cachedCredentials.expiration.getTime() < Date.now() + 300000) {
    const exported = spawnSync(
      'aws',
      ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'],
      { encoding: 'utf8', timeout: 30000 },
    );
    if (exported.status !== 0) throw Error('SSO_CREDENTIALS_UNAVAILABLE');
    const v = JSON.parse(exported.stdout);
    cachedCredentials = {
      accessKeyId: v.AccessKeyId,
      secretAccessKey: v.SecretAccessKey,
      sessionToken: v.SessionToken,
      expiration: new Date(v.Expiration),
    };
  }
  return cachedCredentials;
};
const region = 'ap-southeast-1',
  pool = 'ap-southeast-1_hZMX8LpFo';
const cognito = new cognitoSdk.CognitoIdentityProviderClient({ region, credentials, maxAttempts: 1 });
const idp = createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' });
const username = prefix + '-platformsuperadmin@example.invalid',
  password = `A!z9${randomBytes(24).toString('base64url')}`;
let created = false,
  seeded = false,
  token,
  accessToken,
  baseline;
const call = (Cmd, input) => cognito.send(new Cmd(input), { abortSignal: AbortSignal.timeout(30000) });
const check = (id, ok, data = {}) => {
  r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
  save();
  if (!ok) throw Object.assign(Error('CORE_FIXTURE_ASSERTION_FAILED'), { code: id });
};
async function refreshIdentity() {
  const auth = await new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } }).login(
    username,
    password,
  );
  check('dedicated-real-srp-renewal', auth.status === 'authenticated');
  token = auth.session.idToken;
  accessToken = auth.session.accessToken;
  return auth.session;
}
async function api(id, method, path, expected, body, headers = {}) {
  const response = await fetch('https://api.bio-nexa.com' + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const v = await response.json().catch(() => null);
  check(id, response.status === expected, {
    method,
    path,
    status: response.status,
    requestId: v?.meta?.requestId ?? v?.error?.requestId ?? response.headers.get('x-amzn-requestid'),
  });
  return v;
}
async function db(action) {
  const path = output + `.fixtures-${action}.json`;
  const result = await runFixture(
    { prefix, devices, customers: r.customers, action, ...(baseline ? { baseline } : {}) },
    path,
    (p) => console.log(p),
  );
  r.databaseBuilds.push({ action, receipt: path, buildId: result.build.id });
  save();
  return result.result;
}
save();
try {
  const temporary = `A!z9${randomBytes(24).toString('base64url')}`;
  await call(cognitoSdk.AdminCreateUserCommand, {
    UserPoolId: pool,
    Username: username,
    MessageAction: 'SUPPRESS',
    TemporaryPassword: temporary,
    UserAttributes: [
      { Name: 'email', Value: username },
      { Name: 'email_verified', Value: 'true' },
    ],
  });
  created = true;
  r.identity = { username, created: true };
  save();
  await call(cognitoSdk.AdminAddUserToGroupCommand, {
    UserPoolId: pool,
    Username: username,
    GroupName: 'PlatformSuperAdmin',
  });
  const flow = new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } });
  check('dedicated-first-login-challenge', (await flow.login(username, temporary)).status === 'new-password-required');
  const auth = await flow.submitNewPassword(password);
  check('dedicated-real-srp', auth.status === 'authenticated');
  token = auth.session.idToken;
  accessToken = auth.session.accessToken;
  for (const suffix of ['a', 'b']) {
    const x = await api('create-customer-' + suffix, 'POST', '/api/v1/admin/customers', 201, {
      name: prefix + '-' + suffix,
    });
    r.customers.push({ ...x.data, suffix });
    save();
  }
  const seed = await db('business-seed-devices');
  baseline = seed.originalFingerprints;
  seeded = true;
  check(
    'real-rds-business-state-fixture',
    seed.fixtureMode === r.fixtureMode &&
      seed.devices.length === 10 &&
      seed.devices.every((d) => d.lifecycle_status === 'Onboarded'),
  );
  await runBusinessTarget(
    {
      receipt: r,
      held: new Map(),
      token,
      accessToken,
      browserLogin: { username, password },
      cognito,
      credentials,
      baseline,
      api,
      refreshIdentity,
    },
    output,
    { coreOnly: true, readDomains: false },
  );
} catch (e) {
  r.gate = 'FAIL';
  r.failure = {
    code: /^[\w:-]{1,150}$/.test(e.code ?? e.message) ? (e.code ?? e.message) : 'CORE_TARGET_FAILED',
    errorName: e.name,
    causeCode: e.cause?.code,
    httpStatus: e.$metadata?.httpStatusCode,
  };
  save();
} finally {
  if (seeded)
    try {
      const result = await db('cleanup');
      check(
        'original-device-certificate-baseline-preserved',
        JSON.stringify(result.originalFingerprints) === JSON.stringify(baseline),
      );
      r.cleanup.push({ type: 'database-fixtures', count: 10, result: 'PASS' });
      save();
    } catch {
      r.cleanup.push({ type: 'database-fixtures', result: 'FAIL' });
      save();
    }
  if (created)
    try {
      await refreshIdentity();
    } catch {
      r.cleanup.push({ type: 'identity-renewal', result: 'FAIL' });
      save();
    }
  for (const c of [...r.customers].reverse())
    try {
      const path = '/api/v1/admin/customers/' + c.id;
      const current = await api('cleanup-customer-scope-' + c.suffix, 'GET', path, 200);
      check('own-customer-name-' + c.suffix, current.data.name === prefix + '-' + c.suffix);
      await api('cleanup-customer-' + c.suffix, 'DELETE', path, 200, undefined, {
        'If-Match': String(current.data.version),
      });
      await api('verify-customer-gone-' + c.suffix, 'GET', path, 404);
      r.cleanup.push({ type: 'customer', id: c.id, result: 'PASS' });
      save();
    } catch {
      r.cleanup.push({ type: 'customer', id: c.id, result: 'FAIL' });
      save();
    }
  if (created)
    try {
      if (accessToken) {
        try {
          await idp.globalSignOut(accessToken);
          r.globalSignOut = 'PASS';
        } catch (e) {
          r.globalSignOut = 'FAIL';
          r.globalSignOutErrorName = e.name;
          save();
        }
      }
      await call(cognitoSdk.AdminDeleteUserCommand, { UserPoolId: pool, Username: username });
      let absent = false;
      try {
        await call(cognitoSdk.AdminGetUserCommand, { UserPoolId: pool, Username: username });
      } catch (e) {
        absent = e.name === 'UserNotFoundException';
      }
      check('own-superadmin-deleted', absent);
      r.cleanup.push({ type: 'identity', username, result: 'PASS' });
      save();
    } catch {
      r.cleanup.push({ type: 'identity', username, result: 'FAIL' });
      save();
    }
  token = undefined;
  accessToken = undefined;
  r.finishedAt = new Date().toISOString();
  r.gate = r.failure || r.cleanup.some((c) => c.result !== 'PASS') ? 'FAIL' : 'PASS';
  save();
}
let gate = {
  task: 'QA-09',
  scope: 'CORE_BUSINESS_API_FIVE_ROLE_ONLY',
  sourceCommit: r.sourceCommit,
  prefix,
  fullQa09Accepted: false,
  gate: 'FAIL',
};
try {
  const domain = await cleanupOwnedDomain(output + '.fixtures.json', output + '.domain-cleanup.json');
  const child = JSON.parse(readFileSync(output));
  const executed = JSON.parse(readFileSync(output + '.sources.json')).sources;
  const hashes = new Map(
    executed.map((entry) => {
      const digest = createHash('sha256').update(Buffer.from(entry.sourceBase64, 'base64')).digest('hex');
      if (digest !== entry.sha256) throw Error('EXECUTED_SOURCE_BYTES_INVALID');
      return [entry.path, entry.sha256];
    }),
  );
  if (hashes.size !== sourcePaths.length || child.sources.some((entry) => hashes.get(entry.path) !== entry.sha256))
    throw Error('EXECUTED_SOURCE_DRIFT');
  for (const build of r.databaseBuilds) {
    const proof = JSON.parse(readFileSync(build.receipt));
    if (
      proof.gate !== 'PASS' ||
      proof.build.status !== 'SUCCEEDED' ||
      proof.build.id !== build.buildId ||
      proof.build.serviceRole !== 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' ||
      proof.result.prefix !== prefix ||
      proof.result.action !== build.action ||
      proof.result.sourceHash !== hashes.get('scripts/qa09-ten-device-db.mjs')
    )
      throw Error('CORE_FIXTURE_BUILD_NOT_BOUND');
  }
  if (
    domain.parentReceiptSha256 !==
    createHash('sha256')
      .update(readFileSync(output + '.fixtures.json'))
      .digest('hex')
  )
    throw Error('CORE_DOMAIN_CLEANUP_NOT_BOUND');
  validateBusinessDatabaseReceipts(
    child,
    child.databaseBuilds.map((d) => JSON.parse(readFileSync(d.receipt))),
  );
  validateTargetStage(child, 'core', [
    'core-workflows-complete',
    'contract-if-match-race',
    'license-renew',
    'license-state-sequence-proved',
    'license-renew-replay',
    'license-reactivate-renewed',
    'license-revoke',
    'config-publish',
    'device-user-disable',
    'device-user-cross-tenant-no-side-effects',
    'consumable-complete',
    'consumable-cancel',
    'alarm-clear',
  ]);
  for (const role of ROLES) {
    const own = child.checks.find((c) => c.id === role + ':device-scope:0'),
      cross = child.checks.find((c) => c.id === role + ':device-scope:1');
    if (own?.status !== 200 || cross?.status !== (role.startsWith('Customer') ? 403 : 200))
      throw Error('FIVE_ROLE_MATRIX_INCOMPLETE');
  }
  if (r.gate !== 'PASS' || domain.gate !== 'PASS') throw Error('CORE_FIXTURE_CLEANUP_INCOMPLETE');
  gate = {
    ...gate,
    gate: 'PASS',
    checks: child.checks.filter((c) => c.stage === 'core').length,
    cleanup: 'PASS',
    fixtureMode: r.fixtureMode,
    sourceReceipt: output + '.sources.json',
    sourceReceiptSha256: createHash('sha256')
      .update(readFileSync(output + '.sources.json'))
      .digest('hex'),
    remainingCoverage: 'No device authentication, browser, security, load or full QA09 claim from this core-only run',
  };
} catch (e) {
  gate.reason = /^[A-Z_]+$/.test(e.message) ? e.message : 'CORE_TARGET_PROOF_INCOMPLETE';
}
writeFileSync(output + '.gate.json', JSON.stringify(gate, null, 2) + '\n');
console.log(JSON.stringify(gate));
process.exitCode = gate.gate === 'PASS' ? 0 : 1;
