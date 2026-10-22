/** One real enrolled device; real admin setup and mTLS full business Sync. */
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { connect } from 'mqtt';
import * as cognitoSdk from '@aws-sdk/client-cognito-identity-provider';
import { AuthFlow } from '../apps/admin-web/src/auth/auth-flow.ts';
import { createCognitoIdpClient } from '../apps/admin-web/src/auth/cognito-idp.ts';
import { createCsr, proofHeaders, publishKnown } from './run-qa09-ten-device-acceptance.mjs';
import { request } from 'node:https';
import { observeMqttConnect } from './qa09-bounded-mqtt-connect.mjs';
import { SimulatedDevice } from './device-simulator/core.mjs';
import { validateScope } from './rest-sync-fixture.mjs';
const region = 'ap-southeast-1',
  account = '065986019555',
  pool = 'ap-southeast-1_hZMX8LpFo';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
import { inspectCertificate } from './run-csr-lifecycle-smoke.mjs';
import { publicSnapshot, evaluateSnapshot, ownArchivePrefix } from './rest-sync-evidence.mjs';
import { deviceContract } from '../contracts/testing/device-contract.ts';
import { verifyDeviceUserPassword } from '../apps/cloud-api/src/admin/device-user/verifier.ts';
export async function main(output) {
  if (process.env.FDP_REST_SYNC_TEST !== '1' || !output || existsSync(output))
    throw Error('EXPLICIT_ENABLE_AND_FRESH_OUTPUT_REQUIRED');
  const dir = dirname(resolve(output));
  mkdirSync(dir, { recursive: true });
  const serial = 'syncprobe-' + randomBytes(8).toString('hex');
  const scope = validateScope({
    serial,
    username: serial + '@example.invalid',
    model: 'SYNC-' + serial.slice(10).toUpperCase(),
    names: [serial + '-a', serial + '-b'],
  });
  const name = 'fdp-test-qa09-' + scope.serial;
  const sourceFiles = [
    'scripts/run-rest-sync-smoke.mjs',
    'scripts/rest-sync-fixture.mjs',
    'scripts/rest-sync-evidence.mjs',
    'packages/domain/src/device-lifecycle.ts',
    'apps/ingestion-worker/src/heartbeat/handler.ts',
    'apps/cloud-api/src/device/sync.ts',
    'scripts/run-csr-lifecycle-smoke.mjs',
    'contracts/rest/openapi.bundle.json',
    'contracts/testing/device-contract.ts',
    'apps/cloud-api/src/admin/device-user/verifier.ts',
    'scripts/run-qa09-ten-device-acceptance.mjs',
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
    mode: 'REAL_ASSIGNED_REST_SYNC_NO_DB_SEED',
    physicalDevice: false,
    fullQa09Accepted: false,
    privateKeysPersisted: false,
    checks: [],
    http: [],
    database: [],
    certificates: [],
    snapshots: [],
    schemaFindings: [],
    customers: [],
    sites: [],
    deviceUsers: [],
    configurations: [],
    licenseDeviceVerification: 'NOT_RUN_NO_INDEPENDENT_DEVICE_HMAC_KEY',
    cleanup: [],
    gate: 'RUNNING',
  };
  const secretCanaries = [];
  const save = () => {
    const raw = JSON.stringify(r, null, 2);
    if (secretCanaries.some((v) => raw.includes(v))) throw Error('EVIDENCE_SECRET_LEAK');
    writeFileSync(output, raw + '\n');
  };
  save();
  const check = (id, ok, details = {}, fatal = true) => {
    r.checks.push({ id, result: ok ? 'PASS' : 'FAIL', at: new Date().toISOString(), ...details });
    save();
    if (!ok && fatal) throw Error('ASSERT_' + id);
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
      const stderr = String(e.stderr ?? '').slice(0, 1500);
      const code = stderr.match(/\(([A-Za-z0-9]+)\)/)?.[1] ?? e.code ?? 'UNCLASSIFIED_CLI_FAILURE';
      (r.awsFailures ??= []).push({
        service: svc,
        operation: op,
        at: new Date().toISOString(),
        code,
        status: e.status ?? null,
        signal: e.signal ?? null,
        stderr,
      });
      save();
      throw Error(`${svc}:${op}:${code}`);
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
  const mtls = async (label, k, body = {}) => {
    const response = await new Promise((resolve) => {
      const req = request(
        'https://device-api.bio-nexa.com/api/v1/device/sync',
        {
          method: 'POST',
          cert: k.pem + k.chain,
          key: k.key,
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
            resolve({
              status: res.statusCode,
              body: parsed,
              rawSha256: sha(raw),
              requestId: res.headers['x-amzn-requestid'] ?? null,
            });
          });
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', (e) => resolve({ status: 0, errorCode: e.code ?? 'TLS_FAILURE' }));
      req.end(JSON.stringify(body));
    });
    let schemaValid = true,
      schemaError = null;
    try {
      deviceContract.assertResponse('syncDevice', response);
    } catch (e) {
      schemaValid = false;
      schemaError = String(e.message).slice(0, 1000);
    }
    let evidence = { body: response.body, verifierDigests: [] };
    if (response.status === 200) {
      evidence = publicSnapshot(response.body);
      for (const u of response.body.deviceUsers) secretCanaries.push(u.passwordHash);
    }
    const row = {
      label,
      at: new Date().toISOString(),
      host: 'device-api.bio-nexa.com',
      method: 'POST',
      path: '/api/v1/device/sync',
      requestBody: body,
      status: response.status,
      requestId: response.requestId ?? null,
      rawSha256: response.rawSha256 ?? null,
      schemaValid,
      schemaError,
      ...evidence,
    };
    r.http.push(row);
    if (response.status === 200) r.snapshots.push(row);
    save();
    if (!schemaValid) {
      r.schemaFindings.push({ label, status: response.status, requestId: response.requestId, error: schemaError });
      save();
    }
    check(label + '-gateway-request-id', !!response.requestId);
    check(label + '-http-schema', schemaValid, { status: response.status }, false);
    return { raw: response.body, row, status: response.status };
  };
  const admin = async (label, method, path, expected, body, headers = {}) => {
    const v = await api(label, method, 'api.bio-nexa.com', path, body, headers);
    check(label + '-http', v.status === expected, { status: v.status, expected });
    return v.body.data;
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
    'notification-publisher',
    'outbox-publisher',
    'archive',
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
    r.schedules = ['onboarding-provisioning', 'notification-publisher', 'outbox-publisher'].map((s) =>
      aws('events', 'describe-rule', ['--name', 'fdp-test-' + s], true),
    );
    save();
    check(
      'scheduled-workers-enabled',
      r.schedules.every((s) => s.State === 'ENABLED'),
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
      entryPoints: ['scripts/rest-sync-fixture.mjs'],
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
      JSON.stringify({ Variables: { DB_SECRET_ARN: vars.DB_SECRET_ARN, REST_SYNC_SCOPE: JSON.stringify(scope) } }),
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
      !r.baseline.devices.length &&
        !r.baseline.requests.length &&
        !r.baseline.users.length &&
        !r.baseline.customers.length &&
        !r.baseline.configurations.length,
    );
    const password = 'A!z9' + randomBytes(24).toString('base64url');
    secretCanaries.push(password);
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
      model: scope.model,
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
    const baselineSync = await mtls('initial-rest-sync', initial);
    check(
      'initial-empty-sync',
      baselineSync.status === 200 &&
        baselineSync.raw.assignment === null &&
        baselineSync.raw.license === null &&
        baselineSync.raw.deviceUsers.length === 0,
    );
    await waitFor('initial-rest-recorded', (s) => !!s.certificates[0]?.rest_verified_at);
    for (const [i, customerName] of scope.names.entries()) {
      const c = await admin('create-customer-' + i, 'POST', '/api/v1/admin/customers', 201, { name: customerName });
      r.customers.push(c);
      save();
      const site = await admin('create-site-' + i, 'POST', '/api/v1/admin/sites', 201, {
        customerId: c.id,
        name: customerName + '-site',
        region: 'APAC-TEST',
        subregion: i === 0 ? 'Singapore-TEST' : 'Foreign-TEST',
        timezone: 'Asia/Singapore',
      });
      r.sites.push(site);
      save();
    }
    const customer = r.customers[0],
      site = r.sites[0];
    await admin('cross-customer-site-denied', 'POST', '/api/v1/admin/devices/' + deviceId + '/assignment', 400, {
      customerId: customer.id,
      siteId: r.sites[1].id,
      reason: serial,
    });
    r.assignment = await admin('assign-device', 'POST', '/api/v1/admin/devices/' + deviceId + '/assignment', 200, {
      customerId: customer.id,
      siteId: site.id,
      reason: serial,
    });
    save();
    const deviceBefore = await admin('read-device-before-alias', 'GET', '/api/v1/admin/devices/' + deviceId, 200);
    const alias = serial + '-alias';
    await admin(
      'set-device-alias',
      'PATCH',
      '/api/v1/admin/devices/' + deviceId + '/metadata',
      200,
      { alias },
      { 'If-Match': deviceBefore.updatedAt },
    );
    const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      to = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 10);
    r.license = await admin('license-draft', 'POST', '/api/v1/admin/licenses', 201, {
      deviceId,
      validFrom: from,
      validTo: to,
      entitlements: ['REMOTE_CONTROL', 'OTA', 'ESG_REPORTING'],
      reason: serial,
    });
    save();
    const lp = '/api/v1/admin/licenses/' + r.license.licenseId;
    r.license = await admin('license-issue', 'POST', lp + '/issue', 200);
    save();
    check(
      'license-issued-and-signed',
      r.license.status === 'Issued' && /^v1\.[A-Za-z0-9_-]{43}$/.test(r.license.signature),
    );
    r.license = await admin('license-active', 'POST', lp + '/activate', 200);
    save();
    check('license-active-readback', r.license.status === 'Active');
    const userPasswords = new Map();
    for (const [suffix, cid] of [
      ['operator', customer.id],
      ['unassigned', customer.id],
      ['disabled', customer.id],
      ['foreign', r.customers[1].id],
    ]) {
      const password = 'T!a9' + randomBytes(22).toString('base64url');
      secretCanaries.push(password);
      const user = await admin('user-create-' + suffix, 'POST', '/api/v1/admin/device-users', 201, {
        customerId: cid,
        username: serial + '-' + suffix,
        displayName: serial + '-' + suffix,
        password,
        reason: serial,
      });
      r.deviceUsers.push({ ...user, testRole: suffix });
      userPasswords.set(user.deviceUserId, password);
      save();
    }
    for (const role of ['operator', 'disabled']) {
      const u = r.deviceUsers.find((u) => u.testRole === role),
        up = '/api/v1/admin/device-users/' + u.deviceUserId;
      await admin(
        'user-assign-' + role,
        'POST',
        up + '/assignments',
        201,
        { deviceIds: [deviceId], reason: serial },
        { 'If-Match': String(u.version) },
      );
      const read = await admin('user-after-assign-' + role, 'GET', up, 200);
      Object.assign(u, read);
      save();
    }
    const disabled = r.deviceUsers.find((u) => u.testRole === 'disabled');
    Object.assign(
      disabled,
      await admin(
        'user-disable',
        'POST',
        '/api/v1/admin/device-users/' + disabled.deviceUserId + '/disable',
        200,
        { reason: serial },
        { 'If-Match': String(disabled.version) },
      ),
    );
    save();
    const foreign = r.deviceUsers.find((u) => u.testRole === 'foreign');
    await admin(
      'foreign-user-assignment-denied',
      'POST',
      '/api/v1/admin/device-users/' + foreign.deviceUserId + '/assignments',
      409,
      { deviceIds: [deviceId], reason: serial },
      { 'If-Match': String(foreign.version) },
    );
    const operator = r.deviceUsers.find((u) => u.testRole === 'operator');
    const expected = {
      deviceId,
      serial,
      model: scope.model,
      alias,
      customerId: customer.id,
      customerName: customer.name,
      siteId: site.id,
      siteName: site.name,
      region: site.region,
      subregion: site.subregion,
      licenseId: r.license.licenseId,
      userId: operator.deviceUserId,
      displayName: operator.displayName,
      lifecycle: 'Assigned',
    };
    const publishConfig = async (label, config, payload, effectiveAt) => {
      const base = '/api/v1/admin/configurations/' + config.configurationId;
      const v = await admin(label + '-create-version', 'POST', base + '/versions', 201, {
        payload,
        changeNote: serial,
        reason: serial,
      });
      const published = await admin(label + '-publish', 'POST', base + '/versions/' + v.version + '/publish', 200, {
        ...(effectiveAt ? { effectiveAt } : {}),
        reason: serial,
      });
      check(
        label + '-targets-only-own-device',
        JSON.stringify(published.notifiedDeviceIds) === JSON.stringify([deviceId]),
      );
      return published.version;
    };
    const modelConfig = await admin('model-config-create', 'POST', '/api/v1/admin/configurations', 201, {
      name: serial + '-model',
      targetModel: scope.model,
    });
    r.configurations.push(modelConfig);
    save();
    const modelPayload = {
      heartbeatInterval: 61,
      telemetryInterval: 31,
      cameraRefreshInterval: 2,
      temperatureThreshold: 71,
    };
    await publishConfig('model-v1', modelConfig, modelPayload);
    const full = async (label, payload, lastSyncTime = null) => {
      const response = await mtls(label, initial, { lastSyncTime });
      check(label + '-success', response.status === 200);
      const s = db('observe');
      const exp = { ...expected, configuration: payload };
      const results = evaluateSnapshot(response.row, exp, s);
      r.snapshotComparisons ??= [];
      r.snapshotComparisons.push({ label, expected: exp, results, database: r.database.at(-1).file });
      save();
      check(
        label + '-all-six-domains-match',
        Object.entries(results)
          .filter(([k]) => k !== 'schema')
          .every(([, v]) => v),
        { results },
      );
      const actualUser = response.raw.deviceUsers[0];
      const password = userPasswords.get(actualUser.userId);
      const verifierValid = await verifyDeviceUserPassword(actualUser.passwordHash, password);
      const wrongPasswordRejected = !(await verifyDeviceUserPassword(
        actualUser.passwordHash,
        'Wrong!' + randomBytes(12).toString('hex'),
      ));
      response.row.verifierChecks = { correctPassword: verifierValid, wrongPasswordRejected };
      save();
      check(label + '-device-verifier', verifierValid && wrongPasswordRejected);
      return response;
    };
    const modelSnapshot = await full('full-model-fallback', modelPayload);
    const receiptState = db('observe');
    check(
      'device-user-snapshot-served',
      receiptState.syncReceipts.some(
        (v) =>
          v.device_user_id === operator.deviceUserId &&
          v.entity_version === operator.version &&
          v.acknowledged_at === null,
      ),
    );
    const ack = await full('same-etag-full-and-ack', modelPayload, modelSnapshot.raw.snapshotAt);
    check(
      'stable-etag-does-not-trim',
      ack.raw.etag === modelSnapshot.raw.etag &&
        ack.raw.snapshotAt !== modelSnapshot.raw.snapshotAt &&
        ack.raw.lastSyncTime === modelSnapshot.raw.snapshotAt,
    );
    const served = await admin(
      'user-sync-state-after-ack',
      'GET',
      '/api/v1/admin/device-users/' + operator.deviceUserId,
      200,
    );
    check(
      'admin-user-state-acknowledged-not-applied',
      served.syncStates.some(
        (s) =>
          s.deviceId === deviceId &&
          s.deliveredEntityVersion === operator.version &&
          s.snapshotStatus === 'ACKNOWLEDGED' &&
          s.deviceReportedLastSyncAt === modelSnapshot.raw.snapshotAt &&
          s.deviceApplyStatus === 'NOT_REPORTED',
      ),
    );
    const confirmation = {
      licenseId: r.license.licenseId,
      version: r.license.version,
      snapshotEtag: ack.raw.etag,
      status: 'RECEIVED',
    };
    const received = await mtls('license-received', initial, {
      lastSyncTime: ack.raw.snapshotAt,
      licenseConfirmation: confirmation,
    });
    check(
      'received-confirms-only-licensed',
      received.status === 200 && received.raw.operationalStatus.lifecycleStatus === 'Licensed',
    );
    expected.lifecycle = 'Licensed';
    const confirmed = db('observe');
    check(
      'licensed-transition-and-bound-receipt',
      confirmed.devices[0].lifecycle_status === 'Licensed' &&
        confirmed.audits.some(
          (a) =>
            a.action === 'device.license.received' &&
            a.snapshot_etag === confirmation.snapshotEtag &&
            a.confirmation === 'RECEIVED',
        ) &&
        !confirmed.audits.some((a) => a.action === 'device.license.verified'),
    );
    const receivedAgain = await mtls('license-received-repeat', initial, {
      lastSyncTime: received.raw.snapshotAt,
      licenseConfirmation: confirmation,
    });
    check('license-received-idempotent', receivedAgain.status === 200 && receivedAgain.raw.etag === received.raw.etag);
    const deviceConfig = await admin('device-config-create', 'POST', '/api/v1/admin/configurations', 201, {
      name: serial + '-device',
      targetDeviceId: deviceId,
    });
    r.configurations.push(deviceConfig);
    save();
    const p1 = { heartbeatInterval: 45, telemetryInterval: 15, cameraRefreshInterval: 3, temperatureThreshold: 74.5 };
    await publishConfig('device-v1', deviceConfig, p1);
    const firstDevice = await full('device-overrides-model', p1);
    check('device-config-changes-etag', firstDevice.raw.etag !== received.raw.etag);
    const cp = '/api/v1/admin/configurations/' + deviceConfig.configurationId;
    const p2 = { heartbeatInterval: 46, telemetryInterval: 16, cameraRefreshInterval: 4, temperatureThreshold: 75.5 };
    const draft = await admin('device-v2-draft', 'POST', cp + '/versions', 201, { payload: p2, reason: serial });
    const whileDraft = await full('draft-not-effective', p1);
    check('draft-preserves-etag', whileDraft.raw.etag === firstDevice.raw.etag);
    await admin('device-v2-publish', 'POST', cp + '/versions/' + draft.version + '/publish', 200, { reason: serial });
    const afterPublish = await full('new-published-version', p2);
    check('published-version-changes-etag', afterPublish.raw.etag !== whileDraft.raw.etag);
    await publishConfig(
      'device-v3-future',
      deviceConfig,
      { heartbeatInterval: 55, telemetryInterval: 25, cameraRefreshInterval: 5, temperatureThreshold: 85.5 },
      new Date(Date.now() + 86400000).toISOString(),
    );
    const future = await full('future-version-not-effective', p2);
    check('future-preserves-current-etag', future.raw.etag === afterPublish.raw.etag);
    await heartbeat('volatile-heartbeat');
    await waitFor('second-heartbeat', (s) => s.receipts.some((v) => v.seq === 2 && v.result === 'PROCESSED'));
    const volatile = await full('heartbeat-keeps-etag', p2);
    check(
      'heartbeat-changes-only-volatile-fields',
      volatile.raw.etag === future.raw.etag &&
        volatile.raw.operationalStatus.lastHeartbeatAt !== future.raw.operationalStatus.lastHeartbeatAt,
    );
    const up = '/api/v1/admin/device-users/' + operator.deviceUserId;
    const currentUser = await admin('operator-before-password-change', 'GET', up, 200);
    const oldPassword = userPasswords.get(operator.deviceUserId),
      newPassword = 'T!a9' + randomBytes(22).toString('base64url');
    secretCanaries.push(newPassword);
    Object.assign(
      operator,
      await admin(
        'operator-password-and-name-update',
        'PATCH',
        up,
        200,
        { password: newPassword, displayName: serial + '-operator-updated', reason: serial },
        { 'If-Match': String(currentUser.version) },
      ),
    );
    userPasswords.set(operator.deviceUserId, newPassword);
    expected.displayName = operator.displayName;
    save();
    const changed = await full('user-new-version', p2);
    check(
      'user-change-invalidates-etag-and-old-password',
      changed.raw.etag !== volatile.raw.etag &&
        !(await verifyDeviceUserPassword(changed.raw.deviceUsers[0].passwordHash, oldPassword)) &&
        changed.row.verifierDigests[0].sha256 !== volatile.row.verifierDigests[0].sha256,
    );
    const changedReceipt = db('observe');
    check(
      'new-user-version-served-unacknowledged',
      changedReceipt.syncReceipts.some(
        (v) =>
          v.device_user_id === operator.deviceUserId && v.entity_version === operator.version && !v.acknowledged_at,
      ),
    );
    const final = await full('final-complete-acknowledged', p2, changed.raw.snapshotAt);
    check('last-sync-time-keeps-full-snapshot', final.raw.etag === changed.raw.etag);
    const invalid = await mtls('unknown-field-rejected', initial, { deviceId });
    check('sync-unknown-field-400', invalid.status === 400);
    const userRead = await admin('final-user-sync-state', 'GET', up, 200);
    check(
      'final-admin-user-delivered-version',
      userRead.syncStates.some(
        (s) =>
          s.deviceId === deviceId &&
          s.deliveredEntityVersion === operator.version &&
          s.snapshotStatus === 'ACKNOWLEDGED' &&
          s.deviceApplyStatus === 'NOT_REPORTED',
      ),
    );
    r.finalState = await waitFor(
      'outbox-published',
      (s) => s.outbox.length > 0 && s.outbox.every((o) => o.status === 'PUBLISHED'),
      180000,
    );
    check(
      'outside-devices-certificates-unchanged',
      JSON.stringify(r.baseline.outsideFingerprints) === JSON.stringify(r.finalState.outsideFingerprints),
    );
    check(
      'outside-business-records-unchanged',
      JSON.stringify(r.baseline.outsideBusinessFingerprints) ===
        JSON.stringify(r.finalState.outsideBusinessFingerprints),
    );
    r.expectedFinal = { ...expected, configuration: p2 };
    save();
    const archivePrefix = ownArchivePrefix(customer.id),
      archiveEvents = r.finalState.outbox.filter((o) => o.event_type === 'ARCHIVE');
    check(
      'three-license-domain-events',
      archiveEvents.length === 3 && archiveEvents.every((o) => o.archive_class === 'DOMAIN_EVENT'),
    );
    const archiveEnd = Date.now() + 120000;
    let archived;
    do {
      archived = aws(
        's3api',
        'list-object-versions',
        ['--bucket', 'fdp-test-raw-' + account, '--prefix', archivePrefix, '--max-keys', '100', '--no-paginate'],
        true,
      );
      r.archiveBeforeCleanup = archived;
      save();
      if (
        !archived.IsTruncated &&
        archiveEvents.every(
          (e) =>
            (archived.Versions ?? []).some((v) => v.Key.endsWith('part-' + sha(e.id).slice(0, 16) + '.json.gz')) &&
            (archived.Versions ?? []).some((v) => v.Key.endsWith('part-' + sha(e.id).slice(0, 16) + '.manifest.json')),
        )
      )
        break;
      await pause(5000);
    } while (Date.now() < archiveEnd);
    check(
      'all-license-archives-present',
      !archived.IsTruncated &&
        archiveEvents.every(
          (e) =>
            (archived.Versions ?? []).some((v) => v.Key.endsWith('part-' + sha(e.id).slice(0, 16) + '.json.gz')) &&
            (archived.Versions ?? []).some((v) => v.Key.endsWith('part-' + sha(e.id).slice(0, 16) + '.manifest.json')),
        ),
    );
    check('heartbeat-writes-canonical-operational-status', r.finalState.latest[0]?.operational_status === 'Active');
    const canonicalBeforeLegacy = await mtls('canonical-before-legacy', initial);
    r.legacyProbe = db('legacy-active');
    check('legacy-probe-only-own-device', r.legacyProbe.legacyUpdate.device_id === deviceId);
    const legacySync = await mtls('legacy-active-sync', initial);
    const legacyState = db('observe');
    check(
      'legacy-read-normalized-without-rewriting-db',
      legacyState.latest[0]?.operational_status === 'ACTIVE' &&
        legacySync.raw.operationalStatus.operationalStatus === 'Active' &&
        legacySync.raw.etag === canonicalBeforeLegacy.raw.etag,
    );
    await heartbeat('restore-canonical-heartbeat');
    r.statusRestoredState = await waitFor(
      'canonical-status-restored',
      (s) =>
        s.latest[0]?.operational_status === 'Active' && s.receipts.some((v) => v.seq === 3 && v.result === 'PROCESSED'),
    );
    const restoredSync = await mtls('restored-canonical-sync', initial);
    check(
      'restored-status-etag-stable',
      restoredSync.raw.operationalStatus.operationalStatus === 'Active' &&
        restoredSync.raw.etag === legacySync.raw.etag,
    );
    userPasswords.clear();
    r.workersAfter = readWorkers();
    check('deployed-workers-unchanged', JSON.stringify(r.workersBefore) === JSON.stringify(r.workersAfter));
    r.businessGate = 'PASS';
    r.gate = r.schemaFindings.length ? 'FAIL_CONTRACT' : 'PASS';
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
        const state = await waitFor(
          'cleanup-quiescent',
          (s) =>
            !s.jobs.some((j) => ['PENDING', 'PROCESSING', 'RETRY'].includes(j.status)) &&
            !s.outbox.some((o) => !['PUBLISHED', 'FAILED'].includes(o.status)),
          180000,
        );
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
        const archiveCleanup = [];
        for (const c of state.customers) {
          const prefix = ownArchivePrefix(c.id);
          let versions;
          const events = state.outbox.filter((o) => o.event_type === 'ARCHIVE' && o.customer_id === c.id);
          const until = Date.now() + 120000;
          do {
            versions = aws(
              's3api',
              'list-object-versions',
              ['--bucket', 'fdp-test-raw-' + account, '--prefix', prefix, '--max-keys', '100', '--no-paginate'],
              true,
            );
            if (
              events.every(
                (e) =>
                  (versions.Versions ?? []).some((v) =>
                    v.Key.endsWith('part-' + sha(e.id).slice(0, 16) + '.json.gz'),
                  ) &&
                  (versions.Versions ?? []).some((v) =>
                    v.Key.endsWith('part-' + sha(e.id).slice(0, 16) + '.manifest.json'),
                  ),
              )
            )
              break;
            if (Date.now() >= until) throw Error('ARCHIVE_CLEANUP_NOT_QUIESCENT');
            await pause(5000);
          } while (Date.now() <= until);

          if (versions.IsTruncated) throw Error('ARCHIVE_SCOPE_TOO_LARGE');
          const entries = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])];
          for (const v of entries) {
            if (!v.Key.startsWith(prefix) || !v.VersionId) throw Error('ARCHIVE_SCOPE_DRIFT');
            aws('s3api', 'delete-object', [
              '--bucket',
              'fdp-test-raw-' + account,
              '--key',
              v.Key,
              '--version-id',
              v.VersionId,
            ]);
          }
          const after = aws(
            's3api',
            'list-object-versions',
            ['--bucket', 'fdp-test-raw-' + account, '--prefix', prefix, '--max-keys', '100', '--no-paginate'],
            true,
          );
          if (after.IsTruncated || (after.Versions ?? []).length || (after.DeleteMarkers ?? []).length)
            throw Error('ARCHIVE_NOT_EMPTY');
          archiveCleanup.push({ prefix, removed: entries.map((v) => ({ key: v.Key, versionId: v.VersionId })), after });
        }
        r.archiveCleanup = archiveCleanup;
        save();
        const deleted = db('cleanup');
        r.afterDatabaseCleanup = db('observe');
        save();
        check(
          'cleanup-outside-baseline-preserved',
          JSON.stringify(r.baseline.outsideFingerprints) === JSON.stringify(r.afterDatabaseCleanup.outsideFingerprints),
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
    if (createdFunction && r.cleanup.some((c) => c.label === 'owned-iot-and-database' && c.result === 'PASS'))
      await cleanup('parent-records-closed', async () => {
        for (const site of [...r.sites].reverse()) {
          const x = await admin('cleanup-site-read-' + site.id, 'GET', '/api/v1/admin/sites/' + site.id, 200);
          await admin('cleanup-site-' + site.id, 'DELETE', '/api/v1/admin/sites/' + site.id, 200, undefined, {
            'If-Match': String(x.version),
          });
          await admin('cleanup-site-gone-' + site.id, 'GET', '/api/v1/admin/sites/' + site.id, 404);
        }
        for (const customer of [...r.customers].reverse()) {
          const x = await admin(
            'cleanup-customer-read-' + customer.id,
            'GET',
            '/api/v1/admin/customers/' + customer.id,
            200,
          );
          await admin(
            'cleanup-customer-' + customer.id,
            'DELETE',
            '/api/v1/admin/customers/' + customer.id,
            200,
            undefined,
            { 'If-Match': String(x.version) },
          );
          await admin('cleanup-customer-gone-' + customer.id, 'GET', '/api/v1/admin/customers/' + customer.id, 404);
        }
        r.cleanupState = db('audit-empty');
        check(
          'business-outside-baseline-preserved',
          JSON.stringify(r.baseline.outsideBusinessFingerprints) ===
            JSON.stringify(r.cleanupState.outsideBusinessFingerprints),
        );
        return {
          softDeletedCustomerIds: r.customers.map((c) => c.id),
          softDeletedSiteIds: r.sites.map((s) => s.id),
          auditLogs: 'RETAINED',
        };
      });
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
