import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { classifyFixtureCliError } from './qa09-ten-device-bridge.mjs';
const [childFile, recoveryFile, output] = process.argv.slice(2);
if (!childFile || !recoveryFile || !output) throw Error('BUSINESS_RECOVERY_OUTPUT_REQUIRED');
const bytes = readFileSync(childFile),
  child = JSON.parse(bytes),
  recoveredBytes = readFileSync(recoveryFile),
  recovered = JSON.parse(recoveredBytes),
  parent = child;
const hash = (b) => createHash('sha256').update(b).digest('hex');
const proof = child.checks?.find(
  (c) =>
    c.id === 'operator-legal-site-patch' && c.result === 'PASS' && c.status === 200 && c.role === 'PlatformOperator',
);
const id = proof?.path?.match(
  /^\/api\/v1\/admin\/sites\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/,
)?.[1];
if (
  !id ||
  !/^qa09-[a-f0-9]{16}$/.test(child.prefix) ||
  child.customers?.length !== 2 ||
  recovered.prefix !== child.prefix ||
  recovered.gate !== 'PASS' ||
  recovered.businessReceiptSha256 !== hash(bytes) ||
  recovered.cleanup?.some((c) => c.result !== 'PASS') ||
  !recovered.cleanup?.some((c) => c.type === 'database-fixtures' && c.count === 10)
)
  throw Error('EXACT_COMPLETED_RECOVERY_AND_SITE_PROOF_REQUIRED');
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
  scope: 'OWN_OPERATOR_SITE_LEDGER_COMPENSATION',
  prefix: child.prefix,
  sourceCommit: child.sourceCommit,
  parentReceiptSha256: hash(bytes),
  completedRecoverySha256: hash(recoveredBytes),
  siteId: id,
  customerId: child.customers[1].id,
  startedAt: new Date().toISOString(),
  gate: 'RUNNING',
  fullQa09Accepted: false,
  credentialsExported: false,
  cleanup: [],
};
const sources = [
  'scripts/recover-qa09-nonactive-site.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'apps/admin-web/src/auth/auth-flow.ts',
  'apps/admin-web/src/auth/cognito-idp.ts',
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
  const caller = aws(['sts', 'get-caller-identity']);
  if (caller.Account !== '065986019555' || !caller.Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_'))
    throw Error('WRONG_RECOVERY_IDENTITY');
  const creds = aws(['configure', 'export-credentials', '--format', 'process']);
  const credentials = {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  };
  cognito = new sdk.CognitoIdentityProviderClient({ region: 'ap-southeast-1', credentials, maxAttempts: 1 });
  const pool = 'ap-southeast-1_hZMX8LpFo';
  username = parent.prefix + '-site-recovery-admin@example.invalid';
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

  const path = 'https://api.bio-nexa.com/api/v1/admin/sites/' + id,
    headers = { Authorization: 'Bearer ' + auth.session.idToken };
  const get = await fetch(path, { headers, signal: AbortSignal.timeout(20000) });
  if (get.status === 404) r.cleanup.push({ type: 'site', id, result: 'PASS', alreadyAbsent: true });
  else {
    if (get.status !== 200) throw Error('SITE_READ_FAILED');
    const body = (await get.json()).data;
    if (body.customerId !== child.customers[1].id || body.name !== child.prefix + '-operator-site')
      throw Error('SITE_SCOPE_DRIFT');
    const del = await fetch(path, {
      method: 'DELETE',
      headers: { ...headers, 'If-Match': String(body.version) },
      signal: AbortSignal.timeout(20000),
    });
    if (del.status !== 200 || (await fetch(path, { headers, signal: AbortSignal.timeout(20000) })).status !== 404)
      throw Error('SITE_DELETE_FAILED');
    r.cleanup.push({ type: 'site', id, result: 'PASS', gatewayRequestId: del.headers.get('x-amzn-requestid') });
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
