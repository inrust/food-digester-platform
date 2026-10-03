import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as iotSdk from '@aws-sdk/client-iot';
import * as s3Sdk from '@aws-sdk/client-s3';
import * as cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { assertOwnCloudDevice } from './qa09-ten-device-db.mjs';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { cleanupOwnedDomain } from './qa09-owned-domain-cleanup.mjs';
const [parentFile, recoveredFile, childFile, output, resumeFile, verifiedPartialFile] = process.argv.slice(2);
const parent = JSON.parse(readFileSync(parentFile)),
  recovered = JSON.parse(readFileSync(recoveredFile)),
  child = JSON.parse(readFileSync(childFile));
const frame = recovered.result;
if (
  !parent.finishedAt ||
  !child.cleanupComplete ||
  child.prefix !== parent.prefix ||
  recovered.gate !== 'PASS' ||
  frame.action !== 'observe' ||
  frame.prefix !== parent.prefix ||
  frame.certificates.length !== 10 ||
  frame.devices.length !== 10
)
  throw Error('COMPLETED_OWN_RECOVERY_LEDGER_REQUIRED');
const frozen = JSON.parse(readFileSync(childFile + '.sources.json')).sources.find(
  (x) => x.path === 'scripts/qa09-ten-device-db.mjs',
);
if (
  frame.sourceHash !== frozen?.sha256 ||
  frame.buildId !== recovered.build.id ||
  recovered.build.status !== 'SUCCEEDED' ||
  recovered.sourceHash !== frame.sourceHash
)
  throw Error('FROZEN_SOURCE_BUILD_BINDING_REQUIRED');
for (const cert of frame.certificates) assertOwnCloudDevice(cert.device_id, parent.prefix);
const r = {
  task: 'QA-09',
  scope: 'PERFORMANCE_FIXTURE_CLEANUP_RECOVERY',
  mode: parent.mode,
  target: parent.target,
  prefix: parent.prefix,
  devices: parent.devices,
  customers: parent.customers,
  startedAt: new Date().toISOString(),
  inputs: [parentFile, recoveredFile, childFile].map((path) => ({
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  })),
  sourceBase64: readFileSync(new URL(import.meta.url)).toString('base64'),
  cleanup: [],
  checks: [],
  databaseBuilds: [],
  gate: 'RUNNING',
  fullQa09Accepted: false,
  originalExecutionGate: parent.gate,
};
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
save();
const resume = resumeFile ? JSON.parse(readFileSync(resumeFile)) : null;
if (
  resume &&
  (resume.gate !== 'PASS' ||
    resume.result?.prefix !== parent.prefix ||
    resume.result?.action !== 'cleanup' ||
    resume.result?.deleted?.devices !== 10 ||
    JSON.stringify(resume.result.originalFingerprints) !== JSON.stringify(frame.originalFingerprints))
)
  throw Error('RESUME_CLEANUP_PROOF_REQUIRED');
const verifiedPartial = verifiedPartialFile ? JSON.parse(readFileSync(verifiedPartialFile)) : null;
if (
  verifiedPartial &&
  (verifiedPartial.prefix !== parent.prefix ||
    verifiedPartial.cleanup.length !== 21 ||
    verifiedPartial.cleanup.some((x) => x.result !== 'PASS') ||
    verifiedPartial.cleanup.filter((x) => x.type === 'iot-certificate').length !== 10 ||
    verifiedPartial.cleanup.filter((x) => x.type === 'iot-thing').length !== 10)
)
  throw Error('VERIFIED_PARTIAL_CLEANUP_REQUIRED');
if (verifiedPartialFile)
  r.verifiedPartial = {
    path: verifiedPartialFile,
    sha256: createHash('sha256').update(readFileSync(verifiedPartialFile)).digest('hex'),
  };
if (resumeFile)
  r.resumeCleanup = { path: resumeFile, sha256: createHash('sha256').update(readFileSync(resumeFile)).digest('hex') };
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
  iot = new iotSdk.IoTClient({ region, credentials, maxAttempts: 1 }),
  s3 = new s3Sdk.S3Client({ region, credentials, maxAttempts: 1, forcePathStyle: true }),
  cognito = new cognitoSdk.CognitoIdentityProviderClient({ region, credentials, maxAttempts: 1 });
