import {
  createOperationObserver,
  safeOperationError,
  cleanupIdentityOperations,
} from './qa09-operation-observation.mjs';
import { seedCleanupAction } from './qa09-seed-recovery.mjs';
import { qa09VersionInputs } from './qa09-version-inputs.mjs';
import { callOwnS3Cli } from './qa09-own-s3-cli.mjs';
import { randomBytes, createHash, X509Certificate, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from 'node:https';
import { readOwnArchives } from './qa09-archive-reader.mjs';
import forge from 'node-forge';
import { canonicalizeJson } from '../contracts/mqtt/payload-normalization.ts';
import { assertOwnCloudDevice } from './qa09-ten-device-db.mjs';
export { assertOwnCloudDevice } from './qa09-ten-device-db.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { SimulatedDevice } from './device-simulator/core.mjs';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { spawnSync } from 'node:child_process';
import * as cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import * as iotSdk from '@aws-sdk/client-iot';
import * as s3Sdk from '@aws-sdk/client-s3';
export function proofHeaders(
  requestId,
  key,
  timestamp = String(Date.now()),
  nonce = randomBytes(24).toString('base64url'),
) {
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
export function createCsr(deviceId) {
  const pair = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = pair.publicKey;
  csr.setSubject([{ name: 'commonName', value: deviceId }]);
  csr.sign(pair.privateKey, forge.md.sha256.create());
  return { csrPem: forge.pki.certificationRequestToPem(csr), key: forge.pki.privateKeyToPem(pair.privateKey) };
}
export function mtlsPost(cert, key) {
  return new Promise((resolve) => {
    const req = request(
      'https://device-api.bio-nexa.com/api/v1/device/sync',
      {
        method: 'POST',
        cert,
        key,
        rejectUnauthorized: true,
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let bytes = '';
        res.on('data', (b) => {
          bytes += b;
          if (bytes.length > 262144) req.destroy();
        });
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(bytes);
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode, body, requestId: res.headers['x-amzn-requestid'] ?? null });
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', (e) =>
      resolve({ status: 0, errorCode: /^[A-Z0-9_]+$/.test(e.code ?? '') ? e.code : 'TLS_FAILURE' }),
    );
    req.end('{}');
  });
}
const hash = (v) => createHash('sha256').update(v).digest('hex');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function demand(ok, code) {
  if (!ok) throw Error(code);
}
async function publishKnown(client, topic, raw) {
  let timer;
  try {
    await Promise.race([
      client.publishAsync(topic, raw, { qos: 1 }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('PUBACK_TIMEOUT')), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function validateEntityMode(options, extension) {
  if (
    !options ||
    Object.keys(options).some((k) => k !== 'reviewOnly') ||
    typeof options.reviewOnly !== 'boolean' ||
    (options.reviewOnly && typeof extension?.beforeApproval !== 'function')
  )
    throw Error('INVALID_ENTITY_REVIEW_MODE');
}
export async function main(output, versionPath, extension, options = { reviewOnly: false }) {
  validateEntityMode(options, extension);
  if (!output || !versionPath) throw Error('OUTPUT_AND_VERSION_REQUIRED');
  if (extension !== undefined && typeof extension !== 'function') throw Error('INVALID_EXTENSION');
  const version = JSON.parse(readFileSync(versionPath));
  if (
    (version.gate !== 'PASS' && version.applicationVersionGate !== 'PASS') ||
    version.sourceCommit !== qa09VersionInputs().commit
  )
    throw Error('DEPLOYED_VERSION_NOT_VERIFIED');
  const sts = spawnSync(
    'aws',
    ['sts', 'get-caller-identity', '--profile', 'esgiot-infra', '--region', 'ap-southeast-1', '--output', 'json'],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (sts.status !== 0) throw Error('SSO_IDENTITY_UNAVAILABLE');
  const identity = JSON.parse(sts.stdout);
  if (identity.Account !== '065986019555' || !identity.Arn.includes(':assumed-role/AWSReservedSSO_FDP-InfraSetup_'))
    throw Error('WRONG_TEST_ACCOUNT_OR_ROLE');
  let cachedAwsCredentials;
  const credentials = async () => {
    if (!cachedAwsCredentials || cachedAwsCredentials.expiration.getTime() < Date.now() + 300000) {
      const exported = spawnSync(
        'aws',
        ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'],
        { encoding: 'utf8', timeout: 30000 },
      );
      if (exported.status !== 0) throw Error('SSO_CREDENTIALS_UNAVAILABLE');
      const ephemeral = JSON.parse(exported.stdout);
      cachedAwsCredentials = {
        accessKeyId: ephemeral.AccessKeyId,
        secretAccessKey: ephemeral.SecretAccessKey,
        sessionToken: ephemeral.SessionToken,
        expiration: new Date(ephemeral.Expiration),
      };
    }
    return cachedAwsCredentials;
  };
  const region = 'ap-southeast-1';
  const cognito = new cognitoSdk.CognitoIdentityProviderClient({ region, credentials, maxAttempts: 1 });
  const iot = new iotSdk.IoTClient({ region, credentials, maxAttempts: 1 });
  const s3 = new s3Sdk.S3Client({ region, credentials, maxAttempts: 1 });
  const prefix = `qa09-${randomBytes(8).toString('hex')}`,
    devices = Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`);
  const username = `${prefix}-platformsuperadmin@example.invalid`,
    pool = 'ap-southeast-1_hZMX8LpFo';
  const receipt = {
    task: 'QA-09',
    scope: options.reviewOnly ? 'PENDING_CSR_ENTITY_REVIEW_ONLY' : 'TEN_DEVICE_CSR_MTLS_HEARTBEAT_TELEMETRY_ARCHIVE',
    reviewOnly: options.reviewOnly,
    mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
    target: { accountId: identity.Account, region: 'ap-southeast-1', stackName: 'fdp-test-app' },
    sourceCommit: version.sourceCommit,
    versionBinding: qa09VersionInputs(),
    executorSha256: hash(readFileSync(new URL(import.meta.url))),
    versionReceipt: versionPath,
    artifactByteReceipt: version.byteReceipt ?? versionPath,
    startedAt: new Date().toISOString(),
    prefix,
    devices,
    customers: [],
    checks: [],
    published: [],
    databaseBuilds: [],
    archiveObjects: [],
    cleanup: [],
    cleanupOperations: [],
    gate: 'RUNNING',
    fullQa09Accepted: false,
  };
  const save = () => writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  save();
  const observeCleanup = createOperationObserver(receipt.cleanupOperations, save);
  let cleaning = false;
  const check = (id, ok, data = {}) => {
    receipt.checks.push({ id, result: ok ? 'PASS' : 'FAIL', ...data });
    save();
    if (!ok) throw Object.assign(Error('ASSERTION_FAILED'), { code: id });
  };
  let token, accessToken, browserLogin;
  let createdIdentity = false,
    seeded = false;
  let baseline;
  const held = new Map(),
    clients = [];
  let observation;
  async function api(id, method, path, expected, body, headers = {}, host = 'api.bio-nexa.com') {
    const run = () => executeApi(id, method, path, expected, body, headers, host);
    return cleaning ? observeCleanup('http:' + id, run) : run();
  }
  async function executeApi(id, method, path, expected, body, headers = {}, host = 'api.bio-nexa.com') {
    const startedAt = new Date().toISOString(),
      start = performance.now();
    let res;
    try {
      res = await fetch(`https://${host}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(host === 'api.bio-nexa.com' ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      const safe = (value) => (typeof value === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(value) ? value : null);
      check(id, false, {
        method,
        path: path.split('?')[0],
        role: host === 'api.bio-nexa.com' ? 'PlatformSuperAdmin' : 'anonymous',
        startedAt,
        responseReceived: false,
        errorClass: safe(e.name),
        causeCode: safe(e.cause?.code),
        latencyMs: Math.round(performance.now() - start),
      });
      throw e;
    }
    const parsed = await res.json().catch(() => null);
    check(id, res.status === expected, {
      method,
      path: path.split('?')[0],
      role: host === 'api.bio-nexa.com' ? 'PlatformSuperAdmin' : 'anonymous',
      status: res.status,
      expected,
      startedAt,
      latencyMs: Math.round(performance.now() - start),
      gatewayRequestId: res.headers.get('x-amzn-requestid'),
      gatewayExtendedRequestId: res.headers.get('x-amz-apigw-id'),
      gatewayErrorType: res.headers.get('x-amzn-errortype'),
      requestId: parsed?.meta?.requestId ?? parsed?.error?.requestId ?? res.headers.get('x-amzn-requestid'),
      errorCode: parsed?.error?.code ?? null,
    });
    return parsed;
  }
  async function db(action) {
    const plan = { prefix, devices, customers: receipt.customers, action, ...(baseline ? { baseline } : {}) };
    const path = output + `.${action}-${receipt.databaseBuilds.length}.json`;
    receipt.databaseBuilds.push({ action, receipt: path, gate: 'RUNNING' });
    save();
    const run = () => runFixture(plan, path, (msg) => console.log(msg));
    let result;
    try {
      result = await (cleaning ? observeCleanup('database:' + action, run) : run());
    } catch (error) {
      Object.assign(receipt.databaseBuilds.at(-1), { gate: 'FAIL', failure: safeOperationError(error) });
      save();
      throw error;
    }
    Object.assign(receipt.databaseBuilds.at(-1), { buildId: result.build.id, gate: result.gate });
    save();
    return result.result;
  }
  const call = (client, command, input) => {
    const run = () => send(client, command, input);
    return cleaning ? observeCleanup('aws:' + command.name, run) : run();
  };
  const send = (client, command, input) => {
    if (client === s3) {
      const actions = new Map([
        [s3Sdk.ListObjectsV2Command, 'list-objects-v2'],
        [s3Sdk.ListObjectVersionsCommand, 'list-object-versions'],
        [s3Sdk.DeleteObjectsCommand, 'delete-objects'],
        [s3Sdk.DeleteObjectCommand, 'delete-object'],
      ]);
      return callOwnS3Cli(
        actions.get(command),
        input,
        receipt.customers.map((x) => x.id),
      );
    }
    return client.send(new command(input), { abortSignal: AbortSignal.timeout(30000) });
  };
  const refreshIdentity = async () => {
    if (!createdIdentity || browserLogin?.username !== username) throw Error('OWN_IDENTITY_REQUIRED');
    const flow = new AuthFlow({
      idp: createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
      userPoolId: pool,
      sessionManager: { establish() {} },
    });
    const auth = await flow.login(browserLogin.username, browserLogin.password);
    check('dedicated-real-srp-renewal', auth.status === 'authenticated');
    token = auth.session.idToken;
    accessToken = auth.session.accessToken;
    return auth.session;
  };
  try {
    const temporaryPassword = `A!z9${randomBytes(24).toString('base64url')}`;
    await call(cognito, cognitoSdk.AdminCreateUserCommand, {
      UserPoolId: pool,
      Username: username,
      MessageAction: 'SUPPRESS',
      TemporaryPassword: temporaryPassword,
      UserAttributes: [
        { Name: 'email', Value: username },
        { Name: 'email_verified', Value: 'true' },
      ],
    }).then(async () => {
      createdIdentity = true;
      receipt.identity = { username, created: true };
      save();
      await call(cognito, cognitoSdk.AdminAddUserToGroupCommand, {
        UserPoolId: pool,
        Username: username,
        GroupName: 'PlatformSuperAdmin',
      });
      const flow = new AuthFlow({
        idp: createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
        userPoolId: pool,
        sessionManager: { establish() {} },
      });
      const first = await flow.login(username, temporaryPassword);
      check('dedicated-first-login-challenge', first.status === 'new-password-required');
      const password = `A!z9${randomBytes(24).toString('base64url')}`;
      const auth = await flow.submitNewPassword(password);
      browserLogin = { username, password };
      check('dedicated-real-srp', auth.status === 'authenticated');
      token = auth.session.idToken;
      accessToken = auth.session.accessToken;
    });
    for (const suffix of ['a', 'b']) {
      const r = await api('create-customer-' + suffix, 'POST', '/api/v1/admin/customers', 201, {
        name: `${prefix}-${suffix}`,
      });
      receipt.customers.push({ id: r.data.id, name: r.data.name, suffix, version: r.data.version });
      save();
    }
    const unseeded = await db('observe');
    check(
      'unseeded-prefix-empty',
      !unseeded.devices.length && !unseeded.certificates.length && !unseeded.requests.length,
    );
    baseline = unseeded.originalFingerprints;
    seeded = true;
    const seededResult = await db('seed');
    check(
      'seed-original-baseline-preserved',
      JSON.stringify(baseline) === JSON.stringify(seededResult.originalFingerprints),
    );
    save();
    for (const id of devices) {
      assertOwnCloudDevice(id, prefix);
      const key = createCsr(id);
      held.set(id, key);
      const body = {
        serialNumber: id,
        model: 'BNX-100',
        hardwareVersion: '1',
        manufacturer: 'Bio-Nexa',
        manufactureDate: '2026-01-01',
        csrPem: key.csrPem,
      };
      const r = await api(
        id + ':csr-create',
        'POST',
        '/api/v1/device/onboarding/request',
        201,
        body,
        {},
        'onboard-api.bio-nexa.com',
      );
      key.requestId = r.requestId;
      receipt.checks.at(-1).businessRequestId = r.requestId;
      save();
      if (id === devices[0]) {
        await api(
          id + ':same-csr-idempotent',
          'POST',
          '/api/v1/device/onboarding/request',
          200,
          body,
          {},
          'onboard-api.bio-nexa.com',
        );
        const other = createCsr(id);
        await api(
          id + ':different-key-conflict',
          'POST',
          '/api/v1/device/onboarding/request',
          409,
          { ...body, csrPem: other.csrPem },
          {},
          'onboard-api.bio-nexa.com',
        );
        const headers = proofHeaders(r.requestId, key.key);
        await api(
          id + ':signed-pending',
          'GET',
          `/api/v1/device/onboarding/status?requestId=${r.requestId}`,
          200,
          undefined,
          headers,
          'onboard-api.bio-nexa.com',
        );
        await api(
          id + ':nonce-replay-denied',
          'GET',
          `/api/v1/device/onboarding/status?requestId=${r.requestId}`,
          401,
          undefined,
          headers,
          'onboard-api.bio-nexa.com',
        );
        await api(
          id + ':wrong-key-denied',
          'GET',
          `/api/v1/device/onboarding/status?requestId=${r.requestId}`,
          401,
          undefined,
          proofHeaders(r.requestId, other.key),
          'onboard-api.bio-nexa.com',
        );
      }
      const detail = await api(id + ':admin-detail', 'GET', `/api/v1/admin/onboarding/requests/${r.requestId}`, 200);
      if (options.reviewOnly) {
        await extension.beforeApproval({
          api,
          prefix,
          devices,
          id,
          requestId: r.requestId,
          detail: detail.data,
          browserLogin,
        });
      } else {
        await api(id + ':approve', 'POST', `/api/v1/admin/onboarding/requests/${r.requestId}/approve`, 200, undefined, {
          'If-Match': String(detail.data.version),
        });
      }
    }
    if (options.reviewOnly) {
      const deadline = Date.now() + 300000;
      while (true) {
        const observed = await db('observe');
        if (observed.jobs.some((j) => j.status === 'FAILED')) throw Error('CSR_PROVISIONING_FAILED');
        if (!observed.jobs.some((j) => ['PENDING', 'PROCESSING'].includes(j.status))) {
          check(
            'review-only-exact-decisions',
            observed.requests.filter((r) => r.status === 'APPROVED').length === 2 &&
              observed.requests.filter((r) => r.status === 'REJECTED').length === 2 &&
              observed.requests.filter((r) => r.status === 'PENDING').length === 6 &&
              observed.certificates.length === 2,
          );
          break;
        }
        if (Date.now() > deadline) throw Error('CSR_PROVISIONING_STILL_RUNNING');
      }
      receipt.gate = 'PASS';
      return receipt;
    }
    console.log('Ten CSR requests approved; waiting for real scheduled provisioning.');
    const end = Date.now() + 300000;
    while ([...held.values()].some((k) => !k.cert)) {
      for (const [id, k] of held) {
        if (k.cert) continue;
        await pause(3500);
        const path = `/api/v1/device/onboarding/status?requestId=${k.requestId}`;
        const res = await fetch('https://onboard-api.bio-nexa.com' + path, {
          headers: proofHeaders(k.requestId, k.key),
          signal: AbortSignal.timeout(20000),
        });
        const body = await res.json();
        if (res.status === 429) {
          await pause(15000);
          continue;
        }
        check(id + ':signed-status-' + receipt.checks.length, res.status === 200, { status: res.status });
        if (body.status !== 'APPROVED') {
          if (Date.now() > end) throw Error('PROVISIONING_TIMEOUT');
          continue;
        }
        const cert = new X509Certificate(body.certificate.certificatePem);
        check(
          id + ':csr-key-certificate-match',
          body.deviceId === id &&
            cert.checkPrivateKey(createPrivateKey(k.key)) &&
            !JSON.stringify(body).includes('PRIVATE KEY'),
        );
        check(
          id + ':target-endpoints',
          body.rest.endpoint.startsWith('https://device-api.bio-nexa.com') &&
            /^[a-z0-9-]+\.iot\.ap-southeast-1\.amazonaws\.com$/.test(body.mqtt.endpoint),
        );
        k.cert = body.certificate.certificatePem;
        k.endpoint = body.mqtt.endpoint;
        k.fingerprint = hash(cert.raw);
      }
    }
    const { connectAsync } = await import('mqtt');
    const connected = await Promise.allSettled(
      [...held].map(async ([id, k]) => {
        const mqtt = await connectAsync(`mqtts://${k.endpoint}:8883`, {
          clientId: id,
          cert: k.cert,
          key: k.key,
          rejectUnauthorized: true,
          protocolVersion: 4,
          clean: true,
          reconnectPeriod: 0,
          connectTimeout: 15000,
        });
        mqtt.on('error', () => {});
        clients.push(mqtt);
        k.client = mqtt;
        const sim = new SimulatedDevice(id, {}, {});
        k.sim = sim;
        const payload = sim.payload('heartbeat'),
          raw = JSON.stringify(payload);
        await publishKnown(mqtt, `bnx/device/${id}/heartbeat`, raw);
        receipt.published.push({
          deviceId: id,
          type: 'heartbeat',
          seq: payload.meta.seq,
          messageId: payload.meta.id,
          bodySha256: hash(raw),
          payloadSha256: hash(canonicalizeJson(JSON.parse(raw))),
        });
        save();
      }),
    );
    check(
      'ten-concurrent-independent-mqtt-sessions',
      connected.every((r) => r.status === 'fulfilled') && clients.length === 10 && clients.every((c) => c.connected),
      {
        count: clients.length,
        keyFingerprints: [...held.values()].map((k) =>
          hash(createPublicKey(k.key).export({ type: 'spki', format: 'der' })),
        ),
      },
    );
    console.log('Ten real MQTT sessions and heartbeats published; observing RDS.');
    observation = await db('observe');
    check(
      'first-heartbeat-completes-ten-onboardings',
      observation.devices.length === 10 && observation.devices.every((d) => d.lifecycle_status === 'Onboarded'),
    );
    check(
      'claimed-certificate-identities-match-rds',
      observation.certificates.length === 10 &&
        observation.certificates.every((c) => held.get(c.device_id)?.fingerprint === c.fingerprint),
    );
    check(
      'ten-active-packages-destroyed',
      observation.certificates.length === 10 &&
        observation.certificates.every((c) => c.status === 'ACTIVE' && c.package_destroyed && c.mqtt_verified_at),
    );
    for (const [id, k] of held) {
      const startedAt = new Date().toISOString(),
        start = performance.now();
      const res = await mtlsPost(k.cert, k.key);
      check(
        id + ':real-mtls-sync',
        res.status === 200 && (res.body?.deviceId === id || res.body?.device?.deviceId === id),
        {
          status: res.status,
          requestId: res.requestId,
          errorCode: res.errorCode ?? null,
          startedAt,
          latencyMs: Math.round(performance.now() - start),
        },
      );
    }
    const missing = await mtlsPost();
    check(
      'rest-no-client-certificate-denied',
      (missing.status === 0 &&
        ['ECONNRESET', 'EPROTO', 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED'].includes(missing.errorCode)) ||
        [401, 403].includes(missing.status),
      {
        status: missing.status,
        errorCode: missing.errorCode ?? null,
      },
    );
    const testKey = forge.pki.privateKeyFromPem(held.get(devices[0]).key);
    const untrusted = forge.pki.createCertificate();
    untrusted.publicKey = forge.pki.rsa.setPublicKey(testKey.n, testKey.e);
    untrusted.serialNumber = randomBytes(16).toString('hex');
    untrusted.validity.notBefore = new Date(Date.now() - 60000);
    untrusted.validity.notAfter = new Date(Date.now() + 3600000);
    untrusted.setSubject([{ name: 'commonName', value: prefix }]);
    untrusted.setIssuer(untrusted.subject.attributes);
    untrusted.sign(testKey, forge.md.sha256.create());
    const rejected = await mtlsPost(forge.pki.certificateToPem(untrusted), held.get(devices[0]).key);
    check(
      'rest-untrusted-client-certificate-denied',
      (rejected.status === 0 &&
        ['ECONNRESET', 'EPROTO', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE'].includes(
          rejected.errorCode,
        )) ||
        [401, 403].includes(rejected.status),
      { status: rejected.status, errorCode: rejected.errorCode ?? null },
    );
    for (const [id, k] of held) {
      for (let i = 0; i < 2; i++) {
        const p = k.sim.payload('telemetry'),
          raw = JSON.stringify(p);
        await publishKnown(k.client, `bnx/device/${id}/telemetry`, raw);
        receipt.published.push({
          deviceId: id,
          type: 'telemetry',
          seq: p.meta.seq,
          messageId: p.meta.id,
          bodySha256: hash(raw),
          payloadSha256: hash(canonicalizeJson(JSON.parse(raw))),
        });
        if (i === 0) await publishKnown(k.client, `bnx/device/${id}/telemetry`, raw);
        save();
        if (i === 0) await pause(10000);
      }
    }
    const first = held.get(devices[0]);
    await first.client.endAsync(true);
    const unauthorized = await connectAsync(`mqtts://${first.endpoint}:8883`, {
      clientId: devices[0],
      cert: first.cert,
      key: first.key,
      rejectUnauthorized: true,
      protocolVersion: 4,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 15000,
    });
    unauthorized.on('error', () => {});
    clients.push(unauthorized);
    let closed = false;
    unauthorized.on('close', () => {
      closed = true;
    });
    let grantDenied = false;
    await Promise.race([
      unauthorized
        .subscribeAsync(`bnx/device/${devices[1]}/cmd`, { qos: 1 })
        .then((grants) => {
          grantDenied = grants.some((g) => g.qos === 128);
        })
        .catch((e) => {
          grantDenied = e.code === 128;
        }),
      pause(10000),
    ]);
    check('aws-cross-device-subscription-denied', grantDenied || closed, {
      brokerClosed: closed,
      subackDenied: grantDenied,
    });
    await unauthorized.endAsync(true);
    const cross = await connectAsync(`mqtts://${first.endpoint}:8883`, {
      clientId: devices[0],
      cert: first.cert,
      key: first.key,
      rejectUnauthorized: true,
      protocolVersion: 4,
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 15000,
    });
    cross.on('error', () => {});
    clients.push(cross);
    let puback = false,
      publishClosed = false;
    cross.on('close', () => {
      publishClosed = true;
    });
    const raw = JSON.stringify(first.sim.payload('heartbeat'));
    await Promise.race([
      cross
        .publishAsync(`bnx/device/${devices[1]}/heartbeat`, raw, { qos: 1 })
        .then(() => {
          puback = true;
        })
        .catch(() => {}),
      pause(10000),
    ]);
    check('aws-cross-device-publish-denied', publishClosed && !puback, { brokerClosed: publishClosed, puback });
    await cross.endAsync(true);
    console.log('Telemetry and identical QoS1 duplicates published; observing ingestion/outbox.');
    observation = await db('observe');
    check(
      'exactly-two-business-samples-per-device',
      observation.telemetrySamples.length === 10 && observation.telemetrySamples.every((t) => t.samples === '2'),
    );
    check(
      'exactly-thirty-unique-ingestion-receipts',
      observation.receipts.length === 30 && observation.receipts.every((r) => r.result === 'PROCESSED'),
      { count: observation.receipts.length },
    );
    check(
      'all-mqtt-and-rest-proofs-recorded',
      observation.certificates.every((c) => c.mqtt_verified_at && c.rest_verified_at),
    );
    check(
      'telemetry-outbox-published',
      observation.outbox.filter((o) => o.event_type === 'ARCHIVE' && o.topicType === 'telemetry').length === 20 &&
        observation.outbox
          .filter((o) => o.event_type === 'ARCHIVE' && o.topicType === 'telemetry')
          .every((o) => o.status === 'PUBLISHED'),
    );
    const archiveRead = await readOwnArchives(receipt, observation, output + '.archive-read.json');
    receipt.archiveReaderEvidence = archiveRead;
    receipt.archiveReaderReceipt = output + '.archive-read.json';
    receipt.archiveKeys = archiveRead.result.archiveKeys;
    receipt.archiveObjects = archiveRead.result.archiveObjects;
    for (const proof of archiveRead.result.checks) check(proof.id, proof.result === 'PASS', proof);
    check('all-twenty-telemetry-archived', archiveRead.result.allTelemetryArchived === true, {
      archivedMessages: archiveRead.result.archivedMessages,
    });
    save();
    if (extension)
      await extension({
        receipt,
        held,
        token,
        accessToken,
        browserLogin,
        cognito,
        credentials,
        baseline,
        api,
        refreshIdentity,
      });
    receipt.gate = 'PASS';
  } catch (e) {
    receipt.gate = 'FAIL';
    const failureCode =
      e.code ?? (/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message ?? '') ? e.message : 'TEN_DEVICE_EXECUTION_FAILED');
    receipt.failure = {
      code: /^[A-Za-z0-9:_-]+$/.test(failureCode) ? failureCode : 'TEN_DEVICE_EXECUTION_FAILED',
      errorClass: /^[A-Za-z0-9]+$/.test(e.name ?? '') ? e.name : 'Error',
    };
    save();
    console.log('Ten-device acceptance failed; cleaning exact own fixtures.');
  } finally {
    cleaning = true;
    for (const c of clients) await c.endAsync(true).catch(() => {});
    if (createdIdentity)
      try {
        await observeCleanup('identity:refresh', refreshIdentity);
      } catch (e) {
        receipt.cleanup.push({
          type: 'identity-refresh-before-cleanup',
          result: 'FAIL',
          failure: safeOperationError(e),
        });
        receipt.gate = 'FAIL';
        save();
      }
    // Discover only certificates linked to the exact ten ledger devices, including partially-provisioned fixtures.
    if (seeded) {
      try {
        const current = await db('observe');
        for (const cert of current.certificates) {
          assertOwnCloudDevice(cert.device_id, prefix);
          const arn = `arn:aws:iot:${region}:065986019555:cert/${cert.id}`;
          const principals = await call(iot, iotSdk.ListPrincipalThingsCommand, { principal: arn });
          if ((principals.things ?? []).some((t) => !devices.includes(t))) demand(false, 'CERTIFICATE_SCOPE_DRIFT');
          await call(iot, iotSdk.UpdateCertificateCommand, { certificateId: cert.id, newStatus: 'INACTIVE' });
          for (const thing of principals.things ?? [])
            await call(iot, iotSdk.DetachThingPrincipalCommand, { thingName: thing, principal: arn });
          const policies = await call(iot, iotSdk.ListAttachedPoliciesCommand, { target: arn });
          for (const policy of policies.policies ?? []) {
            if (policy.policyName !== `fdp-device-${cert.device_id}`) demand(false, 'POLICY_SCOPE_DRIFT');
            await call(iot, iotSdk.DetachPolicyCommand, { policyName: policy.policyName, target: arn });
            await call(iot, iotSdk.DeletePolicyCommand, { policyName: policy.policyName });
          }
          await call(iot, iotSdk.DeleteCertificateCommand, { certificateId: cert.id });
          receipt.cleanup.push({ type: 'iot-certificate', id: cert.id, result: 'PASS' });
          save();
        }
        for (const id of devices) {
          try {
            await call(iot, iotSdk.DeleteThingCommand, { thingName: id });
          } catch (e) {
            demand(e.name === 'ResourceNotFoundException', 'THING_DELETE_FAILED');
          }
        }
        if (seedCleanupAction(current, devices) === 'cleanup') await db('cleanup');
        receipt.cleanup.push({ type: 'database-fixtures', count: current.devices.length, result: 'PASS' });
        save();
      } catch (e) {
        receipt.cleanup.push({ type: 'cloud-and-database-fixtures', result: 'FAIL', failure: safeOperationError(e) });
        receipt.gate = 'FAIL';
        save();
      }
    }
    if (receipt.published.length && !receipt.archiveKeys) {
      receipt.archiveKeys = [];
      try {
        for (const c of receipt.customers) {
          for (const type of ['heartbeat', 'telemetry', 'ack']) {
            let continuation;
            do {
              const page = await call(s3, s3Sdk.ListObjectsV2Command, {
                Bucket: 'fdp-test-raw-065986019555',
                Prefix: `raw/topic_type=${type}/customer_id=${c.id}/`,
                ContinuationToken: continuation,
              });
              for (const obj of page.Contents ?? []) receipt.archiveKeys.push(obj.Key);
              continuation = page.NextContinuationToken;
            } while (continuation);
          }
        }
      } catch (e) {
        receipt.gate = 'FAIL';
        receipt.cleanup.push({ type: 'archive-discovery', result: 'FAIL', failure: safeOperationError(e) });
      }
      save();
    }
    if (receipt.batchArchiveCleanup) {
      try {
        const owned = [];
        for (const c of receipt.customers)
          for (const type of ['heartbeat', 'telemetry', 'ack']) {
            const prefix = `raw/topic_type=${type}/customer_id=${c.id}/`;
            let marker, versionMarker;
            do {
              const page = await call(s3, s3Sdk.ListObjectVersionsCommand, {
                Bucket: 'fdp-test-raw-065986019555',
                Prefix: prefix,
                KeyMarker: marker,
                VersionIdMarker: versionMarker,
              });
              for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
                demand(item.Key.startsWith(prefix), 'ARCHIVE_SCOPE_DRIFT');
                owned.push({ Key: item.Key, VersionId: item.VersionId });
              }
              marker = page.IsTruncated ? page.NextKeyMarker : undefined;
              versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
            } while (marker);
          }
        for (let i = 0; i < owned.length; i += 1000) {
          const result = await call(s3, s3Sdk.DeleteObjectsCommand, {
            Bucket: 'fdp-test-raw-065986019555',
            Delete: { Objects: owned.slice(i, i + 1000), Quiet: false },
          });
          demand(!result.Errors?.length, 'ARCHIVE_DELETE_PARTIAL_FAILURE');
        }
        for (const c of receipt.customers)
          for (const type of ['heartbeat', 'telemetry', 'ack']) {
            const result = await call(s3, s3Sdk.ListObjectVersionsCommand, {
              Bucket: 'fdp-test-raw-065986019555',
              Prefix: `raw/topic_type=${type}/customer_id=${c.id}/`,
            });
            demand(
              !result.Versions?.length && !result.DeleteMarkers?.length && !result.IsTruncated,
              'ARCHIVE_CLEANUP_NOT_EMPTY',
            );
          }
        receipt.cleanup.push({ type: 'archive-batch-owned-prefix', count: owned.length, result: 'PASS' });
        save();
      } catch (e) {
        const errorCode = /^[A-Za-z0-9:_-]+$/.test(e.code ?? e.message ?? '')
          ? (e.code ?? e.message)
          : 'ARCHIVE_CLEANUP_FAILED';
        receipt.cleanup.push({ type: 'archive-batch-owned-prefix', result: 'FAIL', errorCode });
        receipt.gate = 'FAIL';
        save();
      }
    }
    if (!receipt.batchArchiveCleanup)
      for (const key of receipt.archiveKeys ?? []) {
        try {
          if (!receipt.customers.some((c) => key.includes(`/customer_id=${c.id}/`)))
            demand(false, 'ARCHIVE_SCOPE_DRIFT');
          const versions = await call(s3, s3Sdk.ListObjectVersionsCommand, {
            Bucket: 'fdp-test-raw-065986019555',
            Prefix: key,
          });
          const ownVersions = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].filter(
            (v) => v.Key === key,
          );
          for (const v of ownVersions)
            await call(s3, s3Sdk.DeleteObjectCommand, {
              Bucket: 'fdp-test-raw-065986019555',
              Key: key,
              VersionId: v.VersionId,
            });
          if (!ownVersions.length)
            await call(s3, s3Sdk.DeleteObjectCommand, { Bucket: 'fdp-test-raw-065986019555', Key: key });
          const remaining = await call(s3, s3Sdk.ListObjectVersionsCommand, {
            Bucket: 'fdp-test-raw-065986019555',
            Prefix: key,
          });
          demand(
            ![...(remaining.Versions ?? []), ...(remaining.DeleteMarkers ?? [])].some((v) => v.Key === key),
            'ARCHIVE_VERSION_STILL_EXISTS',
          );
          receipt.cleanup.push({ type: 'archive-object', key, result: 'PASS' });
        } catch (e) {
          receipt.gate = 'FAIL';
          const errorCode = /^[A-Za-z0-9:_-]+$/.test(e.code ?? e.message ?? '')
            ? (e.code ?? e.message)
            : 'ARCHIVE_CLEANUP_FAILED';
          receipt.cleanup.push({ type: 'archive-object', key, result: 'FAIL', errorCode });
        }
        save();
      }
    for (const c of [...receipt.customers].reverse()) {
      try {
        const owned = await api('cleanup-customer-scope-' + c.suffix, 'GET', `/api/v1/admin/customers/${c.id}`, 200);
        demand(owned.data.name === `${prefix}-${c.suffix}`, 'CUSTOMER_SCOPE_DRIFT');
        c.version = owned.data.version;
        await api('cleanup-customer-' + c.suffix, 'DELETE', `/api/v1/admin/customers/${c.id}`, 200, undefined, {
          'If-Match': String(c.version),
        });
        await api('verify-customer-gone-' + c.suffix, 'GET', `/api/v1/admin/customers/${c.id}`, 404);
        receipt.cleanup.push({ type: 'customer', id: c.id, result: 'PASS' });
      } catch (e) {
        receipt.gate = 'FAIL';
        receipt.cleanup.push({ type: 'customer', id: c.id, result: 'FAIL', failure: safeOperationError(e) });
      }
      save();
    }
    if (createdIdentity) {
      const result = await cleanupIdentityOperations(observeCleanup, {
        globalSignOut: () =>
          accessToken
            ? createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }).globalSignOut(accessToken)
            : cognito.send(new cognitoSdk.AdminUserGlobalSignOutCommand({ UserPoolId: pool, Username: username }), {
                abortSignal: AbortSignal.timeout(30000),
              }),
        deleteUser: () =>
          cognito.send(new cognitoSdk.AdminDeleteUserCommand({ UserPoolId: pool, Username: username }), {
            abortSignal: AbortSignal.timeout(30000),
          }),
        getUser: () =>
          cognito.send(new cognitoSdk.AdminGetUserCommand({ UserPoolId: pool, Username: username }), {
            abortSignal: AbortSignal.timeout(30000),
          }),
      });
      if (result.result !== 'PASS') receipt.gate = 'FAIL';
      receipt.cleanup.push({ type: 'identity', username, ...result });
      save();
    }
    held.clear();
    token = undefined;
    accessToken = undefined;
    receipt.finishedAt = new Date().toISOString();
    save();
  }
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(...process.argv.slice(2))
    .then((r) => {
      console.log(JSON.stringify({ gate: r.gate, prefix: r.prefix, checks: r.checks.length, cleanup: r.cleanup }));
      process.exitCode = r.gate === 'PASS' ? 0 : 1;
    })
    .catch(() => {
      console.error('QA09_TEN_DEVICE_START_FAILED');
      process.exitCode = 1;
    });
