import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { decodeFixtureFrames } from './qa09-db-log-frames.mjs';
import { runFixture, classifyFixtureCliError } from './qa09-ten-device-bridge.mjs';
import { seedCleanupAction } from './qa09-seed-recovery.mjs';
const [parentFile, failedBuildFile, output] = process.argv.slice(2);
if (!parentFile || !failedBuildFile || !output) throw Error('PARENT_BUILD_OUTPUT_REQUIRED');
const bytes = readFileSync(parentFile),
  parent = JSON.parse(bytes),
  failed = JSON.parse(readFileSync(failedBuildFile));
const hash = (b) => createHash('sha256').update(b).digest('hex');
if (
  parent.gate !== 'FAIL' ||
  !['FIXTURE_RESULT_READ_TIMEOUT', 'AWS_get-log-events_SSO_SESSION_EXPIRED'].includes(parent.failure?.code) ||
  !/^qa09-[a-f0-9]{16}$/.test(parent.prefix) ||
  parent.devices?.length !== 10 ||
  parent.devices.some((id, i) => id !== parent.prefix + '-' + String(i + 1).padStart(2, '0')) ||
  parent.customers?.length !== 2 ||
  parent.customers.some((c, i) => c.name !== parent.prefix + (i ? '-b' : '-a')) ||
  failed.build?.status !== 'SUCCEEDED' ||
  failed.build.serviceRole !== 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' ||
  !failed.build.id.startsWith('fdp-test-qa09-ten-device-fixtures:')
)
  throw Error('OWN_UNKNOWN_COMMIT_SEED_LEDGER_REQUIRED');
