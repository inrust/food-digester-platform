import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
const [coreFile, auditFile, output] = process.argv.slice(2);
const coreBytes = readFileSync(coreFile),
  core = JSON.parse(coreBytes),
  parentBytes = readFileSync(coreFile + '.fixtures.json'),
  parent = JSON.parse(parentBytes),
  auditBytes = readFileSync(auditFile),
  audit = JSON.parse(auditBytes);
const sha = (v) => createHash('sha256').update(v).digest('hex');
if (
  core.mode !== 'REAL_EXISTING_TEST_ENVIRONMENT' ||
  !core.coreOnly ||
  core.stages.core !== 'PASS' ||
  !core.finishedAt ||
  !parent.finishedAt ||
  parent.prefix !== core.prefix ||
  parent.fixtureMode !== 'REAL_RDS_ONBOARDED_STATE_FOR_BUSINESS_APIS_NO_DEVICE_AUTH_CLAIM' ||
  parent.cleanup.some((c) => c.result !== 'PASS') ||
  !parent.cleanup.some((c) => c.type === 'database-fixtures' && c.count === 10) ||
  parent.cleanup.filter((c) => c.type === 'customer').length !== 2 ||
  !parent.cleanup.some((c) => c.type === 'identity') ||
  core.createdSites.length !== 2 ||
  audit.gate !== 'PASS' ||
  audit.build.status !== 'SUCCEEDED' ||
  audit.result.action !== 'business-audit' ||
  audit.result.prefix !== core.prefix ||
  audit.sourceHash !== core.sourceHashes['scripts/qa09-ten-device-db.mjs'] ||
  Object.values(audit.result.counts).some((n) => n !== 0)
)
  throw Error('COMPLETED_CORE_AND_AUDIT_LEDGER_REQUIRED');
const baselineFile = core.databaseBuilds.find((b) => b.action === 'business-baseline').receipt;
if (
  JSON.stringify(audit.result.businessFingerprints) !==
  JSON.stringify(JSON.parse(readFileSync(baselineFile)).result.businessFingerprints)
)
  throw Error('BUSINESS_BASELINE_DRIFT');
const prefix = core.prefix,
  pool = 'ap-southeast-1_hZMX8LpFo',
  region = 'ap-southeast-1',
  authPrefix = 'qa09-' + randomBytes(8).toString('hex'),
  username = authPrefix + '-platformsuperadmin@example.invalid';
const r = {
  task: 'QA-09',
  scope: 'CORE_CLEANUP_RECOVERY',
  mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
  target: parent.target,
  prefix,
  devices: parent.devices,
  customers: parent.customers,
  coreReceipt: coreFile,
  coreReceiptSha256: sha(coreBytes),
  parentReceipt: coreFile + '.fixtures.json',
  parentReceiptSha256: sha(parentBytes),
  auditReceipt: auditFile,
  auditReceiptSha256: sha(auditBytes),
  originalExecutionGate: core.gate,
  originalCleanupComplete: core.cleanupComplete,
  cleanupRecovered: true,
  startedAt: new Date().toISOString(),
  checks: [],
  cleanup: [...parent.cleanup],
  gate: 'RUNNING',
  fullQa09Accepted: false,
  credentialsExported: false,
  passwordChanged: false,
  recoveryIdentity: { username, authPrefix },
  sourceHash: sha(readFileSync(new URL(import.meta.url))),
  sourceBase64: readFileSync(new URL(import.meta.url)).toString('base64'),
  domainCleanupReceipt: output + '.domain-cleanup.json',
};
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
const check = (id, ok, data = {}) => {
  r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
  save();
  if (!ok) throw Error('CORE_RECOVERY_ASSERTION_FAILED');
};
let cached;
const credentials = async () => {
  if (!cached || cached.expiration.getTime() < Date.now() + 300000) {
    const out = spawnSync(
      'aws',
      ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'],
      { encoding: 'utf8', timeout: 30000 },
    );
    if (out.status !== 0) throw Error('SSO_CREDENTIALS_UNAVAILABLE');
    const v = JSON.parse(out.stdout);
    cached = {
      accessKeyId: v.AccessKeyId,
      secretAccessKey: v.SecretAccessKey,
      sessionToken: v.SessionToken,
      expiration: new Date(v.Expiration),
    };
  }
  return cached;
};
const cognito = new cognitoSdk.CognitoIdentityProviderClient({ region, credentials, maxAttempts: 1 }),
  idp = createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' });
