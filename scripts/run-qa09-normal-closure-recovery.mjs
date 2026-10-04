import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as iot from '@aws-sdk/client-iot';
import * as cognito from '@aws-sdk/client-cognito-identity-provider';
import { decodeFixtureFrames } from './qa09-db-log-frames.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
const [parentPath, childPath, output] = process.argv.slice(2);
const parent = JSON.parse(readFileSync(parentPath)),
  child = JSON.parse(readFileSync(childPath));
const base = output.slice(0, output.lastIndexOf('/') + 1);
const hash = (b) => createHash('sha256').update(b).digest('hex');
if (
  !parent.finishedAt ||
  !/^qa09-[a-f0-9]{16}$/.test(parent.prefix) ||
  child.prefix !== parent.prefix ||
  parent.devices.length !== 10 ||
  parent.customers.length !== 2 ||
  !parent.devices.every((d) => new RegExp('^' + parent.prefix + '-[0-9]{2}$').test(d)) ||
  child.site.name !== parent.prefix + '-normal-site-a' ||
  !parent.customers.some((c) => c.id === child.site.customerId)
)
  throw Error('EXACT_NORMAL_RECOVERY_LEDGER_REQUIRED');
const r = {
  task: 'QA-09',
  scope: 'NORMAL_WAVE_EXACT_CLOSURE_RECOVERY',
  prefix: parent.prefix,
  sourceCommit: parent.sourceCommit,
  mode: parent.mode,
  target: parent.target,
  devices: parent.devices,
  customers: parent.customers,
  startedAt: new Date().toISOString(),
  inputs: [parentPath, childPath].map((path) => ({ path, sha256: hash(readFileSync(path)) })),
  sourceBase64: readFileSync(new URL(import.meta.url)).toString('base64'),
  checks: [],
  cleanup: [],
  gate: 'RUNNING',
  fullQa09Accepted: false,
  kmsAndIamManagementPerformed: false,
};
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
const check = (id, ok, data = {}) => {
  r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
  save();
  if (!ok) throw Error('NORMAL_CLOSURE_ASSERTION_FAILED');
};
const aws = (args) => {
  const x = spawnSync(
    'aws',
    [...args, '--profile', 'esgiot-readonly', '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (x.status !== 0) throw Error('READ_ONLY_AWS_FAILED');
  return x.stdout.trim() ? JSON.parse(x.stdout) : {};
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
const region = 'ap-southeast-1',
  pool = 'ap-southeast-1_hZMX8LpFo',
  ci = new cognito.CognitoIdentityProviderClient({ region, credentials, maxAttempts: 1 }),
  ii = new iot.IoTClient({ region, credentials, maxAttempts: 1 });
const call = (client, Cmd, input) => client.send(new Cmd(input), { abortSignal: AbortSignal.timeout(120000) });
const username = 'qa09-' + randomBytes(8).toString('hex') + '-recovery@example.invalid',
  idp = createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' });
let created = false,
  token,
  accessToken;
const api = async (id, method, path, expected, headers = {}) => {
  const res = await fetch('https://api.bio-nexa.com' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...headers },
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => null);
  check(id, res.status === expected, { status: res.status, expected, requestId: res.headers.get('x-amzn-requestid') });
  return body;
};
save();
try {
  check('fixed-account', aws(['sts', 'get-caller-identity']).Account === '065986019555');
  const readbacks = JSON.parse(readFileSync(base + 'normal-cleanup-build-readback.json'));
  for (const [file, action, logfile] of [
    ['normal-slo.json.devices.json.cleanup-4.json', 'cleanup', 'normal-cleanup-cloud-logs.json'],
    ['normal-slo.json.business-audit-4.json', 'business-audit', 'normal-business-audit-cloud-logs.json'],
  ]) {
    const past = JSON.parse(readFileSync(base + file)),
      prep = JSON.parse(readFileSync(base + file + '.preparation.json')),
      logs = JSON.parse(readFileSync(base + logfile));
    const frames = decodeFixtureFrames(logs.events),
      cloud = readbacks.find((x) => x.id === past.build.id);
    check(
      'cloud-build-bound-' + action,
      cloud?.status === 'SUCCEEDED' &&
        frames.length === 1 &&
        frames[0].buildId === past.build.id &&
        frames[0].sourceHash === prep.sourceHash &&
        frames[0].prefix === parent.prefix &&
        frames[0].action === action &&
        frames[0].gate === 'PASS',
    );
    const result = frames[0];
    if (action === 'cleanup') check('ten-database-fixtures-already-deleted', result.deleted.devices === 10);
    else
      check(
        'business-counts-zero-preserved',
        Object.values(result.counts).every((n) => n === 0) &&
          JSON.stringify(result.businessFingerprints) ===
            JSON.stringify(
              JSON.parse(readFileSync(base + 'normal-slo.json.business-baseline-0.json')).result.businessFingerprints,
            ),
      );
    const receipt = base + 'normal-recovered-' + action + '.json';
    writeFileSync(
      receipt,
      JSON.stringify(
        {
          gate: 'PASS',
          build: cloud,
          sourceHash: prep.sourceHash,
          result,
          originalReceipt: base + file,
          originalReceiptSha256: hash(readFileSync(base + file)),
          logSha256: hash(readFileSync(base + logfile)),
        },
        null,
        2,
      ) + '\n',
    );
    r.cleanup.push({
      type: action === 'cleanup' ? 'database-fixtures' : 'business-fixtures',
      ...(action === 'cleanup' ? { count: 10 } : {}),
      receipt,
      result: 'PASS',
    });
    save();
  }
  const observed = JSON.parse(readFileSync(base + 'normal-slo.json.devices.json.observe-3.json')).result;
  for (const cert of observed.certificates) {
    check('certificate-scope-' + cert.id, parent.devices.includes(cert.device_id));
    const absent = await call(ii, iot.DescribeCertificateCommand, { certificateId: cert.id }).then(
      () => false,
      (e) => e.name === 'ResourceNotFoundException',
    );
    check('certificate-absent-' + cert.id, absent);
    r.cleanup.push({ type: 'iot-certificate', id: cert.id, result: 'PASS' });
  }
  check('certificate-ledger-ten', observed.certificates.length === 10);
  for (const id of parent.devices) {
    const absent = await call(ii, iot.DescribeThingCommand, { thingName: id }).then(
      () => false,
      (e) => e.name === 'ResourceNotFoundException',
    );
    check('thing-absent-' + id, absent);
    r.cleanup.push({ type: 'iot-thing', id, result: 'PASS' });
  }
  for (const c of parent.customers)
    for (const type of ['heartbeat', 'telemetry', 'ack']) {
      const v = aws([
        's3api',
        'list-object-versions',
        '--bucket',
        'fdp-test-raw-065986019555',
        '--prefix',
        `raw/topic_type=${type}/customer_id=${c.id}/`,
        '--max-keys',
        '1',
        '--no-paginate',
      ]);
      check('raw-empty-' + c.suffix + '-' + type, !v.IsTruncated && !v.Versions?.length && !v.DeleteMarkers?.length);
    }
  r.cleanup.push({ type: 'archive-batch-owned-prefix', result: 'PASS' });
  const temporary = 'A!z9' + randomBytes(24).toString('base64url'),
    password = 'A!z9' + randomBytes(24).toString('base64url');
  await call(ci, cognito.AdminCreateUserCommand, {
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
  r.recoveryIdentity = { username };
  save();
  await call(ci, cognito.AdminAddUserToGroupCommand, {
    UserPoolId: pool,
    Username: username,
    GroupName: 'PlatformSuperAdmin',
  });
  const flow = new AuthFlow({ idp, userPoolId: pool, sessionManager: { establish() {} } });
  check('first-challenge', (await flow.login(username, temporary)).status === 'new-password-required');
  const auth = await flow.submitNewPassword(password);
  check('actual-srp', auth.status === 'authenticated');
  token = auth.session.idToken;
  accessToken = auth.session.accessToken;
  const path = '/api/v1/admin/sites/' + child.site.id;
  const found = await fetch('https://api.bio-nexa.com' + path, {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(30000),
  });
  const body = await found.json();
  check('site-owned-or-absent', [200, 404].includes(found.status));
  if (found.status === 200) {
    check('site-exact-ledger', body.data.name === child.site.name && body.data.customerId === child.site.customerId);
    await api('site-delete', 'DELETE', path, 200, { 'If-Match': String(body.data.version) });
  }
  await api('site-absent', 'GET', path, 404);
  r.cleanup.push({ type: 'site', id: child.site.id, result: 'PASS' });
  for (const c of parent.customers) {
    await api('customer-absent-' + c.suffix, 'GET', '/api/v1/admin/customers/' + c.id, 404);
    r.cleanup.push({ type: 'customer', id: c.id, result: 'PASS' });
  }
  const old = parent.identity.username;
  check('identity-owned', old.startsWith(parent.prefix + '-') && old.endsWith('@example.invalid'));
  check(
    'identity-absent',
    await call(ci, cognito.AdminGetUserCommand, { UserPoolId: pool, Username: old }).then(
      () => false,
      (e) => e.name === 'UserNotFoundException',
    ),
  );
  r.cleanup.push({ type: 'identity', username: old, result: 'PASS' });
  const auditPath = output + '.audit-empty.json';
  const audit = await runFixture(
    {
      prefix: parent.prefix,
      devices: parent.devices,
      customers: parent.customers,
      action: 'audit-empty',
      baseline: observed.originalFingerprints,
    },
    auditPath,
    console.log,
  );
  check(
    'original-baseline-and-empty',
    audit.result.empty === true &&
      JSON.stringify(audit.result.originalFingerprints) === JSON.stringify(observed.originalFingerprints),
  );
  r.auditReceipt = auditPath;
  r.gate = 'PASS';
} catch (e) {
  r.gate = 'FAIL';
  r.failure = { name: e.name, code: e.code ?? (/^[A-Z_]+$/.test(e.message) ? e.message : 'NORMAL_CLOSURE_FAILED') };
} finally {
  if (created)
    try {
      if (accessToken) await idp.globalSignOut(accessToken);
      await call(ci, cognito.AdminDeleteUserCommand, { UserPoolId: pool, Username: username });
      check(
        'recovery-identity-absent',
        await call(ci, cognito.AdminGetUserCommand, { UserPoolId: pool, Username: username }).then(
          () => false,
          (e) => e.name === 'UserNotFoundException',
        ),
      );
      r.cleanup.push({ type: 'recovery-identity', username, result: 'PASS' });
    } catch (e) {
      r.gate = 'FAIL';
      r.cleanup.push({ type: 'recovery-identity', username, result: 'FAIL', name: e.name });
    }
  r.finishedAt = new Date().toISOString();
  save();
}
if (r.gate === 'PASS') {
  try {
    r.domain = await cleanupOwnedDomain(output, output + '.domain-cleanup.json');
    r.domainGate = r.domain.gate;
    r.parentGate = 'PASS';
  } catch {
    r.gate = 'FAIL';
    r.domainGate = 'FAIL';
  }
}
save();
console.log(JSON.stringify({ gate: r.gate, domainGate: r.domainGate, checks: r.checks.length, failure: r.failure }));
process.exitCode = r.gate === 'PASS' && r.domainGate === 'PASS' ? 0 : 1;