const call = (client, Cmd, input) => {
  if (client !== s3) return client.send(new Cmd(input), { abortSignal: AbortSignal.timeout(120000) });
  const action =
    Cmd === s3Sdk.ListObjectVersionsCommand
      ? 'list-object-versions'
      : Cmd === s3Sdk.DeleteObjectsCommand
        ? 'delete-objects'
        : null;
  if (!action) throw Error('FIXED_S3_ACTION_REQUIRED');
  const dir = mkdtempSync(join(tmpdir(), 'qa09-s3-cleanup-'));
  try {
    const file = join(dir, 'input.json');
    writeFileSync(file, JSON.stringify(input));
    const x = spawnSync(
      'aws',
      [
        's3api',
        action,
        '--cli-input-json',
        'file://' + file,
        '--profile',
        action === 'list-object-versions' ? 'esgiot-readonly' : 'esgiot-infra',
        '--region',
        region,
        '--output',
        'json',
        '--no-cli-pager',
        '--no-paginate',
        '--cli-connect-timeout',
        '5',
        '--cli-read-timeout',
        '60',
      ],
      {
        encoding: 'utf8',
        timeout: 150000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, AWS_MAX_ATTEMPTS: action === 'list-object-versions' ? '3' : '1' },
      },
    );
    if (x.status !== 0)
      throw Object.assign(Error('S3_CLI_FAILED'), {
        code:
          x.stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] ??
          (x.error?.code === 'ETIMEDOUT' ? 'S3_CLI_TRANSFER_TIMEOUT' : 'S3_CLI_FAILED'),
        cliExitCode: x.status,
        cliSignal: x.signal,
        safeErrorClass:
          [
            'Invalid JSON',
            'Invalid type',
            'Read timeout',
            'Could not connect',
            'SSL validation',
            'No such file',
            'Unknown options',
          ].find((t) => x.stderr?.includes(t)) ?? 'UNCLASSIFIED',
        action,
        safeStderr: x.stderr?.replace(/https?:\/\/\S+/g, '[endpoint]').slice(0, 300),
      });
    return JSON.parse(x.stdout);
  } finally {
    rmSync(dir, { recursive: true });
  }
};
const pool = 'ap-southeast-1_hZMX8LpFo',
  clientId = '5ljdjsf9g563mc1vdc7vjdjm09',
  username = 'qa09-' + randomBytes(8).toString('hex') + '-recovery@example.invalid',
  idp = createCognitoIdpClient({ region, clientId });
let created = false,
  token,
  accessToken;
