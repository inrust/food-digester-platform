import { randomBytes, createHash, sign, X509Certificate, createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import forge from 'node-forge';
import * as cognito from '@aws-sdk/client-cognito-identity-provider';
import * as iot from '@aws-sdk/client-iot';
import { AuthFlow } from '../../../../../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../../../../../apps/admin-web/src/auth/cognito-idp.ts';
const REGION = 'ap-southeast-1',
  ACCOUNT = '065986019555',
  POOL = 'ap-southeast-1_hZMX8LpFo',
  CLIENT = '5ljdjsf9g563mc1vdc7vjdjm09';
const hash = (v) => createHash('sha256').update(v).digest('hex');
export function safeBody(b) {
  if (!b || typeof b !== 'object') return null;
  if (b.certificate)
    return {
      status: b.status,
      deviceId: b.deviceId,
      certificateSha256: hash(b.certificate.certificatePem),
      chainSha256: hash(b.certificate.certificateChain),
    };
  const select = (o) =>
    o &&
    Object.fromEntries(
      [
        'requestId',
        'id',
        'serialNumber',
        'status',
        'version',
        'lifecycleStatus',
        'certificateProvisioningStatus',
        'publicKeyFingerprint',
      ]
        .filter((k) => k in o)
        .map((k) => [k, o[k]]),
    );
  if (b.error)
    return {
      error: {
        code: b.error.code,
        requestId: b.error.requestId,
        alreadySubmitted: /already been submitted/.test(b.error.message ?? ''),
      },
    };
  if (Array.isArray(b.data)) return { data: b.data.map(select) };
  if (b.data) return { data: select(b.data) };
  return select(b);
}
export function proof(requestId, key) {
  const timestamp = String(Date.now()),
    nonce = randomBytes(24).toString('base64url');
  return {
    'X-Onboarding-Timestamp': timestamp,
    'X-Onboarding-Nonce': nonce,
    'X-Onboarding-Signature': sign(
      'sha256',
      Buffer.from(`GET\n/api/v1/device/onboarding/status\n${requestId}\n${timestamp}\n${nonce}`),
      key,
    ).toString('base64'),
  };
}
export async function main(output, versionFile) {
  if (existsSync(output)) throw Error('FRESH_RECEIPT_REQUIRED');
  const version = JSON.parse(readFileSync(versionFile));
  if (version.gate !== 'PASS' || !/^[a-f0-9]{40}$/.test(version.sourceCommit ?? ''))
    throw Error('DEPLOYMENT_VERSION_PROOF_REQUIRED');
  const prefix = 'qa09-' + randomBytes(8).toString('hex'),
    serialNumber = prefix + '-onboarding',
    username = prefix + '-onboarding-admin@example.invalid';
  const receipt = {
    scope: 'ONE_SYNTHETIC_DEVICE_REAL_TEST_API_NO_INVENTORY',
    gate: 'RUNNING',
    applicationCommit: version.sourceCommit,
    versionReceipt: versionFile,
    prefix,
    serialNumber,
    username,
    startedAt: new Date().toISOString(),
    operations: [],
    checks: [],
    cleanup: [],
    fullQa09Accepted: false,
    productionReady: false,
  };
  const save = () => writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  save();
  const check = (name, ok) => {
    receipt.checks.push({ name, result: ok ? 'PASS' : 'FAIL' });
    save();
    if (!ok) throw Error('CHECK_' + name);
  };
  const credentials = () => {
    const r = spawnSync(
      'aws',
      ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'],
      { encoding: 'utf8', timeout: 30000 },
    );
    if (r.status !== 0) throw Error('SSO_EXPIRED');
    const c = JSON.parse(r.stdout);
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  };
  const c = new cognito.CognitoIdentityProviderClient({ region: REGION, credentials, maxAttempts: 1 }),
    cloud = new iot.IoTClient({ region: REGION, credentials, maxAttempts: 1 });
  const call = async (client, command, name) => {
    const op = { name, state: 'STARTED', startedAt: new Date().toISOString() };
    receipt.operations.push(op);
    save();
    try {
      const r = await client.send(command, { abortSignal: AbortSignal.timeout(30000) });
      op.state = 'PASS';
      op.requestId = r.$metadata?.requestId;
      return r;
    } catch (e) {
      op.state = 'FAIL_OR_UNKNOWN';
      op.errorClass = e.name;
      throw e;
    } finally {
      save();
    }
  };
  let token,
    identityCreated = false;
  const api = async (name, host, method, path, expected, body, headers = {}) => {
    if (!['api.bio-nexa.com', 'onboard-api.bio-nexa.com'].includes(host) || !path.startsWith('/api/v1/'))
      throw Error('FIXED_TEST_HOST_REQUIRED');
    const op = {
      name,
      host,
      method,
      path: path.split('?')[0],
      expected,
      state: 'STARTED',
      startedAt: new Date().toISOString(),
    };
    receipt.operations.push(op);
    save();
    try {
      const r = await fetch('https://' + host + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(host === 'api.bio-nexa.com' ? { Authorization: 'Bearer ' + token } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000),
      });
      const b = await r.json();
      op.status = r.status;
      op.gatewayRequestId = r.headers.get('x-amzn-requestid');
      op.gatewayExtendedRequestId = r.headers.get('x-amz-apigw-id');
      op.body = safeBody(b);
      op.state = r.status === expected ? 'PASS' : 'FAIL';
      save();
      if (r.status !== expected) throw Error('HTTP_' + name);
      return b;
    } catch (e) {
      if (op.state === 'STARTED') op.state = 'UNKNOWN';
      op.errorClass = e.name;
      save();
      throw e;
    }
  };
  try {
    const identity = spawnSync('aws', ['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--output', 'json'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    check('test-account', identity.status === 0 && JSON.parse(identity.stdout).Account === ACCOUNT);
    const password = 'A!z9' + randomBytes(24).toString('base64url');
    await call(
      c,
      new cognito.AdminCreateUserCommand({
        UserPoolId: POOL,
        Username: username,
        MessageAction: 'SUPPRESS',
        TemporaryPassword: password,
        UserAttributes: [
          { Name: 'email', Value: username },
          { Name: 'email_verified', Value: 'true' },
        ],
      }),
      'identity-create',
    );
    identityCreated = true;
    await call(
      c,
      new cognito.AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: username, GroupName: 'PlatformSuperAdmin' }),
      'identity-group',
    );
    const flow = new AuthFlow({
      idp: createCognitoIdpClient({ region: REGION, clientId: CLIENT }),
      userPoolId: POOL,
      sessionManager: { establish() {} },
    });
    const challenge = await flow.login(username, password);
    check('real-srp-new-password-challenge', challenge.status === 'new-password-required');
    const auth = await flow.submitNewPassword('A!z9' + randomBytes(24).toString('base64url'));
    check('real-srp-authenticated', auth.status === 'authenticated');
    token = auth.session.idToken;
    const before = await api(
      'inventory-before',
      'api.bio-nexa.com',
      'GET',
      '/api/v1/admin/devices?keyword=' + serialNumber,
      200,
    );
    check('no-preseeded-inventory', Array.isArray(before.data) && before.data.length === 0);
    const pair = forge.pki.rsa.generateKeyPair(2048),
      csr = forge.pki.createCertificationRequest();
    csr.publicKey = pair.publicKey;
    csr.setSubject([{ name: 'commonName', value: serialNumber }]);
    csr.sign(pair.privateKey, forge.md.sha256.create());
    const key = forge.pki.privateKeyToPem(pair.privateKey);
    const body = {
      serialNumber,
      model: 'BNX-100',
      hardwareVersion: '1',
      manufacturer: 'Bio-Nexa',
      manufactureDate: '2026-01-01',
      csrPem: forge.pki.certificationRequestToPem(csr),
    };
    const first = await api(
      'first-request',
      'onboard-api.bio-nexa.com',
      'POST',
      '/api/v1/device/onboarding/request',
      201,
      body,
    );
    receipt.requestId = first.requestId;
    save();
    check('first-pending-id', first.status === 'PENDING' && /^[a-f0-9-]{36}$/.test(first.requestId));
    const duplicate = await api(
      'duplicate-pending',
      'onboard-api.bio-nexa.com',
      'POST',
      '/api/v1/device/onboarding/request',
      409,
      body,
    );
    check(
      'duplicate-already-submitted',
      duplicate.error?.code === 'CONFLICT' && /already been submitted/.test(duplicate.error?.message ?? ''),
    );
    const pending = await api(
      'signed-pending-status',
      'onboard-api.bio-nexa.com',
      'GET',
      '/api/v1/device/onboarding/status?requestId=' + first.requestId,
      200,
      undefined,
      proof(first.requestId, key),
    );
    check('pending-status', pending.status === 'PENDING');
    const notYet = await api(
      'inventory-before-approval',
      'api.bio-nexa.com',
      'GET',
      '/api/v1/admin/devices?keyword=' + serialNumber,
      200,
    );
    check('request-does-not-create-inventory', notYet.data.length === 0);
    const detail = await api(
      'admin-request-detail',
      'api.bio-nexa.com',
      'GET',
      '/api/v1/admin/onboarding/requests/' + first.requestId,
      200,
    );
    check('admin-pending-details', detail.data.serialNumber === serialNumber && detail.data.status === 'PENDING');
    const approved = await api(
      'admin-approve',
      'api.bio-nexa.com',
      'POST',
      '/api/v1/admin/onboarding/requests/' + first.requestId + '/approve',
      200,
      undefined,
      { 'If-Match': String(detail.data.version) },
    );
    check('approval-approved', approved.data.status === 'APPROVED');
    const after = await api(
      'inventory-after-approval',
      'api.bio-nexa.com',
      'GET',
      '/api/v1/admin/devices?keyword=' + serialNumber,
      200,
    );
    check(
      'approval-creates-one-device',
      after.data.length === 1 &&
        after.data[0].serialNumber === serialNumber &&
        after.data[0].lifecycleStatus === 'OnboardingApproved',
    );
    receipt.deviceId = after.data[0].id;
    save();
    await api('duplicate-approved', 'onboard-api.bio-nexa.com', 'POST', '/api/v1/device/onboarding/request', 409, body);
    let status;
    const deadline = Date.now() + 240000;
    do {
      status = await api(
        'signed-certificate-status',
        'onboard-api.bio-nexa.com',
        'GET',
        '/api/v1/device/onboarding/status?requestId=' + first.requestId,
        200,
        undefined,
        proof(first.requestId, key),
      );
      if (status.status === 'APPROVED') break;
      if (Date.now() > deadline) throw Error('CERTIFICATE_DEADLINE');
      await new Promise((r) => setTimeout(r, 10000));
    } while (true);
    const cert = new X509Certificate(status.certificate.certificatePem);
    check('issued-certificate-matches-local-private-key', cert.checkPrivateKey(createPrivateKey(key)));
    check('issued-device-id', status.deviceId === receipt.deviceId);
    receipt.certificateId = hash(cert.raw);
    receipt.certificateFingerprint = hash(cert.raw);
    save();
    const final = await api(
      'admin-provisioning-completed',
      'api.bio-nexa.com',
      'GET',
      '/api/v1/admin/onboarding/requests/' + first.requestId,
      200,
    );
    check('provisioning-job-completed', final.data.certificateProvisioningStatus === 'COMPLETED');
    receipt.gate = 'PASS';
  } catch (e) {
    receipt.gate = 'FAIL';
    receipt.failure = {
      code: /^[A-Za-z0-9_-]{1,100}$/.test(e.message ?? '') ? e.message : 'REDACTED_FAILURE',
      errorClass: e.name,
    };
    save();
  } finally {
    if (receipt.certificateId && receipt.deviceId) {
      try {
        const arn = `arn:aws:iot:${REGION}:${ACCOUNT}:cert/${receipt.certificateId}`;
        const linked = await call(
          cloud,
          new iot.ListPrincipalThingsCommand({ principal: arn }),
          'cleanup-principal-things',
        );
        check(
          'cleanup-only-own-thing',
          (linked.things ?? []).every((x) => x === receipt.deviceId),
        );
        const policies = await call(
          cloud,
          new iot.ListAttachedPoliciesCommand({ target: arn }),
          'cleanup-attached-policies',
        );
        check(
          'cleanup-only-own-policy',
          (policies.policies ?? []).every((x) => x.policyName === 'fdp-device-' + receipt.deviceId),
        );
        await call(
          cloud,
          new iot.UpdateCertificateCommand({ certificateId: receipt.certificateId, newStatus: 'INACTIVE' }),
          'cleanup-inactivate-certificate',
        );
        for (const thing of linked.things ?? [])
          await call(
            cloud,
            new iot.DetachThingPrincipalCommand({ thingName: thing, principal: arn }),
            'cleanup-detach-thing',
          );
        for (const policy of policies.policies ?? []) {
          await call(
            cloud,
            new iot.DetachPolicyCommand({ policyName: policy.policyName, target: arn }),
            'cleanup-detach-policy',
          );
          await call(cloud, new iot.DeletePolicyCommand({ policyName: policy.policyName }), 'cleanup-delete-policy');
        }
        await call(
          cloud,
          new iot.DeleteCertificateCommand({ certificateId: receipt.certificateId }),
          'cleanup-delete-certificate',
        );
        await call(cloud, new iot.DeleteThingCommand({ thingName: receipt.deviceId }), 'cleanup-delete-thing');
        let absent = false;
        try {
          await cloud.send(new iot.DescribeCertificateCommand({ certificateId: receipt.certificateId }));
        } catch (e) {
          if (e.name === 'ResourceNotFoundException') absent = true;
          else throw e;
        }
        check('cleanup-certificate-absent', absent);
        receipt.cleanup.push({ type: 'own-iot-resources', result: 'PASS' });
        writeFileSync(
          output + '.cleanup-plan.json',
          JSON.stringify(
            {
              prefix,
              serialNumber,
              applicationCommit: version.sourceCommit,
              action: 'cleanup',
              requestId: receipt.requestId,
              deviceId: receipt.deviceId,
              certificateIds: [receipt.certificateId],
              cloudCleanupVerified: true,
            },
            null,
            2,
          ) + '\n',
        );
      } catch (e) {
        receipt.cleanup.push({ type: 'own-iot-resources', result: 'FAIL', errorClass: e.name });
        receipt.gate = 'FAIL';
      }
    }
    if (identityCreated) {
      try {
        await call(
          c,
          new cognito.AdminUserGlobalSignOutCommand({ UserPoolId: POOL, Username: username }),
          'cleanup-global-signout',
        );
        await call(
          c,
          new cognito.AdminDeleteUserCommand({ UserPoolId: POOL, Username: username }),
          'cleanup-delete-identity',
        );
        let absent = false;
        try {
          await c.send(new cognito.AdminGetUserCommand({ UserPoolId: POOL, Username: username }));
        } catch (e) {
          if (e.name === 'UserNotFoundException') absent = true;
          else throw e;
        }
        check('cleanup-identity-absent', absent);
        receipt.cleanup.push({ type: 'identity', result: 'PASS' });
      } catch (e) {
        receipt.cleanup.push({ type: 'identity', result: 'FAIL', errorClass: e.name });
        receipt.gate = 'FAIL';
      }
    }
    receipt.finishedAt = new Date().toISOString();
    save();
  }
  console.log(
    JSON.stringify({
      gate: receipt.gate,
      prefix,
      requestId: receipt.requestId,
      deviceId: receipt.deviceId,
      checks: receipt.checks.length,
      cleanup: receipt.cleanup,
    }),
  );
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(...process.argv.slice(2))
    .then((r) => {
      process.exitCode = r.gate === 'PASS' ? 0 : 1;
    })
    .catch((e) => {
      console.error(JSON.stringify({ code: 'ACCEPTANCE_BOOTSTRAP_FAILED', errorClass: e.name }));
      process.exitCode = 1;
    });
