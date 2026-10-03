import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
const [output, phase] = process.argv.slice(2);
if (!output || !['observability', 'capacity', 'immediate'].includes(phase)) throw Error('PHASE_REQUIRED');
const credentialResult = spawnSync(
  'aws',
  ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'],
  { encoding: 'utf8', timeout: 30000 },
);
if (credentialResult.status !== 0) throw Error('SSO_REQUIRED');
const c = JSON.parse(credentialResult.stdout);
const identity = spawnSync('aws', ['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--output', 'json'], {
  encoding: 'utf8',
  timeout: 30000,
});
if (identity.status !== 0 || JSON.parse(identity.stdout).Account !== '065986019555') throw Error('WRONG_ACCOUNT');
const cognito = new sdk.CognitoIdentityProviderClient({
  region: 'ap-southeast-1',
  credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
  maxAttempts: 1,
});
const prefix = 'qa09-' + randomBytes(8).toString('hex'),
  username = prefix + '-capacity@example.invalid',
  pool = 'ap-southeast-1_hZMX8LpFo';
const receipt = {
  task: 'QA-09',
  scope: 'REAL_ADMIN_PRISMA_ROOT_READ_AND_AUDITED_TRANSACTION_NOT_FULL_CAPACITY',
  phase,
  prefix,
  username,
  sourceCommit: '7c6f356b6917accd6cf562cb4bd6d5990416740f',
  executorSha256: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  startedAt: new Date().toISOString(),
  concurrency: 10,
  requests: [],
  cleanup: [],
  gate: 'RUNNING',
  credentialsExported: false,
};
let created = false,
  customer,
  token;
const save = () => writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
save();
function requireOwnCustomer(own) {
  if (own.status !== 200 || own.data.name !== prefix + '-capacity') throw Error('OWN_SCOPE_MISMATCH');
}
async function api(id, method, path, body, headers = {}) {
  const start = performance.now(),
    startedAt = new Date().toISOString();
  const response = await fetch('https://api.bio-nexa.com' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const parsed = await response.json().catch(() => null);
  receipt.requests.push({
    id,
    method,
    startedAt,
    status: response.status,
    latencyMs: Math.round(performance.now() - start),
    gatewayRequestId: response.headers.get('x-amzn-requestid'),
    gatewayExtendedRequestId: response.headers.get('x-amz-apigw-id'),
    errorCode: parsed?.error?.code ?? null,
  });
  save();
  return { status: response.status, data: parsed?.data };
}
try {
  const password = 'A!z9' + randomBytes(24).toString('base64url');
  await cognito.send(
    new sdk.AdminCreateUserCommand({
      UserPoolId: pool,
      Username: username,
      MessageAction: 'SUPPRESS',
      TemporaryPassword: password,
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
  const first = await flow.login(username, password);
  if (first.status !== 'new-password-required') throw Error('OWN_LOGIN_CHALLENGE_REQUIRED');
  const logged = await flow.submitNewPassword('A!z9' + randomBytes(24).toString('base64url'));
  if (logged.status !== 'authenticated') throw Error('OWN_LOGIN_REQUIRED');
  token = logged.session.idToken;
  const result = await api('audited-create', 'POST', '/api/v1/admin/customers', { name: prefix + '-capacity' });
  if (result.status === 201 && result.data?.name === prefix + '-capacity') customer = result.data;
  else throw Error('OWN_CUSTOMER_CREATE_FAILED');
  for (let batch = 0; batch < 2; batch++) {
    const rows = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        api('concurrent-read-' + batch + '-' + i, 'GET', '/api/v1/admin/customers/' + customer.id),
      ),
    );
    if (rows.some((r) => r.status !== 200 || r.data?.id !== customer.id)) throw Error('CAPACITY_REQUEST_FAILURE');
  }
  receipt.businessGate = 'PASS';
} catch (error) {
  receipt.businessGate = 'FAIL';
  receipt.errorCode = /^[A-Z_]+$/.test(error.message) ? error.message : 'TARGET_OPERATION_FAILED';
} finally {
  if (customer) {
    try {
      const own = await api('cleanup-own-read', 'GET', '/api/v1/admin/customers/' + customer.id);
      requireOwnCustomer(own);
      const deleted = await api('audited-delete', 'DELETE', '/api/v1/admin/customers/' + customer.id, undefined, {
        'If-Match': String(own.data.version),
      });
      const absent = await api('cleanup-own-absent', 'GET', '/api/v1/admin/customers/' + customer.id);
      receipt.cleanup.push({
        type: 'customer',
        id: customer.id,
        result: deleted.status === 200 && absent.status === 404 ? 'PASS' : 'FAIL',
      });
    } catch {
      receipt.cleanup.push({ type: 'customer', id: customer.id, result: 'FAIL' });
    }
  }
  if (created) {
    try {
      await cognito.send(new sdk.AdminDeleteUserCommand({ UserPoolId: pool, Username: username }));
      try {
        await cognito.send(new sdk.AdminGetUserCommand({ UserPoolId: pool, Username: username }));
        receipt.cleanup.push({ type: 'identity', result: 'FAIL' });
      } catch (e) {
        receipt.cleanup.push({ type: 'identity', result: e.name === 'UserNotFoundException' ? 'PASS' : 'FAIL' });
      }
    } catch {
      receipt.cleanup.push({ type: 'identity', result: 'FAIL' });
    }
  }
  receipt.gate =
    receipt.businessGate === 'PASS' && receipt.cleanup.length === 2 && receipt.cleanup.every((r) => r.result === 'PASS')
      ? 'PASS'
      : 'FAIL';
  receipt.finishedAt = new Date().toISOString();
  save();
}
console.log(JSON.stringify({ gate: receipt.gate, requests: receipt.requests.length, cleanup: receipt.cleanup }));
process.exitCode = receipt.gate === 'PASS' ? 0 : 1;
