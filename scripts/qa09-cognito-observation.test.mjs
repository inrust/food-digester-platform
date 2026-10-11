import test from 'node:test';
import assert from 'node:assert/strict';
import { CognitoIdpError, createCognitoIdpClient, createHttpIdpFetch } from '../apps/admin-web/src/auth/cognito-idp.ts';
import {
  createOperationObserver,
  cleanupIdentityOperations,
  safeOperationError,
} from './qa09-operation-observation.mjs';
const secret = 'private-password-token-username-response';
const requestId = '11111111-1111-1111-1111-111111111111';
test('constructor and projection reject malformed diagnostic fields', () => {
  for (const status of [-1, 0, 99, 600, 200.5, '403']) {
    const error = new CognitoIdpError('UNKNOWN', 'fixed', { httpStatusCode: status, requestId: secret, stage: secret });
    assert.equal(error.diagnosticStage, undefined);
    assert.deepEqual(error.$metadata, {});
    assert.equal(safeOperationError(error).httpStatusCode, null);
    assert.ok(!JSON.stringify(error).includes(secret));
  }
});
const client = (fetch) => createCognitoIdpClient({ region: 'ap-southeast-1', clientId: 'public-client', fetch });
const http = (run) => createHttpIdpFetch('ap-southeast-1', run);
async function capture(work) {
  let error;
  try {
    await work();
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof CognitoIdpError);
  const safe = safeOperationError(error);
  assert.ok(!JSON.stringify({ safe, error }).includes(secret));
  assert.ok(!(JSON.stringify(error.cause) ?? '').includes(secret));
  return { error, safe };
}
for (const code of [
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]) {
  test(`actual Cognito fetch transport preserves only closed one-hop cause ${code}`, async () => {
    const { error, safe } = await capture(() =>
      client(
        http(async () => {
          throw Object.assign(Error(secret), {
            cause: { code, message: secret, url: secret, cause: { token: secret } },
          });
        }),
      ).globalSignOut(secret),
    );
    assert.equal(error.code, 'NETWORK');
    assert.equal(safe.errorName, 'CognitoIdpError');
    assert.equal(safe.diagnosticStage, 'FETCH');
    assert.equal(safe.causeCode, code);
    assert.equal(safe.httpStatusCode, null);
    assert.equal(safe.requestId, null);
    assert.deepEqual(error.cause, { code });
  });
}
test('unknown transport cause, arbitrary metadata and messages never cross the boundary', async () => {
  const { safe, error } = await capture(() =>
    client(
      http(async () => {
        throw Object.assign(Error(secret), { code: secret, cause: { code: secret }, $metadata: { requestId: secret } });
      }),
    ).globalSignOut(secret),
  );
  assert.equal(safe.causeCode, null);
  assert.equal(error.cause, undefined);
  const projected = safeOperationError({
    name: 'CognitoIdpError',
    code: secret,
    diagnosticStage: secret,
    message: secret,
    cause: { code: secret },
    $metadata: { requestId: secret, httpStatusCode: -1 },
  });
  assert.equal(projected.code, 'UNCLASSIFIED_FAILURE');
  assert.equal(projected.diagnosticStage, null);
  assert.ok(!JSON.stringify(projected).includes(secret));
});
for (const [type, code, status] of [
  ['NotAuthorizedException', 'INVALID_CREDENTIALS', 400],
  ['TooManyRequestsException', 'RATE_LIMITED', 429],
  ['InternalErrorException', 'UNKNOWN', 500],
  ['untrusted-' + secret, 'UNKNOWN', 503],
]) {
  test(`actual GlobalSignOut HTTP rejection ${status}/${code} retains safe metadata only`, async () => {
    const { safe } = await capture(() =>
      client(
        http(
          async () =>
            new Response(JSON.stringify({ __type: type, message: secret }), {
              status,
              headers: { 'x-amzn-requestid': requestId },
            }),
        ),
      ).globalSignOut(secret),
    );
    assert.equal(safe.code, code);
    assert.equal(safe.diagnosticStage, 'HTTP');
    assert.equal(safe.httpStatusCode, status);
    assert.equal(safe.requestId, requestId);
    assert.equal(safe.causeCode, null);
  });
}
for (const status of [200, 503])
  test(`malformed JSON body ${status} fails closed, including void GlobalSignOut`, async () => {
    const { safe } = await capture(() =>
      client(
        http(async () => new Response(secret, { status, headers: { 'x-amzn-requestid': requestId } })),
      ).globalSignOut(secret),
    );
    assert.equal(safe.code, 'UNKNOWN');
    assert.equal(safe.diagnosticStage, 'BODY');
    assert.equal(safe.httpStatusCode, status);
    assert.equal(safe.requestId, requestId);
  });
