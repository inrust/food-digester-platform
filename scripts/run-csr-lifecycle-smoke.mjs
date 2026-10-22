/** One real application-created device; no certificate or lifecycle database fixtures. */
import { randomBytes, createHash, X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { connect } from 'mqtt';
import forge from 'node-forge';
import * as cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { createCsr, proofHeaders, publishKnown, mtlsPost } from './run-qa09-ten-device-acceptance.mjs';
import { request } from 'node:https';
import { observeMqttConnect, oldMqttDenial } from './qa09-bounded-mqtt-connect.mjs';
import { SimulatedDevice } from './device-simulator/core.mjs';
import { validateScope } from './csr-lifecycle-fixture.mjs';
const region = 'ap-southeast-1',
  account = '065986019555',
  pool = 'ap-southeast-1_hZMX8LpFo';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function deviceRequest(cert, key, path, body) {
  if (path !== '/api/v1/device/certificate/rotate') throw Error('FIXED_ROTATION_PATH_REQUIRED');
  return new Promise((resolve) => {
    const req = request(
      'https://device-api.bio-nexa.com' + path,
      {
        method: 'POST',
        cert,
        key,
        rejectUnauthorized: true,
        timeout: 25000,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let raw = '';
        res.on('data', (b) => {
          raw += b;
          if (raw.length > 262144) req.destroy();
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed, requestId: res.headers['x-amzn-requestid'] ?? null });
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', (e) =>
      resolve({ status: 0, errorCode: /^[A-Z0-9_]+$/.test(e.code ?? '') ? e.code : 'TLS_FAILURE' }),
    );
    req.end(JSON.stringify(body));
  });
}
export function inspectCertificate(pem, chainPem, key, deviceId) {
  const cert = new X509Certificate(pem),
    leaf = forge.pki.certificateFromPem(pem);
  const chain = (chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []).map(
    (p) => new X509Certificate(p),
  );
  if (
    !chain.length ||
    !cert.checkPrivateKey(createPrivateKey(key)) ||
    cert.subject !== `CN=${deviceId}` ||
    !cert.subjectAltName?.split(', ').includes(`URI:urn:fdp:device:${deviceId}`) ||
    !leaf.getExtension('keyUsage')?.digitalSignature ||
    !leaf.getExtension('extKeyUsage')?.clientAuth
  )
    throw Error('INVALID_DEVICE_CERTIFICATE');
  for (const [i, c] of [cert, ...chain].entries()) {
    const parent = chain[i] ?? c;
    if (
      !c.checkIssued(parent) ||
      !c.verify(parent.publicKey) ||
      (i > 0 && !c.ca) ||
      Date.now() < Date.parse(c.validFrom) ||
      Date.now() >= Date.parse(c.validTo)
    )
      throw Error('INVALID_CA_CHAIN');
  }
  return {
    fingerprint: sha(cert.raw),
    publicKeyFingerprint: sha(cert.publicKey.export({ type: 'spki', format: 'der' })),
    subject: cert.subject,
    san: cert.subjectAltName,
    issuer: cert.issuer,
    notBefore: cert.validFrom,
    notAfter: cert.validTo,
    digitalSignature: true,
    clientAuth: true,
    chainFingerprints: chain.map((c) => sha(c.raw)),
  };
}
export function singleChannelProof(state, oldId, newId, channel) {
  const old = state.certificates.find((c) => c.id === oldId),
    next = state.certificates.find((c) => c.id === newId);
  return (
    old?.status === 'ACTIVE' &&
    !old.revoked_at &&
    next?.status === 'ACTIVE' &&
    next.rotated_from_id === oldId &&
    !next.rotation_confirmed_at &&
    !!next[channel + '_verified_at'] &&
    !next[(channel === 'mqtt' ? 'rest' : 'mqtt') + '_verified_at']
  );
}
export function dualChannelProof(state, oldId, newId) {
  const old = state.certificates.find((c) => c.id === oldId),
    next = state.certificates.find((c) => c.id === newId);
  return (
    old?.status === 'REVOKED' &&
    !!old.revoked_at &&
    next?.status === 'ACTIVE' &&
    next.rotated_from_id === oldId &&
    !!next.mqtt_verified_at &&
    !!next.rest_verified_at &&
    !!next.rotation_confirmed_at &&
    next.package_destroyed &&
    Date.parse(next.rotation_confirmed_at) < Date.parse(next.rotation_deadline_at)
  );
}
export async function main(output) {
  if (process.env.FDP_CSR_LIFECYCLE_TEST !== '1' || !output || existsSync(output))
    throw Error('EXPLICIT_ENABLE_AND_FRESH_OUTPUT_REQUIRED');
  const dir = dirname(resolve(output));
  mkdirSync(dir, { recursive: true });
  const serial = 'csrprobe-' + randomBytes(8).toString('hex');
  const scope = validateScope({ serial, username: serial + '@example.invalid' });
  const name = 'fdp-test-qa09-' + scope.serial;
  const sourceFiles = [
    'scripts/run-csr-lifecycle-smoke.mjs',
    'scripts/csr-lifecycle-fixture.mjs',
    'scripts/run-qa09-ten-device-acceptance.mjs',
    'scripts/run-qa09-a467-target.mjs',
    'scripts/qa09-bounded-mqtt-connect.mjs',
    'scripts/device-simulator/core.mjs',
    'apps/admin-web/src/auth/auth-flow.ts',
    'apps/admin-web/src/auth/cognito-idp.ts',
    'apps/admin-web/src/auth/srp.ts',
  ];
  const r = {
    startedAt: new Date().toISOString(),
    scope,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(sourceFiles.map((f) => [f, sha(readFileSync(f))])),
    target: { account, region, stack: 'fdp-test-app' },
    mode: 'REAL_APPLICATION_CSR_NO_DB_SEED',
    physicalDevice: false,
    fullQa09Accepted: false,
    privateKeysPersisted: false,
    checks: [],
    http: [],
    database: [],
    certificates: [],
    rotations: [],
    cleanup: [],
    gate: 'RUNNING',
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  save();
  const check = (id, ok, details = {}) => {
    r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', at: new Date().toISOString(), ...details });
    save();
    if (!ok) throw Error('ASSERT_' + id);
  };
  const aws = (svc, op, args = [], read = false) => {
    try {
      const out = execFileSync(
        'aws',
        [
          svc,
          op,
          '--profile',
          read ? 'esgiot-readonly' : 'esgiot-infra',
          '--region',
          region,
          '--output',
          'json',
          '--no-cli-pager',
          '--cli-connect-timeout',
          '5',
          '--cli-read-timeout',
          '35',
          ...args,
        ],
        {
          encoding: 'utf8',
          timeout: 45000,
          maxBuffer: 8 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, AWS_MAX_ATTEMPTS: '1' },
        },
      );
      return out.trim() ? JSON.parse(out) : {};
    } catch (e) {
      throw Error(`${svc}:${op}:${String(e.stderr ?? '').match(/\(([A-Za-z0-9]+)\)/)?.[1] ?? e.code ?? 'FAILED'}`);
    }
  };
  let credentialCache;
  const credentials = async () => {
    if (!credentialCache || credentialCache.expiration.getTime() < Date.now() + 300000) {
      const v = JSON.parse(
        execFileSync('aws', ['configure', 'export-credentials', '--profile', 'esgiot-infra', '--format', 'process'], {
          encoding: 'utf8',
          timeout: 30000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
      credentialCache = {
        accessKeyId: v.AccessKeyId,
        secretAccessKey: v.SecretAccessKey,
        sessionToken: v.SessionToken,
        expiration: new Date(v.Expiration),
      };
    }
    return credentialCache;
  };
  const cognito = new cognitoSdk.CognitoIdentityProviderClient({ region, credentials, maxAttempts: 1 });
  const cog = (Command, body) =>
    cognito.send(new Command({ UserPoolId: pool, Username: scope.username, ...body }), {
      abortSignal: AbortSignal.timeout(30000),
    });
  let token,
    accessToken,
    createdFunction = false,
    createdIdentity = false,
    client,
    deviceId,
    dbCount = 0;
  const held = [];
  const db = (action) => {
    const stem = String(++dbCount).padStart(3, '0') + '-' + action;
    writeFileSync(resolve(dir, stem + '-input.json'), JSON.stringify({ action }));
    const meta = aws('lambda', 'invoke', [
      '--function-name',
      name,
      '--cli-binary-format',
      'raw-in-base64-out',
      '--payload',
      'file://' + resolve(dir, stem + '-input.json'),
      resolve(dir, stem + '-result.json'),
    ]);
    const out = JSON.parse(readFileSync(resolve(dir, stem + '-result.json')));
    r.database.push({
      action,
      at: new Date().toISOString(),
      file: stem + '-result.json',
      result: out.error || meta.FunctionError ? 'FAIL' : 'PASS',
    });
    save();
    if (out.error || meta.FunctionError || out.scope !== scope.serial)
      throw Error('DB_' + action + '_' + JSON.stringify(out.error ?? meta.FunctionError ?? 'SCOPE'));
    return out.result;
  };
  async function api(label, method, host, path, body, headers = {}) {
    const start = Date.now();
    const res = await fetch('https://' + host + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(host === 'api.bio-nexa.com' ? { Authorization: 'Bearer ' + token } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25000),
    });
    const parsed = await res.json();
    const row = {
      label,
      at: new Date().toISOString(),
      host,
      method,
      path: path.split('?')[0],
      status: res.status,
      requestId: res.headers.get('x-amzn-requestid'),
      latencyMs: Date.now() - start,
      body: parsed,
    };
    r.http.push(row);
    save();
    return row;
  }
  const mtls = async (label, k) => {
    const v = await mtlsPost(k.pem + k.chain, k.key);
    r.http.push({
      label,
      at: new Date().toISOString(),
      host: 'device-api.bio-nexa.com',
      method: 'POST',
      path: '/api/v1/device/sync',
      ...v,
    });
    save();
    return v;
  };
  const mqtt = async (label, k) => {
    const v = await observeMqttConnect(connect, 'mqtts://iot.bio-nexa.com:8883', {
      clientId: deviceId,
      cert: k.pem + k.chain,
      key: k.key,
      rejectUnauthorized: true,
      reconnectPeriod: 0,
      connectTimeout: 15000,
      clean: true,
      protocolVersion: 4,
    });
    r.checks.push({
      id: label,
      result: v.outcome === 'CONNECTED' ? 'PASS' : 'FAIL',
      at: new Date().toISOString(),
      outcome: v.outcome,
      errorCode: v.errorCode,
    });
    save();
    if (v.outcome !== 'CONNECTED') throw Error(label + '_' + v.outcome);
    return v.client;
  };
  const waitFor = async (label, predicate, ms = 120000) => {
    const end = Date.now() + ms;
    do {
      const s = db('observe');
      if (predicate(s)) return s;
      if (Date.now() >= end) throw Error('DEADLINE_' + label);
      await pause(5000);
    } while (Date.now() < end);
    throw Error('DEADLINE_' + label);
  };
  const recordCert = (label, pem, chain, key, id) => {
    const info = inspectCertificate(pem, chain, key, deviceId);
    writeFileSync(resolve(dir, label + '-certificate.pem'), pem);
    writeFileSync(resolve(dir, label + '-chain.pem'), chain);
    r.certificates.push({ label, id, ...info });
    save();
    return { pem, chain, key, id };
  };
  const workerNames = [
    'onboarding-api-handler',
    'api',
    'onboarding-provisioning',
    'ingestion',
    'device-api-handler',
    'cert-package-sweeper',
  ];
  const readWorkers = () =>
    workerNames.map((s) =>
      aws(
        'lambda',
        'get-function-configuration',
        [
          '--function-name',
          'fdp-test-' + s,
          '--query',
          '{Name:FunctionName,Hash:CodeSha256,Modified:LastModified,State:State}',
        ],
        true,
      ),
    );
  try {
    check('target-account', aws('sts', 'get-caller-identity').Account === account);
    r.workersBefore = readWorkers();
    r.schedules = ['onboarding-provisioning', 'cert-package-sweeper'].map((s) =>
      aws('events', 'describe-rule', ['--name', 'fdp-test-' + s], true),
    );
    save();
    check(
      'scheduled-workers-enabled',
      r.schedules.every((s) => s.State === 'ENABLED') && r.schedules[1].ScheduleExpression === 'rate(5 minutes)',
    );
    const cfg = aws(
      'lambda',
      'get-function-configuration',
      ['--function-name', 'fdp-test-replay', '--query', '{Role:Role,VpcConfig:VpcConfig}'],
      true,
    );
    const vars = aws(
      'lambda',
      'get-function-configuration',
      ['--function-name', 'fdp-test-ingestion', '--query', 'Environment.Variables'],
      true,
    );
    const ld = resolve(dir, 'lambda');
    mkdirSync(ld, { recursive: true });
    await build({
      entryPoints: ['scripts/csr-lifecycle-fixture.mjs'],
      outfile: ld + '/index.cjs',
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      external: ['@aws-sdk/client-secrets-manager', 'pg-native'],
      logLevel: 'silent',
    });
    const ca = await fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', {
      signal: AbortSignal.timeout(20000),
    }).then((v) => {
      if (!v.ok) throw Error('RDS_CA_DOWNLOAD');
      return v.text();
    });
    writeFileSync(ld + '/rds-ca-bundle.pem', ca);
    execFileSync('zip', ['-q', resolve(dir, 'fixture.zip'), 'index.cjs', 'rds-ca-bundle.pem'], { cwd: ld });
    r.fixture = { name, role: cfg.Role, zipSha256: sha(readFileSync(resolve(dir, 'fixture.zip'))) };
    save();
    aws('lambda', 'create-function', [
      '--function-name',
      name,
      '--runtime',
      'nodejs24.x',
      '--role',
      cfg.Role,
      '--handler',
      'index.handler',
      '--timeout',
      '30',
      '--memory-size',
      '256',
      '--zip-file',
      'fileb://' + resolve(dir, 'fixture.zip'),
      '--vpc-config',
      JSON.stringify({ SubnetIds: cfg.VpcConfig.SubnetIds, SecurityGroupIds: cfg.VpcConfig.SecurityGroupIds }),
      '--environment',
      JSON.stringify({ Variables: { DB_SECRET_ARN: vars.DB_SECRET_ARN, CSR_SCOPE: JSON.stringify(scope) } }),
    ]);
    createdFunction = true;
    save();
    for (let i = 0; i < 40; i++) {
      const s = aws('lambda', 'get-function-configuration', ['--function-name', name, '--query', 'State'], true);
      if (s === 'Active') break;
      if (s === 'Failed') throw Error('FIXTURE_FAILED');
      await pause(2000);
    }
    r.baseline = db('observe');
    check(
      'own-scope-initially-empty',
      !r.baseline.devices.length && !r.baseline.requests.length && !r.baseline.users.length,
    );
    const password = 'A!z9' + randomBytes(24).toString('base64url');
    const identity = await cog(cognitoSdk.AdminCreateUserCommand, {
      MessageAction: 'SUPPRESS',
      TemporaryPassword: password,
      UserAttributes: [
        { Name: 'email', Value: scope.username },
        { Name: 'email_verified', Value: 'true' },
      ],
    });
    createdIdentity = true;
    r.identity = { username: scope.username, sub: identity.User.Attributes.find((a) => a.Name === 'sub').Value };
    save();
    await cog(cognitoSdk.AdminAddUserToGroupCommand, { GroupName: 'PlatformSuperAdmin' });
    const flow = new AuthFlow({
      idp: createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }),
      userPoolId: pool,
      sessionManager: { establish() {} },
    });
    check(
      'real-srp-first-password-challenge',
      (await flow.login(scope.username, password)).status === 'new-password-required',
    );
    const auth = await flow.submitNewPassword('A!z9' + randomBytes(24).toString('base64url'));
    check('real-srp-admin-auth', auth.status === 'authenticated');
    token = auth.session.idToken;
    accessToken = auth.session.accessToken;
    const first = createCsr(scope.serial);
    held.push(first);
    const body = {
      serialNumber: scope.serial,
      model: 'BNX-100',
      hardwareVersion: '1',
      manufacturer: 'Bio-Nexa',
      manufactureDate: '2026-01-01',
      csrPem: first.csrPem,
    };
    writeFileSync(resolve(dir, 'initial-request.json'), JSON.stringify(body, null, 2) + '\n');
    const submitted = await api(
      'csr-application',
      'POST',
      'onboard-api.bio-nexa.com',
      '/api/v1/device/onboarding/request',
      body,
    );
    check('real-csr-request-created', submitted.status === 201 && !!submitted.body.requestId);
    r.requestId = submitted.body.requestId;
    save();
    const statusPath = '/api/v1/device/onboarding/status?requestId=' + r.requestId;
    const headers = proofHeaders(r.requestId, first.key);
    const pending = await api('pending-signed-poll', 'GET', 'onboard-api.bio-nexa.com', statusPath, undefined, headers);
    check('signed-pending', pending.status === 200 && pending.body.status === 'PENDING');
    const replay = await api('nonce-replay', 'GET', 'onboard-api.bio-nexa.com', statusPath, undefined, headers);
    check('nonce-replay-denied', replay.status === 401);
    const detail = await api(
      'admin-request-detail',
      'GET',
      'api.bio-nexa.com',
      '/api/v1/admin/onboarding/requests/' + r.requestId,
    );
    check('admin-review-pending', detail.status === 200 && detail.body.data.status === 'PENDING');
    const approved = await api(
      'admin-approve',
      'POST',
      'api.bio-nexa.com',
      '/api/v1/admin/onboarding/requests/' + r.requestId + '/approve',
      undefined,
      { 'If-Match': String(detail.body.data.version) },
    );
    check('real-admin-approval', approved.status === 200);
    const end = Date.now() + 300000;
    let issued;
    do {
      await pause(6000);
      const v = await api(
        'signed-certificate-poll',
        'GET',
        'onboard-api.bio-nexa.com',
        statusPath,
        undefined,
        proofHeaders(r.requestId, first.key),
      );
      if (v.status === 429) continue;
      check('poll-http-' + r.http.length, v.status === 200);
      if (v.body.status === 'APPROVED') {
        issued = v.body;
        break;
      }
      if (Date.now() > end) throw Error('PROVISIONING_TIMEOUT');
    } while (Date.now() < end);
    check('certificate-delivered', !!issued?.certificate && !JSON.stringify(issued).includes('PRIVATE KEY'));
    deviceId = issued.deviceId;
    r.deviceId = deviceId;
    save();
    const before = await waitFor(
      'provisioned',
      (s) => s.certificates.length === 1 && s.jobs[0]?.status === 'COMPLETED',
    );
    check(
      'approval-created-unassigned-device',
      before.devices[0]?.id === deviceId &&
        before.devices[0]?.serial_number === scope.serial &&
        !before.devices[0]?.customer_id &&
        before.devices[0]?.lifecycle_status === 'OnboardingApproved',
    );
    const initial = recordCert(
      'initial',
      issued.certificate.certificatePem,
      issued.certificate.certificateChain,
      first.key,
      before.certificates[0].id,
    );
    check(
      'pre-heartbeat-pending-claim',
      before.certificates[0].status === 'PENDING_CLAIM' &&
        !before.certificates[0].mqtt_verified_at &&
        !before.certificates[0].rest_verified_at,
    );
    r.cloudProvisioning = {
      thing: aws('iot', 'describe-thing', ['--thing-name', deviceId], true),
      principals: aws('iot', 'list-thing-principals', ['--thing-name', deviceId], true),
      certificate: aws('iot', 'describe-certificate', ['--certificate-id', initial.id], true),
      policies: aws(
        'iot',
        'list-attached-policies',
        ['--target', `arn:aws:iot:${region}:${account}:cert/${initial.id}`],
        true,
      ),
    };
    save();
    check(
      'real-thing-cert-policy-bindings',
      r.cloudProvisioning.certificate.certificateDescription.status === 'ACTIVE' &&
        r.cloudProvisioning.principals.principals.includes(`arn:aws:iot:${region}:${account}:cert/${initial.id}`) &&
        r.cloudProvisioning.policies.policies.length === 1,
    );
    const sim = new SimulatedDevice(deviceId, {}, {});
    const heartbeat = async (label) => {
      const payload = sim.payload('heartbeat');
      await publishKnown(client, `bnx/device/${deviceId}/heartbeat`, JSON.stringify(payload));
      r.checks.push({
        id: label,
        result: 'PASS',
        at: new Date().toISOString(),
        payload,
        rawSha256: sha(JSON.stringify(payload)),
        puback: true,
      });
      save();
    };
    client = await mqtt('initial-custom-domain-mqtt', initial);
    await heartbeat('first-heartbeat');
    const activated = await waitFor(
      'first-heartbeat-activation',
      (s) =>
        s.devices[0]?.lifecycle_status === 'Onboarded' &&
        s.certificates[0]?.status === 'ACTIVE' &&
        !!s.certificates[0]?.mqtt_verified_at,
    );
    check(
      'first-heartbeat-activates-before-rest',
      !activated.certificates[0].rest_verified_at &&
        activated.certificates[0].package_destroyed &&
        activated.receipts.some((v) => v.seq === 1 && v.result === 'PROCESSED') &&
        activated.history.some((v) => v.from_status === 'OnboardingApproved' && v.to_status === 'Onboarded'),
    );
    const sync = await mtls('initial-rest-sync', initial);
    check(
      'initial-rest-sync-complete-empty-snapshot',
      sync.status === 200 &&
        !!sync.requestId &&
        sync.body.deviceId === deviceId &&
        sync.body.operationalStatus.lifecycleStatus === 'Onboarded' &&
        sync.body.assignment === null &&
        sync.body.license === null &&
        sync.body.deviceUsers.length === 0 &&
        /^[a-f0-9]{64}$/.test(sync.body.etag),
    );
    await waitFor('initial-rest-recorded', (s) => !!s.certificates[0]?.rest_verified_at);
    let current = initial;
    for (const channel of ['mqtt', 'rest']) {
      const rotation = {
        order: channel === 'mqtt' ? 'MQTT_THEN_REST' : 'REST_THEN_MQTT',
        oldId: current.id,
        startedAt: new Date().toISOString(),
      };
      r.rotations.push(rotation);
      save();
      const next = createCsr(deviceId);
      held.push(next);
      writeFileSync(resolve(dir, 'rotation-' + channel + '-csr.pem'), next.csrPem);
      const response = await deviceRequest(
        current.pem + current.chain,
        current.key,
        '/api/v1/device/certificate/rotate',
        { currentCertificateId: current.id, csrPem: next.csrPem },
      );
      r.http.push({
        label: 'rotate-' + channel,
        at: new Date().toISOString(),
        host: 'device-api.bio-nexa.com',
        method: 'POST',
        path: '/api/v1/device/certificate/rotate',
        ...response,
      });
      save();
      check(
        'rotation-' + channel + '-real-csr-issued',
        response.status === 200 && !!response.requestId && !JSON.stringify(response.body).includes('PRIVATE KEY'),
      );
      const v = response.body?.data ?? response.body;
      const replacement = recordCert(
        'rotation-' + channel,
        v.certificatePem,
        v.certificateChain,
        next.key,
        v.certificateId,
      );
      rotation.newId = replacement.id;
      save();
      check(
        'rotation-' + channel + '-fresh-key',
        replacement.id !== current.id &&
          r.certificates.at(-1).publicKeyFingerprint !== r.certificates.at(-2).publicKeyFingerprint,
      );
      await client.endAsync(true);
      client = undefined;
      if (channel === 'mqtt') {
        client = await mqtt('rotation-mqtt-first-connect', replacement);
        await heartbeat('rotation-mqtt-only-heartbeat');
      } else {
        const x = await mtls('rotation-rest-only-sync', replacement);
        check('rotation-rest-only-sync-ok', x.status === 200 && !!x.requestId);
      }
      rotation.single = await waitFor('single-channel-' + channel, (s) =>
        singleChannelProof(s, current.id, replacement.id, channel),
      );
      const control = await mtls('old-valid-after-' + channel + '-only', current);
      check('old-rest-valid-after-' + channel + '-only', control.status === 200 && !!control.requestId);
      rotation.oldIotSingle = aws(
        'iot',
        'describe-certificate',
        ['--certificate-id', current.id, '--query', 'certificateDescription.status'],
        true,
      );
      check('old-iot-active-after-' + channel + '-only', rotation.oldIotSingle === 'ACTIVE');
      if (channel === 'mqtt') {
        const x = await mtls('rotation-rest-second-sync', replacement);
        check('rotation-rest-second-sync-ok', x.status === 200 && !!x.requestId);
      } else {
        client = await mqtt('rotation-mqtt-second-connect', replacement);
        await heartbeat('rotation-dual-heartbeat');
      }
      rotation.dual = await waitFor('dual-channel-' + channel, (s) => dualChannelProof(s, current.id, replacement.id));
      check(
        'rotation-' + channel + '-dual-channel-confirmed',
        dualChannelProof(rotation.dual, current.id, replacement.id),
      );
      const denied = await mtls('old-revoked-after-' + channel + '-dual', current);
      check('old-rest-denied-after-' + channel + '-dual', denied.status === 401 && !!denied.requestId);
      rotation.completedAt = new Date().toISOString();
      current = replacement;
      save();
    }
    console.log('Both channel orders confirmed; waiting for existing five-minute sweeper.');
    const deadline = Date.now() + 360000;
    do {
      for (const rotation of r.rotations)
        rotation.oldIotStatus = aws(
          'iot',
          'describe-certificate',
          ['--certificate-id', rotation.oldId, '--query', 'certificateDescription.status'],
          true,
        );
      save();
      if (r.rotations.every((v) => v.oldIotStatus === 'INACTIVE')) break;
      if (Date.now() > deadline) throw Error('SWEEPER_DEACTIVATION_TIMEOUT');
      await pause(10000);
    } while (Date.now() <= deadline);
    check(
      'old-iot-deactivation-within-budget',
      r.rotations.every((v) => v.oldIotStatus === 'INACTIVE'),
    );
    const swept = await waitFor('deactivation-recorded', (s) =>
      r.rotations.every((rot) =>
        s.certificates.some((c) => c.id === rot.oldId && !c.iot_deactivation_pending && !!c.iot_deactivated_at),
      ),
    );
    check(
      'sweeper-reconciled-both-old-certificates',
      r.rotations.every((rot) => rot.oldIotStatus === 'INACTIVE'),
    );
    r.finalState = swept;
    await client.endAsync(true);
    client = undefined;
    for (const rotation of r.rotations) {
      const previous = held[r.rotations.indexOf(rotation)],
        cert = r.certificates.find((c) => c.id === rotation.oldId);
      const pem = readFileSync(resolve(dir, cert.label + '-certificate.pem'), 'utf8'),
        chain = readFileSync(resolve(dir, cert.label + '-chain.pem'), 'utf8');
      const neg = await observeMqttConnect(connect, 'mqtts://iot.bio-nexa.com:8883', {
        clientId: deviceId,
        cert: pem + chain,
        key: previous.key,
        rejectUnauthorized: true,
        reconnectPeriod: 0,
        connectTimeout: 15000,
        protocolVersion: 4,
        clean: true,
      });
      if (neg.client) await neg.client.endAsync(true);
      rotation.oldMqttOutcome = neg.outcome;
      client = await mqtt('adjacent-new-control-' + rotation.order, current);
      rotation.adjacentNewMqttControl = true;
      rotation.oldMqttDenial = oldMqttDenial(neg.outcome, rotation.oldIotStatus, true);
      check('old-mqtt-denied-' + rotation.order, !!rotation.oldMqttDenial, { outcome: neg.outcome });
      await client.endAsync(true);
      client = undefined;
      save();
    }
    const finalSync = await mtls('latest-rest-valid-control', current);
    check('latest-rest-still-valid', finalSync.status === 200 && !!finalSync.requestId);
    check(
      'outside-devices-certificates-unchanged',
      JSON.stringify(r.baseline.outsideFingerprints) === JSON.stringify(swept.outsideFingerprints),
    );
    r.workersAfter = readWorkers();
    check('deployed-workers-unchanged', JSON.stringify(r.workersBefore) === JSON.stringify(r.workersAfter));
    r.gate = 'PASS';
  } catch (e) {
    r.gate = 'FAIL';
    r.failure = { at: new Date().toISOString(), message: String(e.message).slice(0, 350) };
    console.log(JSON.stringify(r.failure));
    save();
  } finally {
    await client?.endAsync(true).catch(() => {});
    client = undefined;
    const cleanup = async (label, fn) => {
      try {
        const detail = await fn();
        r.cleanup.push({ label, result: 'PASS', at: new Date().toISOString(), detail });
      } catch (e) {
        r.gate = 'FAIL';
        r.cleanup.push({ label, result: 'FAIL', at: new Date().toISOString(), error: String(e.message).slice(0, 300) });
      }
      save();
    };
    if (createdFunction) {
      await cleanup('owned-iot-and-database', async () => {
        const state = db('observe');
        if (state.jobs.some((j) => ['PENDING', 'PROCESSING', 'RETRY'].includes(j.status)))
          throw Error('ACTIVE_JOB_CLEANUP_HELD');
        const policies = new Set();
        for (const c of state.certificates) {
          const arn = `arn:aws:iot:${region}:${account}:cert/${c.id}`;
          const binding = aws('iot', 'list-principal-things', ['--principal', arn], true);
          if (binding.things.some((t) => !state.devices.some((d) => d.id === t))) throw Error('FOREIGN_THING_BINDING');
          aws('iot', 'update-certificate', ['--certificate-id', c.id, '--new-status', 'INACTIVE']);
          for (const p of aws('iot', 'list-attached-policies', ['--target', arn], true).policies) {
            if (!p.policyName.includes(state.devices[0].id)) throw Error('FOREIGN_POLICY');
            policies.add(p.policyName);
            aws('iot', 'detach-policy', ['--policy-name', p.policyName, '--target', arn]);
          }
          for (const thing of binding.things)
            aws('iot', 'detach-thing-principal', ['--thing-name', thing, '--principal', arn]);
          aws('iot', 'delete-certificate', ['--certificate-id', c.id]);
          try {
            aws('iot', 'describe-certificate', ['--certificate-id', c.id], true);
            throw Error('CERT_STILL_EXISTS');
          } catch (e) {
            if (!e.message.includes('ResourceNotFoundException')) throw e;
          }
        }
        for (const p of policies) {
          const targets = aws('iot', 'list-targets-for-policy', ['--policy-name', p], true);
          if (targets.targets?.length) throw Error('POLICY_STILL_ATTACHED');
          aws('iot', 'delete-policy', ['--policy-name', p]);
          try {
            aws('iot', 'get-policy', ['--policy-name', p], true);
            throw Error('POLICY_STILL_EXISTS');
          } catch (e) {
            if (!e.message.includes('ResourceNotFoundException')) throw e;
          }
        }
        for (const d of state.devices) {
          aws('iot', 'delete-thing', ['--thing-name', d.id]);
          try {
            aws('iot', 'describe-thing', ['--thing-name', d.id], true);
            throw Error('THING_STILL_EXISTS');
          } catch (e) {
            if (!e.message.includes('ResourceNotFoundException')) throw e;
          }
        }
        const deleted = db('cleanup');
        r.cleanupState = db('audit-empty');
        save();
        check(
          'cleanup-outside-baseline-preserved',
          JSON.stringify(r.baseline.outsideFingerprints) === JSON.stringify(r.cleanupState.outsideFingerprints),
        );
        return {
          deleted: deleted.deleted,
          certificateIds: state.certificates.map((c) => c.id),
          policyNames: [...policies],
          devices: state.devices.map((d) => d.id),
          auditRowsRetained: state.audits.length,
        };
      });
    }
    if (createdIdentity)
      await cleanup('cognito-user-removed', async () => {
        if (accessToken)
          await createCognitoIdpClient({ region, clientId: '5ljdjsf9g563mc1vdc7vjdjm09' }).globalSignOut(accessToken);
        await cog(cognitoSdk.AdminDeleteUserCommand, {});
        try {
          await cog(cognitoSdk.AdminGetUserCommand, {});
          throw Error('USER_STILL_EXISTS');
        } catch (e) {
          if (e.name !== 'UserNotFoundException') throw e;
        }
        return { username: scope.username, readback: 'UserNotFoundException' };
      });
    if (createdFunction)
      await cleanup('temporary-observer-removed', async () => {
        aws('lambda', 'delete-function', ['--function-name', name]);
        try {
          aws('lambda', 'get-function-configuration', ['--function-name', name], true);
          throw Error('FUNCTION_STILL_EXISTS');
        } catch (e) {
          if (!e.message.includes('ResourceNotFoundException')) throw e;
        }
        return { name, readback: 'ResourceNotFoundException', cloudWatchLogs: 'RETAINED_FOR_AUDIT' };
      });
    held.splice(0);
    token = undefined;
    accessToken = undefined;
    credentialCache = undefined;
    r.finishedAt = new Date().toISOString();
    save();
  }
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv[2])
    .then((r) => {
      console.log(JSON.stringify({ gate: r.gate, deviceId: r.deviceId, checks: r.checks.length, cleanup: r.cleanup }));
      process.exitCode = r.gate === 'PASS' ? 0 : 1;
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
