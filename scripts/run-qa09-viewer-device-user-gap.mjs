import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { runRoleSupplement } from './qa09-closeout-role-supplement.mjs';
const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
const [output, versionPath] = process.argv.slice(2);
if (!output || !versionPath || existsSync(output) || existsSync(output + '.sources.json'))
  throw Error('FRESH_OUTPUT_AND_VERSION_REQUIRED');
const version = JSON.parse(readFileSync(versionPath));
if (
  version.gate !== 'PASS' ||
  version.lambdaArtifacts?.length !== 19 ||
  version.lambdaArtifacts.some((a) => !a.matches)
)
  throw Error('BOUND_APPLICATION_REQUIRED');
const hash = (b) => createHash('sha256').update(b).digest('hex'),
  exec = promisify(execFile);
const identity = JSON.parse(
  (
    await exec(
      'aws',
      ['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--region', 'ap-southeast-1', '--output', 'json'],
      { timeout: 30000 },
    )
  ).stdout,
);
if (identity.Account !== '065986019555' || !identity.Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_'))
  throw Error('WRONG_EXISTING_TEST_IDENTITY');
const prefix = 'qa09-' + randomBytes(8).toString('hex'),
  username = prefix + '-platformsuperadmin@example.invalid',
  pool = 'ap-southeast-1_hZMX8LpFo';
const cognito = new sdk.CognitoIdentityProviderClient({
  region: 'ap-southeast-1',
  credentials: fromIni({ profile: 'esgiot-infra' }),
  maxAttempts: 1,
});
const call = (Cmd, input) =>
  cognito.send(new Cmd({ UserPoolId: pool, Username: username, ...input }), {
    abortSignal: AbortSignal.timeout(30000),
  });
const r = {
  scope: 'ONLY_CHANGED_VIEWER_DEVICE_USER_READ_ROUTE_375_EN',
  sourceCommit: version.sourceCommit,
  versionSha256: hash(readFileSync(versionPath)),
  prefix,
  username,
  gate: 'RUNNING',
  cleanup: [],
  notificationSendingRequested: false,
  fullQa09Accepted: false,
};
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
save();
writeFileSync(
  output + '.sources.json',
  JSON.stringify(
    {
      sources: [
        'scripts/run-qa09-viewer-device-user-gap.mjs',
        'scripts/qa09-closeout-role-supplement.mjs',
        'scripts/qa09-closeout-browser-gaps.mjs',
        'scripts/qa09-device-user-layout-recheck.mjs',
      ].map((path) => {
        const b = readFileSync(path);
        return { path, sha256: hash(b), sourceBase64: b.toString('base64') };
      }),
    },
    null,
    2,
  ) + '\n',
);
let created = false,
  accessToken;
try {
  const temporaryPassword = 'A!z9' + randomBytes(24).toString('base64url');
  await call(sdk.AdminCreateUserCommand, {
    MessageAction: 'SUPPRESS',
    TemporaryPassword: temporaryPassword,
    UserAttributes: [
      { Name: 'email', Value: username },
      { Name: 'email_verified', Value: 'true' },
    ],
  });
  created = true;
  await call(sdk.AdminAddUserToGroupCommand, { GroupName: 'PlatformSuperAdmin' });
  const flow = new AuthFlow({
    idp: createCognitoIdpClient({ region: 'ap-southeast-1', clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
    userPoolId: pool,
    sessionManager: { establish() {} },
  });
  const first = await flow.login(username, temporaryPassword);
  if (first.status !== 'new-password-required') throw Error('REAL_PASSWORD_CHALLENGE_REQUIRED');
  const password = 'A!z9' + randomBytes(24).toString('base64url'),
    auth = await flow.submitNewPassword(password);
  if (auth.status !== 'authenticated') throw Error('REAL_SRP_REQUIRED');
  accessToken = auth.session.accessToken;
  await runRoleSupplement({
    r,
    save,
    cognito,
    rootLogin: { username, password },
    rootSession: auth.session,
    viewerOnly: true,
  });
  r.gate = 'PASS';
} catch (e) {
  r.gate = 'FAIL';
  r.failureCode = /^[A-Z_]+$/.test(e.message ?? '') ? e.message : 'ROLE_SUPPLEMENT_FAILED';
} finally {
  if (created) {
    try {
      if (accessToken)
        await createCognitoIdpClient({
          region: 'ap-southeast-1',
          clientId: '5ljdjsf9g563mc1vdc7vjdjm09',
        }).globalSignOut(accessToken);
      await call(sdk.AdminDeleteUserCommand, {});
      try {
        await call(sdk.AdminGetUserCommand, {});
        demand(false, 'OWN_IDENTITY_REMAINS');
      } catch (e) {
        demand(e.name === 'UserNotFoundException', 'OWN_IDENTITY_ABSENCE_NOT_PROVEN');
      }
      r.cleanup.push({ type: 'identity', result: 'PASS', absent: true });
    } catch {
      r.cleanup.push({ type: 'identity', result: 'FAIL' });
      r.gate = 'FAIL';
    }
  }
  accessToken = undefined;
  r.finishedAt = new Date().toISOString();
  save();
}
console.log(
  JSON.stringify({
    gate: r.gate,
    browser: r.browserSupplement?.gate,
    containment: r.unknownContainment?.gate,
    failure: r.failureCode,
  }),
);
process.exitCode = r.gate === 'PASS' ? 0 : 1;
