import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as iotSdk from '@aws-sdk/client-iot';
import * as cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { assertBusinessContext } from './qa09-business-target.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { assertOwnCloudDevice } from './qa09-ten-device-db.mjs';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
const [parentFile, output] = process.argv.slice(2);
if (!parentFile || !output) throw Error('PARENT_AND_OUTPUT_REQUIRED');
const bytes = readFileSync(parentFile),
  parent = JSON.parse(bytes);
assertBusinessContext(parent);
if (
  !parent.finishedAt ||
  parent.mode !== 'REAL_EXISTING_TEST_ENVIRONMENT' ||
  parent.target?.accountId !== '065986019555' ||
  parent.target.region !== 'ap-southeast-1'
)
  throw Error('FINISHED_OWN_RUN_REQUIRED');
const seed = JSON.parse(readFileSync(parent.databaseBuilds.find((d) => d.action === 'seed').receipt));
if (seed.gate !== 'PASS' || seed.result.prefix !== parent.prefix) throw Error('OWN_SEED_BASELINE_REQUIRED');
const baseline = seed.result.originalFingerprints,
  prefix = parent.prefix,
  devices = parent.devices,
  customers = parent.customers;
const authPrefix = 'qa09-' + randomBytes(8).toString('hex'),
  username = authPrefix + '-platformsuperadmin@example.invalid',
  pool = 'ap-southeast-1_hZMX8LpFo';
const r = {
  task: 'QA-09',
  scope: 'RECOVER_EXACT_FAILED_RUN_OWN_FIXTURES',
  mode: parent.mode,
  target: parent.target,
  prefix,
  devices,
  customers,
  parentReceipt: parentFile,
  parentReceiptSha256: createHash('sha256').update(bytes).digest('hex'),
  startedAt: new Date().toISOString(),
  gate: 'RUNNING',
  checks: [],
  cleanup: [],
  databaseBuilds: [],
  recoveryIdentity: { username, authPrefix },
  sourceHashes: {},
  credentialsExported: false,
  fullQa09Accepted: false,
};
r.sources = [];
for (const path of [
  'scripts/recover-qa09-owned-fixtures.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'scripts/qa09-ten-device-db.mjs',
  'scripts/qa09-db-log-frames.mjs',
  'scripts/qa09-db-frame-wait.mjs',
]) {
  const bytes = readFileSync(path);
  r.sourceHashes[path] = createHash('sha256').update(bytes).digest('hex');
  r.sources.push({ path, sha256: r.sourceHashes[path], sourceBase64: bytes.toString('base64') });
}
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
const check = (id, ok, data = {}) => {
  r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
  save();
  if (!ok) throw Error('OWN_RECOVERY_ASSERTION_FAILED');
};
let cached;
const credentials = async () => {
  if (!cached || cached.expiration.getTime() < Date.now() + 300000) {
    const x = spawnSync(
      'aws',
      ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'],
      { encoding: 'utf8', timeout: 30000 },
    );
    if (x.status !== 0) throw Error('SSO_CREDENTIALS_UNAVAILABLE');
    const v = JSON.parse(x.stdout);
    cached = {
      accessKeyId: v.AccessKeyId,
      secretAccessKey: v.SecretAccessKey,
      sessionToken: v.SessionToken,
      expiration: new Date(v.Expiration),
    };
  }
  return cached;
};
const iot = new iotSdk.IoTClient({ region: 'ap-southeast-1', credentials, maxAttempts: 1 }),
  cognito = new cognitoSdk.CognitoIdentityProviderClient({ region: 'ap-southeast-1', credentials, maxAttempts: 1 });
const call = (client, Cmd, input) => client.send(new Cmd(input), { abortSignal: AbortSignal.timeout(30000) });
const idp = createCognitoIdpClient({ region: 'ap-southeast-1', clientId: '5ljdjsf9g563mc1vdc7vjdjm09' });
let created = false,
  token,
  accessToken;
