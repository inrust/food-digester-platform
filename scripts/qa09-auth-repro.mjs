import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import * as sdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { forgeClaimsToken } from './qa09-write-boundary-probes.mjs';
export async function runAuthRepro(ctx, output) {
  const pool = 'ap-southeast-1_hZMX8LpFo',
    region = 'ap-southeast-1',
    clientId = '5ljdjsf9g563mc1vdc7vjdjm09';
  const r = {
    task: 'QA-09',
    scope: 'READ_ONLY_FORGED_CLAIMS_AND_TWO_DENIAL_TRANSPORT_REPRO',
    prefix: ctx.receipt.prefix,
    startedAt: new Date().toISOString(),
    identities: [],
    checks: [],
    cleanup: [],
    fullQa09Accepted: false,
    credentialsExported: false,
    sources: ['scripts/qa09-auth-repro.mjs', 'scripts/qa09-write-boundary-probes.mjs'].map((path) => {
      const b = readFileSync(path);
      return { path, sha256: createHash('sha256').update(b).digest('hex'), sourceBase64: b.toString('base64') };
    }),
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  save();
  const sessions = new Map();
  const call = (Cmd, input) => ctx.cognito.send(new Cmd(input), { abortSignal: AbortSignal.timeout(30000) });
  const req = async (id, token, path, method = 'GET', body) => {
    const startedAt = new Date().toISOString(),
      start = performance.now();
    const res = await fetch('https://api.bio-nexa.com' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'If-Match': '-1' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20000),
    });
    await res.arrayBuffer();
    const row = {
      id,
      startedAt,
      status: res.status,
      requestId: res.headers.get('x-amzn-requestid'),
      extendedRequestId: res.headers.get('x-amz-apigw-id'),
      gatewayErrorType: res.headers.get('x-amzn-errortype'),
      latencyMs: Math.round(performance.now() - start),
    };
    r.checks.push(row);
    save();
    return row;
  };
  try {
    for (const role of ['Auditor', 'CustomerViewer']) {
      const username = `${ctx.receipt.prefix}-auth-repro-${role.toLowerCase()}@example.invalid`,
        temporary = `A!z9${randomBytes(24).toString('base64url')}`,
        password = `A!z9${randomBytes(24).toString('base64url')}`;
      await call(sdk.AdminCreateUserCommand, {
        UserPoolId: pool,
        Username: username,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: temporary,
        UserAttributes: [
          { Name: 'email', Value: username },
          { Name: 'email_verified', Value: 'true' },
          ...(role.startsWith('Customer') ? [{ Name: 'custom:customer_id', Value: ctx.receipt.customers[0].id }] : []),
        ],
      });
      r.identities.push({ username, role });
      save();
      await call(sdk.AdminAddUserToGroupCommand, { UserPoolId: pool, Username: username, GroupName: role });
      const flow = new AuthFlow({
        idp: createCognitoIdpClient({ region, clientId }),
        userPoolId: pool,
        sessionManager: { establish() {} },
      });
      const first = await flow.login(username, temporary);
      if (first.status !== 'new-password-required') throw Error('REAL_FIRST_LOGIN_REQUIRED');
      const auth = await flow.submitNewPassword(password);
      if (auth.status !== 'authenticated') throw Error('REAL_SRP_REQUIRED');
      sessions.set(role, auth.session);
    }
    const absent = '00000000-0000-4000-8000-000000000000';
    const a = await req(
      'auditor-activate-contract-denial',
      sessions.get('Auditor').idToken,
      '/api/v1/admin/contracts/' + absent + '/activate',
      'POST',
      { qa09UnknownField: true },
    );
    a.role = 'Auditor';
    a.operationId = 'activateContract';
    a.expected = 403;
    a.result = a.status === 403 ? 'PASS' : 'FAIL';
    const v = await req(
      'viewer-process-consumable-denial',
      sessions.get('CustomerViewer').idToken,
      '/api/v1/admin/consumable-requests/' + absent + '/process',
      'POST',
      { qa09UnknownField: true },
    );
    v.role = 'CustomerViewer';
    v.operationId = 'processConsumableRequest';
    v.expected = 403;
    v.result = v.status === 403 ? 'PASS' : 'FAIL';
    const token = sessions.get('CustomerViewer').idToken,
      claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    for (const [name, modified] of [
      ['viewer-to-superadmin', { ...claims, 'cognito:groups': ['PlatformSuperAdmin'] }],
      ['future-nbf', { ...claims, nbf: 4102444800 }],
      ['wrong-audience', { ...claims, aud: 'qa09-invalid' }],
      ['expired', { ...claims, exp: 1 }],
      ['wrong-issuer', { ...claims, iss: 'https://example.invalid' }],
      ['wrong-token-use', { ...claims, token_use: 'access' }],
    ]) {
      const forged = forgeClaimsToken(token, modified),
        payloadChanged = forged.split('.')[1] !== token.split('.')[1];
      if (!payloadChanged) throw Error('SIGNED_PAYLOAD_MUST_CHANGE');
      const row = await req('forged-' + name, forged, '/api/v1/admin/devices/' + ctx.receipt.devices[0]);
      row.signedPayloadBytesChanged = payloadChanged;
      row.signatureBytesUnchanged = true;
      row.denialGate = [401, 403].includes(row.status) ? 'PASS' : 'FAIL';
      row.contractExpected401Gate = row.status === 401 ? 'PASS' : 'FAIL';
      row.result = row.denialGate;
      row.independentCorrectlySignedClaimValidationProved = false;
      save();
    }
    const saParts = ctx.token.split('.'),
      legacy = ctx.token.slice(0, -1) + (ctx.token.endsWith('A') ? 'B' : 'A');
    const signatureBytesEqual = Buffer.from(saParts[2], 'base64url').equals(
      Buffer.from(legacy.split('.')[2], 'base64url'),
    );
    const padding = await req(
      'legacy-padding-only-observation',
      legacy,
      '/api/v1/admin/devices/' + ctx.receipt.devices[0],
    );
    padding.signedPayloadBytesChanged = false;
    padding.signatureBytesEqual = signatureBytesEqual;
    padding.result = (signatureBytesEqual ? padding.status === 200 : [401, 403].includes(padding.status))
      ? 'PASS'
      : 'FAIL';
    padding.proof = 'READ_ONLY_PADDING_OBSERVATION_NOT_PRIVILEGE_ESCALATION';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const index = alphabet.indexOf(ctx.token.at(-1));
    const equivalent = ctx.token.slice(0, -1) + alphabet[index ^ 1];
    const equivalentBytes = Buffer.from(equivalent.split('.')[2], 'base64url').equals(
      Buffer.from(saParts[2], 'base64url'),
    );
    if (equivalentBytes) {
      const observation = await req(
        'guaranteed-decode-equivalent-signature-observation',
        equivalent,
        '/api/v1/admin/devices/' + ctx.receipt.devices[0],
      );
      observation.signatureBytesEqual = true;
      observation.signedPayloadBytesChanged = false;
      observation.result = [200, 401, 403].includes(observation.status) ? 'PASS' : 'FAIL';
      observation.acceptedSameAuthenticatedIdentity = observation.status === 200;
      observation.proof = 'CANONICAL_ENCODING_POLICY_OBSERVATION_NOT_PRIVILEGE_ESCALATION';
    }
    r.denialGate = r.checks.every((x) => x.result === 'PASS') ? 'PASS' : 'FAIL';
    r.strict401ContractGate = r.checks
      .filter((x) => x.contractExpected401Gate)
      .every((x) => x.contractExpected401Gate === 'PASS')
      ? 'PASS'
      : 'FAIL';
  } catch (e) {
    r.failure = { name: e.name, code: e.code ?? 'AUTH_REPRO_FAILED', causeCode: e.cause?.code };
    r.denialGate = 'FAIL';
  } finally {
    for (const own of [...r.identities].reverse())
      try {
        const session = sessions.get(own.role);
        let globalSignOut = 'NOT_RUN';
        if (session)
          try {
            await createCognitoIdpClient({ region, clientId }).globalSignOut(session.accessToken);
            globalSignOut = 'PASS';
          } catch {
            globalSignOut = 'FAIL';
          }
        await call(sdk.AdminDeleteUserCommand, { UserPoolId: pool, Username: own.username });
        let absent = false;
        try {
          await call(sdk.AdminGetUserCommand, { UserPoolId: pool, Username: own.username });
        } catch (e) {
          absent = e.name === 'UserNotFoundException';
        }
        r.cleanup.push({ username: own.username, result: absent ? 'PASS' : 'FAIL', globalSignOut });
      } catch (e) {
        r.cleanup.push({ username: own.username, result: 'FAIL', errorName: e.name });
      }
    r.finishedAt = new Date().toISOString();
    r.gate =
      r.denialGate === 'PASS' && r.strict401ContractGate === 'PASS' && r.cleanup.every((x) => x.result === 'PASS')
        ? 'PASS'
        : 'FAIL';
    save();
  }
  return r;
}