test('body stream reset is distinct from initial fetch failure', async () => {
  const { safe } = await capture(() =>
    client(
      http(async () => ({
        status: 200,
        headers: new Headers({ 'x-amzn-requestid': requestId }),
        json: async () => {
          throw Object.assign(Error(secret), { cause: { code: 'ECONNRESET', message: secret } });
        },
      })),
    ).globalSignOut(secret),
  );
  assert.equal(safe.diagnosticStage, 'BODY');
  assert.equal(safe.causeCode, 'ECONNRESET');
});
test('valid JSON but invalid authentication reply has REPLY stage', async () => {
  const { safe } = await capture(() =>
    client(http(async () => new Response('{}', { headers: { 'x-amzn-requestid': requestId } }))).refreshAuth(secret),
  );
  assert.equal(safe.diagnosticStage, 'REPLY');
  assert.equal(safe.httpStatusCode, 200);
});
test('wrong password and unknown user remain indistinguishable even in safe projection', async () => {
  const results = [];
  for (const type of ['NotAuthorizedException', 'UserNotFoundException']) {
    results.push(
      (
        await capture(() =>
          client(async () => ({ status: 400, body: { __type: type, message: secret } })).initiateSrpAuth(
            secret,
            secret,
          ),
        )
      ).safe,
    );
  }
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].code, 'INVALID_CREDENTIALS');
});
test('actual mapped sign-out error still deletes/reads absence but never grants cleanup PASS', async () => {
  const rows = [],
    calls = [];
  const idp = client(
    http(
      async () => new Response(JSON.stringify({ __type: 'NotAuthorizedException', message: secret }), { status: 400 }),
    ),
  );
  const result = await cleanupIdentityOperations(createOperationObserver(rows), {
    globalSignOut: () => {
      calls.push('signout');
      return idp.globalSignOut(secret);
    },
    deleteUser: async () => {
      calls.push('delete');
    },
    getUser: async () => {
      calls.push('absence');
      throw Object.assign(Error(secret), { name: 'UserNotFoundException' });
    },
  });
  assert.deepEqual(calls, ['signout', 'delete', 'absence']);
  assert.equal(result.result, 'FAIL');
  assert.equal(result.deletion, 'PASS');
  assert.equal(result.absence, 'PASS');
  assert.equal(rows[0].failure.code, 'INVALID_CREDENTIALS');
  assert.equal(rows[0].failure.diagnosticStage, 'HTTP');
  assert.ok(!JSON.stringify({ rows, result }).includes(secret));
});
test('successful signout is one request, and request shape remains unchanged', async () => {
  const calls = [];
  await client(
    http(async (url, init) => {
      calls.push({ url, init });
      return new Response('{}');
    }),
  ).globalSignOut(secret);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://cognito-idp.ap-southeast-1.amazonaws.com/');
  assert.equal(calls[0].init.headers['X-Amz-Target'], 'AWSCognitoIdentityProviderService.GlobalSignOut');
  assert.deepEqual(JSON.parse(calls[0].init.body), { AccessToken: secret });
});