const call = (Cmd, input) => cognito.send(new Cmd(input), { abortSignal: AbortSignal.timeout(20000) });
let created = false,
  token,
  accessToken;
async function api(id, method, path, expected, headers = {}) {
  const response = await fetch('https://api.bio-nexa.com' + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json().catch(() => null);
  check(id, response.status === expected, {
    method,
    path,
    status: response.status,
    requestId: body?.meta?.requestId ?? body?.error?.requestId,
  });
  return body;
}
save();
try {
  const identity = spawnSync(
    'aws',
    ['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--region', region, '--output', 'json'],
    { encoding: 'utf8', timeout: 30000 },
  );
  check('fixed-account', identity.status === 0 && JSON.parse(identity.stdout).Account === '065986019555');
  const temporary = `A!z9${randomBytes(24).toString('base64url')}`,
    password = `A!z9${randomBytes(24).toString('base64url')}`;
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
  await call(cognitoSdk.AdminAddUserToGroupCommand, {
    UserPoolId: pool,
    Username: username,
    GroupName: 'PlatformSuperAdmin',
  });
  const flow = new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } });
  check('first-login-challenge', (await flow.login(username, temporary)).status === 'new-password-required');
  const auth = await flow.submitNewPassword(password);
  check('actual-srp', auth.status === 'authenticated');
  token = auth.session.idToken;
  accessToken = auth.session.accessToken;
  for (const [i, site] of core.createdSites.entries()) {
    check('site-ledger-' + i, /^[a-f0-9-]{36}$/.test(site.id) && site.customerId === parent.customers[i].id);
    const path = '/api/v1/admin/sites/' + site.id,
      found = await api('site-read-' + i, 'GET', path, 200);
    check(
      'site-scope-' + i,
      found.data.name === `${prefix}-site-${i === 0 ? 'a' : 'b'}` && found.data.customerId === site.customerId,
    );
    await api('site-delete-' + i, 'DELETE', path, 200, { 'If-Match': String(found.data.version) });
    await api('site-absent-' + i, 'GET', path, 404);
    r.cleanup.push({ type: 'site', id: site.id, result: 'PASS' });
    save();
  }
  for (const c of parent.customers)
    await api('customer-still-absent-' + c.suffix, 'GET', '/api/v1/admin/customers/' + c.id, 404);
  for (const own of [...core.createdIdentities, { username: parent.identity.username }]) {
    check(
      'identity-namespace-' + own.username,
      own.username.startsWith(prefix + '-') && own.username.endsWith('@example.invalid'),
    );
    let absent = false;
    try {
      await call(cognitoSdk.AdminGetUserCommand, { UserPoolId: pool, Username: own.username });
    } catch (e) {
      absent = e.name === 'UserNotFoundException';
    }
    check('identity-absent-' + own.username, absent);
  }
  r.gate = 'PASS';
} catch (e) {
  r.gate = 'FAIL';
  r.errorCode = e.code ?? 'CORE_RECOVERY_FAILED';
  r.errorName = e.name;
  r.causeCode = e.cause?.code;
} finally {
  if (created)
    try {
      if (accessToken)
        try {
          await idp.globalSignOut(accessToken);
          r.globalSignOut = 'PASS';
        } catch {
          r.globalSignOut = 'FAIL';
        }
      await call(cognitoSdk.AdminDeleteUserCommand, { UserPoolId: pool, Username: username });
      let absent = false;
      try {
        await call(cognitoSdk.AdminGetUserCommand, { UserPoolId: pool, Username: username });
      } catch (e) {
        absent = e.name === 'UserNotFoundException';
      }
      check('recovery-identity-absent', absent);
      r.cleanup.push({ type: 'recovery-identity', username, result: 'PASS' });
    } catch (e) {
      r.gate = 'FAIL';
      r.cleanup.push({ type: 'recovery-identity', username, result: 'FAIL', errorName: e.name });
    }
  token = undefined;
  accessToken = undefined;
  cached = undefined;
  r.finishedAt = new Date().toISOString();
  save();
}
let domain;
if (r.gate === 'PASS') domain = await cleanupOwnedDomain(output, r.domainCleanupReceipt);
console.log(JSON.stringify({ gate: r.gate, domainGate: domain?.gate, checks: r.checks.length, prefix }));
process.exitCode = r.gate === 'PASS' && domain?.gate === 'PASS' ? 0 : 1;