function aws(args) {
  const r = spawnSync('aws', [...args, '--profile', 'esgiot-infra', '--region', 'ap-southeast-1', '--output', 'json'], {
    encoding: 'utf8',
    timeout: 150000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw Object.assign(Error('RECOVERY_AWS_READ_FAILED'), { code: classifyFixtureCliError(r.stderr, r.error) });
  return JSON.parse(r.stdout);
}
const r = {
  task: 'QA-09',
  scope: 'FAILED_SEED_RESULT_AND_EXACT_FIXTURE_RECOVERY',
  prefix: parent.prefix,
  sourceCommit: parent.sourceCommit,
  parentReceiptSha256: hash(bytes),
  failedBuildReceiptSha256: hash(readFileSync(failedBuildFile)),
  startedAt: new Date().toISOString(),
  readProfile: 'esgiot-infra',
  fullQa09Accepted: false,
  credentialsExported: false,
  cleanup: [],
  gate: 'RUNNING',
};
const sources = [
  'scripts/recover-qa09-nonactive-seed.mjs',
  'scripts/qa09-seed-recovery.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'scripts/qa09-ten-device-db.mjs',
  'scripts/qa09-db-log-frames.mjs',
  'scripts/qa09-db-frame-wait.mjs',
].map((path) => {
  const b = readFileSync(path);
  return { path, sha256: hash(b), sourceBase64: b.toString('base64') };
});
writeFileSync(output + '.sources.json', JSON.stringify({ task: 'QA-09', sources }, null, 2) + '\n');
r.sourceReceiptSha256 = hash(readFileSync(output + '.sources.json'));
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
save();
let cognito,
  username,
  created = false;
try {
  const identity = aws(['sts', 'get-caller-identity']);
  if (identity.Account !== '065986019555' || !identity.Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_'))
    throw Error('WRONG_RECOVERY_IDENTITY');
  const logs = aws([
    'logs',
    'get-log-events',
    '--log-group-name',
    failed.build.logs.groupName,
    '--log-stream-name',
    failed.build.logs.streamName,
    '--start-from-head',
  ]);
  const frames = decodeFixtureFrames(logs.events);
  const frame = frames[0];
  if (
    frames.length !== 1 ||
    frame.buildId !== failed.build.id ||
    frame.sourceHash !== failed.sourceHash ||
    frame.prefix !== parent.prefix ||
    frame.action !== 'business-seed-devices' ||
    frame.gate !== 'PASS'
  )
    throw Error('SEED_FRAME_NOT_BOUND');
  r.recoveredSeedFrame = frame;
  r.seedCommitted = true;
  save();
  const recovered = await runFixture(
    { prefix: parent.prefix, devices: parent.devices, customers: parent.customers, action: 'observe' },
    output + '.observe.json',
    console.log,
    { logProfile: 'esgiot-infra' },
  );
  if (JSON.stringify(recovered.result.originalFingerprints) !== JSON.stringify(frame.originalFingerprints))
    throw Error('RECOVERY_OUTSIDE_BASELINE_DRIFT');
  const action = seedCleanupAction(recovered.result, parent.devices);
  if (action === 'cleanup')
    await runFixture(
      {
        prefix: parent.prefix,
        devices: parent.devices,
        customers: parent.customers,
        action,
        baseline: frame.originalFingerprints,
      },
      output + '.database-cleanup.json',
      console.log,
      { logProfile: 'esgiot-infra' },
    );
  const after =
    action === 'cleanup'
      ? await runFixture(
          { prefix: parent.prefix, devices: parent.devices, customers: parent.customers, action: 'observe' },
          output + '.after-cleanup.json',
          console.log,
          { logProfile: 'esgiot-infra' },
        )
      : recovered;
  if (
    after.result.devices.length ||
    after.result.certificates.length ||
    (after.result.requests ?? after.result.onboardingRequests ?? []).length ||
    JSON.stringify(after.result.originalFingerprints) !== JSON.stringify(frame.originalFingerprints)
  )
    throw Error('RECOVERY_DATABASE_NOT_EMPTY');
  r.cleanup.push({ type: 'database-fixtures', count: recovered.result.devices.length, result: 'PASS' });
  save();
  const creds = aws(['configure', 'export-credentials', '--format', 'process']);
  const credentials = {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  };
  cognito = new sdk.CognitoIdentityProviderClient({ region: 'ap-southeast-1', credentials, maxAttempts: 1 });
  const pool = 'ap-southeast-1_hZMX8LpFo';
  username = parent.prefix + '-recovery-admin@example.invalid';
  const temp = 'A!z9' + randomBytes(24).toString('base64url'),
    password = 'A!z9' + randomBytes(24).toString('base64url');
  await cognito.send(
    new sdk.AdminCreateUserCommand({
      UserPoolId: pool,
      Username: username,
      TemporaryPassword: temp,
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: username },
        { Name: 'email_verified', Value: 'true' },
      ],
    }),
  );
  created = true;
  await cognito.send(
    new sdk.AdminAddUserToGroupCommand({ UserPoolId: pool, Username: username, GroupName: 'PlatformSuperAdmin' }),
  );
  const flow = new AuthFlow({
    idp: createCognitoIdpClient({ region: 'ap-southeast-1', clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
    userPoolId: pool,
    sessionManager: { establish() {} },
  });
  if ((await flow.login(username, temp)).status !== 'new-password-required') throw Error('RECOVERY_REAL_SRP_REQUIRED');
  const auth = await flow.submitNewPassword(password);
  if (auth.status !== 'authenticated') throw Error('RECOVERY_REAL_SRP_REQUIRED');
  for (const c of parent.customers) {
    const path = 'https://api.bio-nexa.com/api/v1/admin/customers/' + c.id;
    const headers = { Authorization: 'Bearer ' + auth.session.idToken };
    const get = await fetch(path, { headers, signal: AbortSignal.timeout(20000) });
    if (get.status !== 200) throw Error('RECOVERY_CUSTOMER_MISSING');
    const body = await get.json();
    if (body.data.name !== c.name) throw Error('RECOVERY_CUSTOMER_SCOPE_DRIFT');
    const del = await fetch(path, {
      method: 'DELETE',
      headers: { ...headers, 'If-Match': String(body.data.version) },
      signal: AbortSignal.timeout(20000),
    });
    if (del.status !== 200) throw Error('RECOVERY_CUSTOMER_DELETE_FAILED');
    if ((await fetch(path, { headers, signal: AbortSignal.timeout(20000) })).status !== 404)
      throw Error('RECOVERY_CUSTOMER_REMAINS');
    r.cleanup.push({
      type: 'customer',
      id: c.id,
      result: 'PASS',
      gatewayRequestId: del.headers.get('x-amzn-requestid'),
    });
    save();
  }
  r.gate = 'PASS';
} catch (e) {
  r.gate = e.code === 'SSO_SESSION_EXPIRED' ? 'BLOCKED' : 'FAIL';
  r.errorCode = /^[A-Z_]+$/.test(e.code ?? e.message) ? (e.code ?? e.message) : 'RECOVERY_FAILED';
} finally {
  if (created) {
    try {
      const pool = 'ap-southeast-1_hZMX8LpFo';
      await cognito.send(new sdk.AdminUserGlobalSignOutCommand({ UserPoolId: pool, Username: username }));
      await cognito.send(new sdk.AdminDeleteUserCommand({ UserPoolId: pool, Username: username }));
      let absent = false;
      try {
        await cognito.send(new sdk.AdminGetUserCommand({ UserPoolId: pool, Username: username }));
      } catch (e) {
        absent = e.name === 'UserNotFoundException';
      }
      if (!absent) r.gate = 'FAIL';
      r.cleanup.push({ type: 'recovery-identity', username, result: absent ? 'PASS' : 'FAIL' });
    } catch {
      r.gate = 'FAIL';
      r.cleanup.push({ type: 'recovery-identity', username, result: 'FAIL' });
    }
  }
  r.finishedAt = new Date().toISOString();
  r.executorSha256 = hash(readFileSync(new URL(import.meta.url)));
  save();
}
console.log(JSON.stringify({ gate: r.gate, prefix: r.prefix, cleanup: r.cleanup, errorCode: r.errorCode }));
process.exitCode = r.gate === 'PASS' ? 0 : 1;