async function db(action) {
  const path = output + '.' + action + '.json';
  const x = await runFixture({ prefix, devices, customers, action, baseline }, path, (p) => console.log(p));
  r.databaseBuilds.push({ action, receipt: path, buildId: x.build.id });
  save();
  return x.result;
}
async function api(id, method, path, expected, body, headers = {}) {
  const res = await fetch('https://api.bio-nexa.com' + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const v = await res.json().catch(() => null);
  check(id, [].concat(expected).includes(res.status), {
    method,
    path,
    status: res.status,
    requestId: v?.meta?.requestId ?? v?.error?.requestId ?? res.headers.get('x-amzn-requestid'),
  });
  return { status: res.status, body: v };
}
save();
try {
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
  const current = await db('observe');
  check('exact-ten-records-and-certificates', current.devices.length === 10 && current.certificates.length === 10);
  for (const cert of current.certificates) {
    assertOwnCloudDevice(cert.device_id, prefix);
    const principal = `arn:aws:iot:ap-southeast-1:065986019555:cert/${cert.id}`;
    const linked = await call(iot, iotSdk.ListPrincipalThingsCommand, { principal });
    if ((linked.things ?? []).some((id) => id !== cert.device_id)) throw Error('CERTIFICATE_SCOPE_DRIFT');
    await call(iot, iotSdk.UpdateCertificateCommand, { certificateId: cert.id, newStatus: 'INACTIVE' });
    for (const thing of linked.things ?? [])
      await call(iot, iotSdk.DetachThingPrincipalCommand, { thingName: thing, principal });
    const policies = await call(iot, iotSdk.ListAttachedPoliciesCommand, { target: principal });
    for (const p of policies.policies ?? []) {
      if (p.policyName !== 'fdp-device-' + cert.device_id) throw Error('POLICY_SCOPE_DRIFT');
      await call(iot, iotSdk.DetachPolicyCommand, { policyName: p.policyName, target: principal });
      await call(iot, iotSdk.DeletePolicyCommand, { policyName: p.policyName });
    }
    await call(iot, iotSdk.DeleteCertificateCommand, { certificateId: cert.id });
    r.cleanup.push({ type: 'iot-certificate', id: cert.id, result: 'PASS' });
    save();
  }
  for (const id of devices) {
    await call(iot, iotSdk.DeleteThingCommand, { thingName: id });
    r.cleanup.push({ type: 'iot-thing', id, result: 'PASS' });
    save();
  }
  const cleaned = await db('cleanup');
  check(
    'original-device-certificate-baseline-preserved',
    JSON.stringify(cleaned.originalFingerprints) === JSON.stringify(baseline),
  );
  r.cleanup.push({ type: 'database-fixtures', count: 10, result: 'PASS' });
  save();
  const temporary = `A!z9${randomBytes(24).toString('base64url')}`,
    password = `A!z9${randomBytes(24).toString('base64url')}`;
  await call(cognito, cognitoSdk.AdminCreateUserCommand, {
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
  save();
  await call(cognito, cognitoSdk.AdminAddUserToGroupCommand, {
    UserPoolId: pool,
    Username: username,
    GroupName: 'PlatformSuperAdmin',
  });
  const flow = new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } });
  check('recovery-first-login', (await flow.login(username, temporary)).status === 'new-password-required');
  const auth = await flow.submitNewPassword(password);
  check('recovery-real-srp', auth.status === 'authenticated');
  token = auth.session.idToken;
  accessToken = auth.session.accessToken;
  for (const c of [...customers].reverse()) {
    const path = '/api/v1/admin/customers/' + c.id;
    const found = await api('scope-' + c.suffix, 'GET', path, [200, 404]);
    if (found.status === 200) {
      check('own-name-' + c.suffix, found.body.data.name === prefix + '-' + c.suffix);
      await api('delete-' + c.suffix, 'DELETE', path, 200, undefined, { 'If-Match': String(found.body.data.version) });
      await api('absent-' + c.suffix, 'GET', path, 404);
    }
    r.cleanup.push({ type: 'customer', id: c.id, result: 'PASS' });
    save();
  }
  r.gate = 'PASS';
} catch (e) {
  r.gate = 'FAIL';
  r.failure = /^[A-Z_]+$/.test(e.message) ? e.message : 'OWN_FIXTURE_RECOVERY_FAILED';
} finally {
  if (created)
    try {
      if (accessToken) await idp.globalSignOut(accessToken);
      await call(cognito, cognitoSdk.AdminDeleteUserCommand, { UserPoolId: pool, Username: username });
      let absent = false;
      try {
        await call(cognito, cognitoSdk.AdminGetUserCommand, { UserPoolId: pool, Username: username });
      } catch (e) {
        absent = e.name === 'UserNotFoundException';
      }
      check('recovery-identity-absent', absent);
      r.cleanup.push({ type: 'identity', username, result: 'PASS' });
    } catch {
      r.gate = 'FAIL';
      r.cleanup.push({ type: 'identity', username, result: 'FAIL' });
    }
  token = undefined;
  accessToken = undefined;
  cached = undefined;
  r.finishedAt = new Date().toISOString();
  r.domainCleanupReceipt = output + '.domain-cleanup.json';
  save();
}
if (r.gate === 'PASS') {
  const domain = await cleanupOwnedDomain(output, output + '.domain-cleanup.json');
  if (domain.gate !== 'PASS') process.exitCode = 1;
}
console.log(JSON.stringify({ gate: r.gate, prefix, cleanup: r.cleanup.length, failure: r.failure }));
process.exitCode = r.gate === 'PASS' ? (process.exitCode ?? 0) : 1;
