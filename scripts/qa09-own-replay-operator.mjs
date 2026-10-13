import { randomBytes } from 'node:crypto';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { provisionSuppressedOwnUser } from './run-qa09-user-closeout-target.mjs';
const pool = 'ap-southeast-1_hZMX8LpFo';
export async function prepareOwnReplayOperator(
  ctx,
  r,
  save,
  output,
  { provision = provisionSuppressedOwnUser, login } = {},
) {
  const own = {
    role: 'PlatformOperator',
    email: ctx.receipt.prefix + '-h01-platformoperator@example.invalid',
    customerId: null,
  };
  r.operator = own;
  r.outputPath = output;
  const hold = (reason) => {
    own.cleanupHold = reason;
    ctx.receipt.cleanupHold = 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE';
    save();
  };
  const call = (Cmd, input) =>
    ctx.cognito.send(new Cmd({ UserPoolId: pool, ...input }), { abortSignal: AbortSignal.timeout(30000) });
  const cleanup = async () => {
    if (ctx.receipt.cleanupHold) return { gate: 'BLOCKED_UNKNOWN_WRITE' };
    if (!own.userId) throw Error('KNOWN_OWN_OPERATOR_REQUIRED');
    own.cleanupAttempted = true;
    save();
    // Disable is an irreversible business write. A lost response is never retried here.
    try {
      const disabled = (
        await ctx.api('a5:operator-disable', 'POST', '/api/v1/admin/users/' + own.userId + '/disable', 200)
      ).data;
      if (disabled.userId !== own.userId || disabled.email !== own.email || disabled.status !== 'DISABLED')
        throw Error('OWN_OPERATOR_DISABLE_REQUIRED');
      const readback = (await ctx.api('a5:operator-disabled-readback', 'GET', '/api/v1/admin/users/' + own.userId, 200))
        .data;
      if (readback.userId !== own.userId || readback.email !== own.email || readback.status !== 'DISABLED')
        throw Error('OWN_DISABLED_OPERATOR_READBACK_REQUIRED');
      own.businessDisabled = true;
      save();
      await call(sdk.AdminDeleteUserCommand, { Username: own.email });
      own.cognitoDeleted = true;
      save();
      return { gate: 'PASS_DISABLED_TOMBSTONE_AND_COGNITO_DELETED' };
    } catch (error) {
      hold('UNKNOWN_OPERATOR_CLEANUP_NO_RETRY');
      throw error;
    }
  };
  hold('OPERATOR_PREPARATION_IN_PROGRESS');
  try {
    await provision({
      prefix: ctx.receipt.prefix,
      own,
      customers: ctx.receipt.customers,
      call,
      sdk,
      receipt: r,
      save,
    });
  } catch (error) {
    hold('UNKNOWN_OPERATOR_PREPARATION_NO_RESTART');
    throw error;
  }
  delete ctx.receipt.cleanupHold;
  delete own.cleanupHold;
  save();
  let auth;
  try {
    const password = 'A!z9' + randomBytes(24).toString('base64url');
    await call(sdk.AdminSetUserPasswordCommand, { Username: own.email, Password: password, Permanent: true });
    const flow = new AuthFlow({
      idp: createCognitoIdpClient({ region: 'ap-southeast-1', clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
      userPoolId: pool,
      sessionManager: { establish() {} },
    });
    auth = login ? await login(own.email, password) : await flow.login(own.email, password);
    if (auth.status !== 'authenticated') throw Error('REAL_OPERATOR_SRP_REQUIRED');
    own.realSrp = true;
    save();
  } catch (error) {
    r.operatorCleanup = await cleanup();
    save();
    throw error;
  }
  return {
    async api(id, method, path, expected, body) {
      if (!/^\/api\/v1\/admin\/replay\/jobs(?:\/[a-f0-9-]{36})?$/.test(path))
        throw Error('OPERATOR_REPLAY_ROUTES_ONLY');
      const response = await fetch('https://api.bio-nexa.com' + path, {
        method,
        headers: { Authorization: 'Bearer ' + auth.session.idToken, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000),
      });
      (r.operatorRequests ??= []).push({
        id,
        method,
        path,
        status: response.status,
        expected,
        requestId: response.headers.get('x-amzn-requestid'),
      });
      save();
      const value = await response.json();
      if (response.status !== expected) throw Error('OPERATOR_REPLAY_API_FAILED');
      return value;
    },
    cleanup,
  };
}
