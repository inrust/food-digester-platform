/** Keep only this run's sessions in memory while the approved accounts are disabled in the UI. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
const secretPath = '/tmp/fdp-admin-ui-20261004-private-logins.json';
const logins = JSON.parse(readFileSync(secretPath));
const ids = ['94371262-8afe-4fab-b748-2fb6d95c2bcd', '54bcc341-d8c5-4624-b694-d0702282105d'];
const sites = ['2c8bca29-c681-434c-8af7-3b0afe3e8a54', 'd8fa1d22-83ad-43d6-a01c-8c15715409a9'];
const names = ['ui-accept-20261004-a@example.invalid', 'ui-accept-20261004-b@example.invalid'];
if (logins.length !== 2 || logins.some((x, i) => x.username !== names[i])) throw Error('OWN_IDENTITIES_REQUIRED');
const pool = 'ap-southeast-1_hZMX8LpFo',
  region = 'ap-southeast-1';
const aws = (args) => {
  const p = spawnSync('aws', args, { encoding: 'utf8', timeout: 30000 });
  if (p.status !== 0) throw Error('AWS_READ_UNAVAILABLE');
  return JSON.parse(p.stdout);
};
if (aws(['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--output', 'json']).Account !== '065986019555')
  throw Error('WRONG_ACCOUNT');
const creds = aws(['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process']);
const cognito = new sdk.CognitoIdentityProviderClient({
  region,
  credentials: {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  },
});
const r = {
  scope: 'OWN_ACCOUNT_DISABLE_AND_RESIDUAL_SESSION_CHECK',
  sourceCommit: 'cb5beaaeb50132045427c55542263c5f2e846496',
  startedAt: new Date().toISOString(),
  identities: [],
  requests: [],
  fullAdminTargetAccepted: false,
  status: 'RUNNING',
};
const output = 'docs/audit/evidence/admin-ui-target-2026-10-04/scoped-account-cleanup.json';
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
const flows = [],
  sessions = [];
async function req(id, i, path, expected) {
  const response = await fetch('https://api.bio-nexa.com/api/v1' + path, {
    headers: { Authorization: 'Bearer ' + sessions[i].idToken },
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.json();
  const row = {
    id,
    role: logins[i].role,
    path,
    status: response.status,
    requestId: response.headers.get('x-amzn-requestid'),
    expectedStatuses: expected,
    result: expected.includes(response.status) ? 'PASS' : 'FAIL',
  };
  if (response.status === 200 && Array.isArray(body.data))
    row.onlyOwnCustomer = body.data.every((x) => x.customerId === ids[i]);
  r.requests.push(row);
  save();
}
try {
  for (let i = 0; i < 2; i++) {
    const user = await cognito.send(new sdk.AdminGetUserCommand({ UserPoolId: pool, Username: names[i] }));
    if (!user.Enabled || user.UserAttributes.find((x) => x.Name === 'custom:customer_id')?.Value !== ids[i])
      throw Error('OWN_USER_SCOPE_MISMATCH');
    const flow = new AuthFlow({
      idp: createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
      userPoolId: pool,
      sessionManager: { establish() {} },
    });
    const auth = await flow.login(logins[i].username, logins[i].password);
    if (auth.status !== 'authenticated') throw Error('SRP_REQUIRED');
    flows.push(flow);
    sessions.push(auth.session);
    const claims = JSON.parse(Buffer.from(auth.session.idToken.split('.')[1], 'base64url'));
    r.identities.push({
      username: names[i],
      role: logins[i].role,
      customerId: ids[i],
      tokenExpiresAt: new Date(claims.exp * 1000).toISOString(),
    });
    await req('before-disable-own-device-users-' + i, i, '/admin/device-users', [200]);
  }
  save();
  console.log('READY_FOR_CONFIRMED_OWN_ACCOUNT_UI_DISABLE');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  for (let i = 0; i < 2; i++) {
    const user = await cognito.send(new sdk.AdminGetUserCommand({ UserPoolId: pool, Username: names[i] }));
    r.identities[i].enabledAfterUiDisable = user.Enabled;
    if (user.Enabled) throw Error('ACCOUNT_NOT_DISABLED');
    await cognito.send(new sdk.AdminUserGlobalSignOutCommand({ UserPoolId: pool, Username: names[i] }));
    r.identities[i].globalSignOut = 'PASS';
    try {
      await flows[i].login(logins[i].username, logins[i].password);
      r.identities[i].newLoginDenied = false;
    } catch (error) {
      r.identities[i].newLoginDenied = error.code === 'INVALID_CREDENTIALS';
      r.identities[i].loginErrorCode = error.code ?? error.name;
    }
    await req('disabled-existing-token-own-site-' + i, i, '/admin/sites/' + sites[i], [401, 403]);
    save();
  }
  r.status =
    r.identities.every((x) => !x.enabledAfterUiDisable && x.newLoginDenied) &&
    r.requests.every((x) => x.result === 'PASS' && x.onlyOwnCustomer !== false)
      ? 'PASS'
      : 'FAIL';
} catch (error) {
  r.failure = { name: error.name, code: error.code ?? error.message };
  r.status = 'FAIL';
} finally {
  process.stdin.pause();
  cognito.destroy();
  r.finishedAt = new Date().toISOString();
  unlinkSync(secretPath);
  r.privateLoginFileRemoved = true;
  save();
  console.log(JSON.stringify({ status: r.status, requests: r.requests, failure: r.failure }));
}
process.exitCode = r.status === 'PASS' ? 0 : 1;