const check = (id, ok, data = {}) => {
  r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
  save();
  if (!ok) throw Error('RECOVERY_ASSERTION_FAILED');
};
async function api(id, method, path, expected, headers = {}) {
  const res = await fetch('https://api.bio-nexa.com' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...headers },
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => null);
  check(id, res.status === expected, { status: res.status, expected, requestId: res.headers.get('x-amzn-requestid') });
  return body;
}
async function db(action) {
  const p = output + '.' + action + '.json';
  const v = await runFixture(
    { prefix: r.prefix, devices: r.devices, customers: r.customers, action, baseline: frame.originalFingerprints },
    p,
    console.log,
  );
  r.databaseBuilds.push({ action, receipt: p, buildId: v.build.id });
  save();
  return v.result;
}
try {
  if (!resume) {
    for (const cert of frame.certificates) {
      const arn = `arn:aws:iot:${region}:065986019555:cert/${cert.id}`;
      const things = await call(iot, iotSdk.ListPrincipalThingsCommand, { principal: arn });
      check(
        'certificate-own-things-' + cert.id,
        (things.things ?? []).every((x) => r.devices.includes(x)),
      );
      await call(iot, iotSdk.UpdateCertificateCommand, { certificateId: cert.id, newStatus: 'INACTIVE' });
      for (const thing of things.things ?? [])
        await call(iot, iotSdk.DetachThingPrincipalCommand, { thingName: thing, principal: arn });
      const policies = await call(iot, iotSdk.ListAttachedPoliciesCommand, { target: arn });
      check(
        'certificate-own-policies-' + cert.id,
        (policies.policies ?? []).every((x) => x.policyName === 'fdp-device-' + cert.device_id),
      );
      for (const p of policies.policies ?? []) {
        await call(iot, iotSdk.DetachPolicyCommand, { policyName: p.policyName, target: arn });
        await call(iot, iotSdk.DeletePolicyCommand, { policyName: p.policyName });
      }
      await call(iot, iotSdk.DeleteCertificateCommand, { certificateId: cert.id });
      r.cleanup.push({ type: 'iot-certificate', id: cert.id, result: 'PASS' });
      save();
    }
    for (const id of r.devices) {
      await call(iot, iotSdk.DeleteThingCommand, { thingName: id });
      r.cleanup.push({ type: 'iot-thing', id, result: 'PASS' });
      save();
    }
    const cleared = await db('cleanup');
    check('ten-database-fixtures-deleted', cleared.deleted.devices === 10);
    r.cleanup.push({ type: 'database-fixtures', count: 10, result: 'PASS' });
    save();
  } else if (verifiedPartial) {
    r.cleanup = verifiedPartial.cleanup;
    r.databaseBuilds.push({ action: 'cleanup', receipt: resumeFile, buildId: resume.build.id });
    save();
  } else {
    for (const cert of frame.certificates) {
      const absent = await call(iot, iotSdk.DescribeCertificateCommand, { certificateId: cert.id }).then(
        () => false,
        (e) => e.name === 'ResourceNotFoundException',
      );
      check('certificate-absent-' + cert.id, absent);
      r.cleanup.push({ type: 'iot-certificate', id: cert.id, result: 'PASS' });
    }
    for (const id of r.devices) {
      const absent = await call(iot, iotSdk.DescribeThingCommand, { thingName: id }).then(
        () => false,
        (e) => e.name === 'ResourceNotFoundException',
      );
      check('thing-absent-' + id, absent);
      r.cleanup.push({ type: 'iot-thing', id, result: 'PASS' });
    }
    r.cleanup.push({ type: 'database-fixtures', count: 10, result: 'PASS' });
    r.databaseBuilds.push({ action: 'cleanup', receipt: resumeFile, buildId: resume.build.id });
    save();
  }
  const owned = [];
  for (const c of r.customers)
    for (const type of ['heartbeat', 'telemetry', 'ack']) {
      const prefix = `raw/topic_type=${type}/customer_id=${c.id}/`;
      let key, version;
      do {
        const page = await call(s3, s3Sdk.ListObjectVersionsCommand, {
          Bucket: 'fdp-test-raw-065986019555',
          Prefix: prefix,
          MaxKeys: 20,
          KeyMarker: key,
          ...(version ? { VersionIdMarker: version } : {}),
        });
        for (const v of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
          if (!v.Key.startsWith(prefix)) throw Error('ARCHIVE_SCOPE_DRIFT');
          owned.push({ Key: v.Key, VersionId: v.VersionId });
        }
        key = page.IsTruncated ? page.NextKeyMarker : undefined;
        version = page.NextVersionIdMarker;
      } while (key);
    }
  for (let i = 0; i < owned.length; i += 400) {
    const v = await call(s3, s3Sdk.DeleteObjectsCommand, {
      Bucket: 'fdp-test-raw-065986019555',
      Delete: { Objects: owned.slice(i, i + 400), Quiet: false },
    });
    check('raw-delete-batch-' + i, !v.Errors?.length && v.Deleted?.length === owned.slice(i, i + 400).length);
  }
  for (const c of r.customers)
    for (const type of ['heartbeat', 'telemetry', 'ack']) {
      const v = await call(s3, s3Sdk.ListObjectVersionsCommand, {
        Bucket: 'fdp-test-raw-065986019555',
        Prefix: `raw/topic_type=${type}/customer_id=${c.id}/`,
      });
      check('raw-absent-' + c.suffix + '-' + type, !v.Versions?.length && !v.DeleteMarkers?.length && !v.IsTruncated);
    }
  r.cleanup.push({ type: 'archive-batch-owned-prefix', count: owned.length, result: 'PASS' });
  save();
  const temporary = 'A!z9' + randomBytes(24).toString('base64url'),
    password = 'A!z9' + randomBytes(24).toString('base64url');
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
  r.recoveryIdentity = { username };
  save();
  await call(cognito, cognitoSdk.AdminAddUserToGroupCommand, {
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
  for (const c of r.customers) {
    const p = '/api/v1/admin/customers/' + c.id;
    const current = await api('customer-scope-' + c.suffix, 'GET', p, 200);
    check('customer-own-name-' + c.suffix, current.data.name === c.name);
    await api('customer-delete-' + c.suffix, 'DELETE', p, 200, { 'If-Match': String(current.data.version) });
    await api('customer-absent-' + c.suffix, 'GET', p, 404);
    r.cleanup.push({ type: 'customer', id: c.id, result: 'PASS' });
    save();
  }
  const audit = await db('audit-empty');
  check(
    'independent-empty-original-preserved',
    audit.empty === true && JSON.stringify(audit.originalFingerprints) === JSON.stringify(frame.originalFingerprints),
  );
  r.gate = 'PASS';
} catch (e) {
  r.gate = 'FAIL';
  r.failure = {
    name: e.name,
    code: e.Code ?? e.code ?? (/^[A-Z_]+$/.test(e.message) ? e.message : 'RECOVERY_FAILED'),
    requestId: e.$metadata?.requestId,
    cliExitCode: e.cliExitCode,
    cliSignal: e.cliSignal,
    safeErrorClass: e.safeErrorClass,
    action: e.action,
    safeStderr: e.safeStderr,
  };
} finally {
  if (created)
    try {
      if (accessToken) await idp.globalSignOut(accessToken);
      await call(cognito, cognitoSdk.AdminDeleteUserCommand, { UserPoolId: pool, Username: username });
      const absent = await call(cognito, cognitoSdk.AdminGetUserCommand, { UserPoolId: pool, Username: username }).then(
        () => false,
        (e) => e.name === 'UserNotFoundException',
      );
      check('recovery-identity-absent', absent);
      r.cleanup.push({ type: 'recovery-identity', username, result: 'PASS' });
    } catch (e) {
      r.gate = 'FAIL';
      r.cleanup.push({ type: 'recovery-identity', username, result: 'FAIL', name: e.name });
    }
  r.finishedAt = new Date().toISOString();
  save();
}
if (r.gate === 'PASS') r.domain = await cleanupOwnedDomain(output, output + '.domain-cleanup.json');
save();
console.log(JSON.stringify({ gate: r.gate, failure: r.failure, cleanup: r.cleanup.length, domain: r.domain?.gate }));
process.exitCode = r.gate === 'PASS' && r.domain?.gate === 'PASS' ? 0 : 1;
