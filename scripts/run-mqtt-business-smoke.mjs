/** Explicitly enabled, one owned device, real MQTT -> deployed workers -> RDS smoke. */
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { canonicalizeJson, computeAuditHash, verifyAuditHash } from '../contracts/mqtt/payload-normalization.ts';
import { SchemaRegistry, validate } from '../contracts/mqtt/validator.mjs';
import { buildDevicePolicy } from '../packages/aws-clients/src/iot-device-policy.ts';
import { validateScope } from './mqtt-business-fixture.mjs';
const require = createRequire(import.meta.url),
  { connect } = require('mqtt');
const region = 'ap-southeast-1',
  account = '065986019555',
  host = 'iot.bio-nexa.com';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const bounded = (p, ms, name) => {
  let timer;
  return Promise.race([
    p,
    new Promise((_, r) => {
      timer = setTimeout(() => r(Error(name)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
export function buildProbePayload(type, data, deviceId, seq, at = new Date().toISOString()) {
  const payload = {
    meta: { id: `${type.toUpperCase()}-${deviceId.toUpperCase()}-${seq}`, ts: at, seq, schemaVer: '1.0' },
    data: structuredClone(data),
  };
  if (['telemetry', 'report', 'tamper'].includes(type)) payload.audit = { hash: computeAuditHash(payload) };
  return payload;
}
export function archiveObjectKind(key) {
  if (key.endsWith('.manifest.json')) return 'manifest';
  if (key.endsWith('.json.gz')) return 'gzip';
  throw Error('UNKNOWN_ARCHIVE_OBJECT_KIND');
}
export function evaluateBusiness(s, r) {
  const types = ['heartbeat', 'telemetry', 'report', 'alarm', 'event', 'ack', 'tamper', 'media'];
  const checks = {};
  for (const t of types) checks[t] = s.receipts.some((v) => v.topic_type === t && v.result === 'PROCESSED');
  checks.heartbeat =
    checks.heartbeat && s.latest.some((v) => v.device_id === r.scope.deviceId && v.connectivity === 'ONLINE');
  checks.telemetry =
    checks.telemetry && s.telemetry.some((v) => v.sample_count === 1 && Number(v.metrics.feedingWeightKg?.avg) === 25);
  checks.report =
    checks.report &&
    s.reports.some(
      (v) =>
        v.source_message_id === r.uplink.find((m) => m.type === 'report')?.payload.meta.id &&
        Number(v.feeding_weight_kg) === 250,
    );
  checks.alarm = checks.alarm && s.alarms.some((v) => v.code === 'MQTT_PROBE_TEMP' && v.status === 'CLEARED');
  checks.event =
    checks.event &&
    s.events.some((v) => v.source_message_id === r.uplink.find((m) => m.type === 'event')?.payload.meta.id);
  checks.tamper =
    checks.tamper &&
    s.tampers.some(
      (v) =>
        v.severity === 'WARNING' && v.source_message_id === r.uplink.find((m) => m.type === 'tamper')?.payload.meta.id,
    );
  checks.ack =
    checks.ack &&
    s.commands.some((v) => v.id === r.scope.commandId && v.status === 'SUCCEEDED') &&
    s.acks.some((v) => v.result === 'SUCCESS') &&
    s.targets.some((v) => v.id === r.scope.targetId && v.status === 'SUCCEEDED') &&
    ['NOTIFIED', 'DOWNLOADING', 'INSTALLING', 'SUCCEEDED'].every((v) => s.otaHistory.some((h) => h.to_status === v));
  checks.media =
    checks.media &&
    s.media.some(
      (v) => v.sha256 === r.scope.mediaHash && v.status === 'AVAILABLE' && v.object_path === r.scope.mediaKey,
    ) &&
    s.mediaSessions.some((v) => v.id === r.scope.mediaSessionId && v.status === 'COMPLETED');
  for (const t of ['cmd', 'ota', 'notification'])
    checks['downlink-' + t] = r.downlink.some((v) => v.type === t && v.schemaValid);
  checks['command-publication'] =
    s.attempts.some((v) => v.outcome === 'PUBLISHED') &&
    s.outbox.some((v) => v.event_type === 'COMMAND_PUBLISH_REQUESTED' && v.status === 'PUBLISHED');
  checks['notification-publication'] = s.outbox.some(
    (v) => v.id === r.scope.notificationId && v.status === 'PUBLISHED',
  );
  checks['uplink-correlations'] = r.uplink.every(
    (m) =>
      m.puback &&
      s.receipts.some(
        (v) =>
          v.topic_type === m.type &&
          v.seq === m.payload.meta.seq &&
          v.result === 'PROCESSED' &&
          v.customer_id === r.scope.customerId &&
          v.site_id === r.scope.siteId &&
          v.payload_hash === sha(canonicalizeJson(m.payload)),
      ),
  );
  checks['archive-outbox'] =
    s.outbox.some((v) => v.event_type === 'ARCHIVE' && v.topic_type === 'telemetry' && v.status === 'PUBLISHED') &&
    s.outbox.some((v) => v.event_type === 'ARCHIVE' && v.topic_type === 'report' && v.status === 'PUBLISHED') &&
    s.outbox.filter((v) => v.event_type === 'ARCHIVE').every((v) => v.status === 'PUBLISHED');
  return checks;
}
export async function main(output) {
  if (process.env.FDP_MQTT_BUSINESS_TEST !== '1' || !output || existsSync(output))
    throw Error('EXPLICIT_ENABLE_AND_FRESH_OUTPUT_REQUIRED');
  const dir = dirname(resolve(output));
  mkdirSync(dir, { recursive: true });
  const deviceId = 'mqttbiz-' + randomBytes(8).toString('hex');
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=',
    'base64',
  );
  const pkg = Buffer.from('Isolated MQTT OTA metadata test artifact ' + deviceId + '; not executable firmware.\n');
  const scope = {
    deviceId,
    ...Object.fromEntries(
      [
        'customerId',
        'siteId',
        'licenseId',
        'packageId',
        'campaignId',
        'targetId',
        'mediaSessionId',
        'notificationId',
      ].map((k) => [k, randomUUID()]),
    ),
    commandId: 'CMD-' + deviceId.toUpperCase() + '-1',
    mediaHash: sha(image),
    packageHash: sha(pkg),
    packageBytes: pkg.length,
    packageKey: `mqtt-business/${deviceId}/probe.bin`,
  };
  scope.mediaKey = `media/${scope.customerId}/${deviceId}/${scope.mediaSessionId}/probe.png`;
  validateScope(scope);
  const name = 'fdp-test-qa09-mqttbiz-' + deviceId.slice(8),
    policy = buildDevicePolicy({ region, accountId: account, thingName: deviceId });
  const r = {
    startedAt: new Date().toISOString(),
    scope,
    host,
    region,
    accountId: account,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceHashes: Object.fromEntries(
      ['scripts/run-mqtt-business-smoke.mjs', 'scripts/mqtt-business-fixture.mjs'].map((f) => [
        f,
        sha(readFileSync(f)),
      ]),
    ),
    mode: 'OWN_FIXTURES_IN_SHARED_TEST_ENVIRONMENT',
    physicalDevice: false,
    projectCaOnboarding: false,
    firmwareInstall: false,
    privateKeysPersisted: false,
    operations: [],
    uplink: [],
    downlink: [],
    observations: [],
    cleanup: [],
    gate: 'RUNNING',
  };
  const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  save();
  const aws = (service, op, args = [], read = false) => {
    try {
      const out = execFileSync(
        'aws',
        [
          service,
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
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, AWS_MAX_ATTEMPTS: '1' },
        },
      );
      return out.trim() ? JSON.parse(out) : {};
    } catch (e) {
      const msg = String(e.stderr ?? '');
      const code = msg.match(/\(([A-Za-z0-9]+)\)/)?.[1] ?? e.code ?? 'AWS_FAILED';
      throw Error(`${service}:${op}:${code}`);
    }
  };
  let counter = 0,
    createdFunction = false,
    createdThing = false,
    createdPolicy = false,
    seedAttempted = false,
    cert,
    client;
  const objects = [],
    objectHelpers = [];
  const db = (action) => {
    const key = String(++counter).padStart(3, '0') + '-' + action;
    const input = {
      action,
      ...(action === 'seed'
        ? {
            certificate: {
              id: cert.certificateId,
              arn: cert.certificateArn,
              fingerprint: new X509Certificate(cert.certificatePem).fingerprint256.replaceAll(':', '').toLowerCase(),
              notBefore: new Date(new X509Certificate(cert.certificatePem).validFrom).toISOString(),
              notAfter: new Date(new X509Certificate(cert.certificatePem).validTo).toISOString(),
            },
          }
        : {}),
    };
    const inputPath = resolve(dir, key + '-input.json'),
      outPath = resolve(dir, key + '-result.json');
    writeFileSync(inputPath, JSON.stringify(input));
    const meta = aws('lambda', 'invoke', [
      '--function-name',
      name,
      '--cli-binary-format',
      'raw-in-base64-out',
      '--payload',
      'file://' + inputPath,
      outPath,
    ]);
    const out = JSON.parse(readFileSync(outPath, 'utf8'));
    r.operations.push({
      action,
      at: new Date().toISOString(),
      status: out.error || meta.FunctionError ? 'FAIL' : 'PASS',
      receipt: key + '-result.json',
    });
    save();
    if (out.error || meta.FunctionError)
      throw Error('FIXTURE_' + action + '_' + JSON.stringify(out.error ?? meta.FunctionError));
    if (out.scope !== deviceId) throw Error('FIXTURE_SCOPE_MISMATCH');
    return out.result;
  };
  const registry = new SchemaRegistry(resolve('contracts/mqtt/schemas'));
  const publish = async (type, data) => {
    const seq = r.uplink.filter((v) => v.type === type).length + 1;
    const payload = buildProbePayload(type, data, deviceId, seq);
    const file = type + '.schema.json';
    if (validate(registry.load(file).doc, file, payload, registry).length) throw Error('INVALID_PAYLOAD_' + type);
    if (payload.audit && !verifyAuditHash(payload)) throw Error('INVALID_AUDIT_HASH');
    const row = {
      type,
      topic: `bnx/device/${deviceId}/${type}`,
      payload,
      qos: 1,
      retain: false,
      rawSha256: sha(JSON.stringify(payload)),
      puback: false,
    };
    r.uplink.push(row);
    save();
    await bounded(
      client.publishAsync(row.topic, JSON.stringify(payload), { qos: 1, retain: false }),
      15000,
      'PUBACK_TIMEOUT_' + type,
    );
    row.puback = true;
    row.pubackAt = new Date().toISOString();
    save();
  };
  const observe = () => {
    const state = db('observe');
    r.observations.push({
      at: new Date().toISOString(),
      receipts: state.receipts.length,
      downlink: r.downlink.length,
      commands: state.commands,
      targets: state.targets,
    });
    save();
    return state;
  };
  async function waitFor(label, test, ms = 120000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const s = observe();
      if (test(s)) return s;
      console.log(label + ': receipts=' + s.receipts.length + ', downlinks=' + r.downlink.length);
      await pause(6000);
    }
    throw Error('DEADLINE_' + label);
  }
  try {
    if (aws('sts', 'get-caller-identity').Account !== account) throw Error('WRONG_ACCOUNT');
    r.domain = aws('iot', 'describe-domain-configuration', ['--domain-configuration-name', 'bionexa-iot-prod'], true);
    if (r.domain.domainName !== host || r.domain.domainConfigurationStatus !== 'ENABLED')
      throw Error('DOMAIN_NOT_READY');
    r.workers = [];
    for (const suffix of [
      'ingestion',
      'command-publisher',
      'ota-dispatcher',
      'notification-publisher',
      'outbox-publisher',
      'archive',
    ])
      r.workers.push(
        aws(
          'lambda',
          'get-function-configuration',
          [
            '--function-name',
            'fdp-test-' + suffix,
            '--query',
            '{name:FunctionName,state:State,codeSha256:CodeSha256,lastModified:LastModified}',
          ],
          true,
        ),
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
    const mediaBucket = vars.MEDIA_BUCKET_NAME,
      otaBucket = 'fdp-test-ota-' + account;
    r.buckets = { media: mediaBucket, ota: otaBucket, raw: 'fdp-test-raw-' + account };
    for (const suffix of ['command-publisher', 'ota-dispatcher', 'notification-publisher']) {
      const schedule = aws('events', 'describe-rule', ['--name', 'fdp-test-' + suffix], true);
      if (schedule.State !== 'ENABLED') throw Error('SCHEDULE_NOT_ENABLED');
    }
    const buildDir = resolve(dir, 'lambda');
    mkdirSync(buildDir, { recursive: true });
    const { build } = require('esbuild');
    await build({
      entryPoints: ['scripts/mqtt-business-fixture.mjs'],
      outfile: buildDir + '/index.cjs',
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      external: ['@aws-sdk/client-secrets-manager', '@aws-sdk/client-s3', 'pg-native'],
      logLevel: 'silent',
    });
    const ca = await fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem', {
      signal: AbortSignal.timeout(20000),
    }).then((v) => {
      if (!v.ok) throw Error('CA_DOWNLOAD_FAILED');
      return v.text();
    });
    writeFileSync(buildDir + '/rds-ca-bundle.pem', ca);
    execFileSync('zip', ['-q', resolve(dir, 'fixture.zip'), 'index.cjs', 'rds-ca-bundle.pem'], { cwd: buildDir });
    r.fixture = { name, role: cfg.Role, codeSha256: sha(readFileSync(resolve(dir, 'fixture.zip'))) };
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
      JSON.stringify({ Variables: { DB_SECRET_ARN: vars.DB_SECRET_ARN, MQTT_SCOPE: JSON.stringify(scope) } }),
    ]);
    createdFunction = true;
    save();
    for (let n = 0; n < 30; n++) {
      const s = aws(
        'lambda',
        'get-function-configuration',
        ['--function-name', name, '--query', '{State:State,Reason:StateReason}'],
        true,
      );
      if (s.State === 'Active') break;
      if (s.State === 'Failed') throw Error('FIXTURE_LAMBDA_FAILED');
      await pause(2000);
    }
    const pre = db('preflight');
    if (pre.database.name !== 'fdp' || pre.ownDeviceCount !== 0) throw Error('FIXTURE_NOT_EMPTY');
    aws('iot', 'create-thing', ['--thing-name', deviceId]);
    createdThing = true;
    cert = aws('iot', 'create-keys-and-certificate', ['--set-as-active']);
    r.certificateId = cert.certificateId;
    save();
    aws('iot', 'create-policy', [
      '--policy-name',
      policy.policyName,
      '--policy-document',
      JSON.stringify(policy.policyDocument),
    ]);
    createdPolicy = true;
    aws('iot', 'attach-policy', ['--policy-name', policy.policyName, '--target', cert.certificateArn]);
    aws('iot', 'attach-thing-principal', ['--thing-name', deviceId, '--principal', cert.certificateArn]);
    for (const [type, bucket, key, body, sourceFunction] of [
      ['media', mediaBucket, scope.mediaKey, image, 'fdp-test-device-api-handler'],
      ['ota', otaBucket, scope.packageKey, pkg, 'fdp-test-api'],
    ]) {
      const helper = name + '-' + type;
      const role = aws(
        'lambda',
        'get-function-configuration',
        ['--function-name', sourceFunction, '--query', 'Role'],
        true,
      );
      aws('lambda', 'create-function', [
        '--function-name',
        helper,
        '--runtime',
        'nodejs24.x',
        '--role',
        role,
        '--handler',
        'index.handler',
        '--timeout',
        '30',
        '--memory-size',
        '256',
        '--zip-file',
        'fileb://' + resolve(dir, 'fixture.zip'),
        '--environment',
        JSON.stringify({ Variables: { MQTT_SCOPE: JSON.stringify(scope), MQTT_OBJECT_ONLY: type } }),
      ]);
      objectHelpers.push(helper);
      r.objectHelpers = [...objectHelpers];
      save();
      for (let n = 0; n < 30; n++) {
        const state = aws(
          'lambda',
          'get-function-configuration',
          ['--function-name', helper, '--query', 'State'],
          true,
        );
        if (state === 'Active') break;
        await pause(1000);
      }
      const input = resolve(dir, 'upload-' + type + '.json'),
        out = resolve(dir, 'upload-' + type + '-result.json');
      writeFileSync(input, JSON.stringify({ action: 'put-' + type, bodyBase64: body.toString('base64') }));
      const meta = aws('lambda', 'invoke', [
        '--function-name',
        helper,
        '--cli-binary-format',
        'raw-in-base64-out',
        '--payload',
        'file://' + input,
        out,
      ]);
      const result = JSON.parse(readFileSync(out, 'utf8'));
      if (meta.FunctionError || result.error || result.scope !== deviceId)
        throw Error('APPLICATION_ROLE_UPLOAD_FAILED_' + type + '_' + JSON.stringify(result.error ?? result.errorType));
      objects.push({ bucket, key, versionId: result.result.versionId });
      r.testObjects = [...objects];
      save();
    }
    seedAttempted = true;
    db('seed');
    console.log('Owned database, license, certificate and media fixture ready.');
    const connected = new Promise((res, rej) => {
      client = connect(`mqtts://${host}:8883`, {
        clientId: deviceId,
        servername: host,
        cert: cert.certificatePem,
        key: cert.keyPair.PrivateKey,
        rejectUnauthorized: true,
        protocolVersion: 4,
        clean: true,
        reconnectPeriod: 0,
        connectTimeout: 15000,
        keepalive: 60,
      });
      client.on('error', (e) => rej(Error('MQTT_' + String(e.code ?? 'ERROR'))));
      client.once('connect', (p) => {
        r.connack = { returnCode: p.returnCode, sessionPresent: p.sessionPresent };
        res();
      });
      client.once('close', () => rej(Error('MQTT_CLOSED')));
    });
    client.on('message', (topic, bytes) => {
      try {
        const type = topic.split('/').at(-1);
        if (!['cmd', 'ota', 'notification'].includes(type) || topic !== `bnx/device/${deviceId}/${type}`)
          throw Error('DOWNLINK_SCOPE');
        const payload = JSON.parse(bytes);
        const file = type + '.schema.json';
        const errors = validate(registry.load(file).doc, file, payload, registry);
        const redacted = structuredClone(payload);
        if (type === 'ota') {
          const u = new URL(redacted.data.downloadUrl);
          u.search = '';
          redacted.data.downloadUrl = u.toString() + '?token=REDACTED';
        }
        r.downlink.push({
          type,
          topic,
          receivedAt: new Date().toISOString(),
          rawSha256: sha(bytes),
          schemaValid: errors.length === 0,
          payload: redacted,
        });
        save();
      } catch {
        r.downlinkError = 'INVALID_DOWNLINK';
        save();
      }
    });
    await bounded(connected, 18000, 'CONNECT_TIMEOUT');
    r.subscriptions = await bounded(
      client.subscribeAsync(
        ['cmd', 'ota', 'notification'].map((t) => `bnx/device/${deviceId}/${t}`),
        { qos: 1 },
      ),
      12000,
      'SUBACK_TIMEOUT',
    );
    if (r.subscriptions.some((g) => g.qos !== 1)) throw Error('SUBACK_REJECTED');
    const base = (name) => JSON.parse(readFileSync(`docs/api/mqtt-examples/payloads/${name}`, 'utf8')).data;
    const hb = base('01-heartbeat.json');
    hb.firmwareVersion = '0.0.0-test';
    hb.machineMode = 'IDLE';
    hb.machineRunning = false;
    hb.uptimeSeconds = 10;
    hb.licenseExpiryDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await publish('heartbeat', hb);
    await publish('telemetry', base('02-telemetry.json'));
    const report = base('03-report.json');
    report.reportType = 'CYCLE';
    report.periodStartTime = new Date(Date.now() - 60000).toISOString();
    report.periodEndTime = new Date().toISOString();
    await publish('report', report);
    const alarm = base('04-alarm.json');
    alarm.code = 'MQTT_PROBE_TEMP';
    alarm.severity = 'WARNING';
    alarm.detectedTime = new Date().toISOString();
    await publish('alarm', alarm);
    await waitFor('alarm-active', (s) => s.alarms.some((v) => v.status === 'ACTIVE'), 60000);
    alarm.status = 'CLEARED';
    alarm.currentValue = 72;
    alarm.detectedTime = new Date().toISOString();
    await publish('alarm', alarm);
    await publish('event', { eventType: 'MQTT_BUSINESS_PROBE', source: 'LOCAL', remarks: deviceId });
    await publish('tamper', {
      eventType: 'MQTT_BUSINESS_PROBE',
      severity: 'WARNING',
      component: 'TEST_CLIENT',
      details: deviceId,
      actionTaken: 'EVENT_RECORDED',
    });
    await publish('media', {
      mediaType: 'IMAGE',
      captureTime: new Date().toISOString(),
      fileName: 'probe.png',
      objectPath: scope.mediaKey,
      sizeKb: 1,
      durationSec: 0,
    });
    db('arm');
    console.log('Eight-uplink test in progress; waiting for deployed publishers.');
    await waitFor(
      'downlink-published',
      (s) =>
        s.commands.some((v) => v.status === 'PUBLISHED') &&
        s.targets.some((v) => v.status === 'NOTIFIED') &&
        s.outbox.some((v) => v.id === scope.notificationId && v.status === 'PUBLISHED') &&
        ['cmd', 'ota', 'notification'].every((t) => r.downlink.some((m) => m.type === t)),
      150000,
    );
    const cmd = r.downlink.find((m) => m.type === 'cmd');
    if (cmd.payload.meta.id !== scope.commandId || cmd.payload.data.command !== 'FORCE_SYNC')
      throw Error('COMMAND_CORRELATION');
    const ota = r.downlink.find((m) => m.type === 'ota');
    if (
      decodeURIComponent(new URL(ota.payload.data.downloadUrl).pathname.split('/').at(-2)) !== scope.targetId ||
      ota.payload.data.sha256 !== scope.packageHash
    )
      throw Error('OTA_CORRELATION');
    if (
      !r.downlink.some(
        (m) =>
          m.type === 'notification' &&
          m.payload.meta.id === 'NTF-' + scope.notificationId.toUpperCase() &&
          m.payload.data.type === 'SYNC_REQUIRED',
      )
    )
      throw Error('NOTIFICATION_CORRELATION');
    await publish('ack', {
      objectType: 'COMMAND',
      commandId: scope.commandId,
      command: 'FORCE_SYNC',
      result: 'SUCCESS',
      executeTimeMs: 1,
      errorCode: null,
      message: 'Isolated client acknowledged command; no physical machine action',
    });
    for (const status of ['DOWNLOADING', 'INSTALLING', 'SUCCEEDED']) {
      await publish('ack', {
        objectType: 'OTA_TARGET',
        otaTargetId: scope.targetId,
        status,
        errorCode: null,
        message: 'Isolated MQTT status emulator; no firmware installed',
      });
      await waitFor('ota-' + status, (s) => s.targets.some((v) => v.status === status), 60000);
    }
    const state = await waitFor(
      'all-business-results',
      (s) => Object.values(evaluateBusiness(s, r)).every(Boolean),
      150000,
    );
    r.finalState = state;
    const archivePrefixes = ['telemetry', 'report', 'alarm', 'event', 'tamper', 'ack']
      .map((t) => `raw/topic_type=${t}/customer_id=${scope.customerId}/`)
      .concat(
        ['publication', 'result'].map(
          (t) => `operations/operation_type=ota/record_type=${t}/customer_id=${scope.customerId}/`,
        ),
      );
    r.archivePrefixes = archivePrefixes;
    const expectedEvents = state.outbox.filter((v) => v.event_type === 'ARCHIVE').map((v) => v.id);
    const found = new Set();
    r.archives = [];
    r.archiveManifests = [];
    const archiveDeadline = Date.now() + 150000;
    while (Date.now() < archiveDeadline) {
      const response = db('read-archives');
      for (const obj of response.objects) {
        if (!archivePrefixes.some((prefix) => obj.key.startsWith(prefix))) throw Error('ARCHIVE_SCOPE_LIMIT');
        const kind = archiveObjectKind(obj.key);
        if (kind === 'manifest') {
          if (!r.archiveManifests.some((v) => v.key === obj.key)) {
            const content = Buffer.from(obj.base64, 'base64');
            const manifest = JSON.parse(content.toString());
            if (
              manifest.customerId !== scope.customerId ||
              !archivePrefixes.some((prefix) => manifest.key.startsWith(prefix))
            )
              throw Error('MANIFEST_SCOPE');
            r.archiveManifests.push({
              key: obj.key,
              sha256: sha(content),
              archiveKey: manifest.key,
              archiveSha256: manifest.sha256,
              recordCount: manifest.recordCount,
            });
            save();
          }
          continue;
        }
        if (r.archives.some((v) => v.key === obj.key)) continue;
        const bytes = Buffer.from(obj.base64, 'base64');
        writeFileSync(resolve(dir, 'archive-' + r.archives.length + '.json.gz'), bytes);
        const lines = gunzipSync(bytes, { maxOutputLength: 4194304 }).toString().trim().split('\n').map(JSON.parse);
        for (const line of lines) {
          if (line.deviceId !== deviceId) throw Error('ARCHIVE_DEVICE_SCOPE');
          if (expectedEvents.includes(line.eventId)) found.add(line.eventId);
          if (line.rawBody) {
            const raw = JSON.parse(line.rawBody),
              m = r.uplink.find((v) => v.payload.meta.id === raw.meta?.id);
            if (!m) throw Error('UNKNOWN_ARCHIVE_MESSAGE');
            const payload = Object.fromEntries(
              Object.entries(raw).filter(
                ([k]) => !['iotTopic', 'iotDeviceId', 'iotType', 'iotReceivedAt', 'iotPrincipal'].includes(k),
              ),
            );
            if (sha(canonicalizeJson(payload)) !== sha(canonicalizeJson(m.payload)))
              throw Error('ARCHIVE_PAYLOAD_MISMATCH');
          }
        }
        r.archives.push({
          key: obj.key,
          sha256: sha(bytes),
          records: lines.length,
          eventIds: lines.map((v) => v.eventId),
        });
        save();
      }
      if (
        expectedEvents.every((id) => found.has(id)) &&
        r.archives.every((o) =>
          r.archiveManifests.some(
            (m) => m.archiveKey === o.key && m.archiveSha256 === o.sha256 && m.recordCount === o.records,
          ),
        )
      )
        break;
      console.log('Waiting for archive objects: ' + found.size + '/' + expectedEvents.length);
      await pause(7000);
    }
    r.archiveCheck = {
      expectedEventIds: expectedEvents,
      foundEventIds: [...found],
      passed:
        expectedEvents.length > 0 &&
        expectedEvents.every((id) => found.has(id)) &&
        r.archives.every((o) =>
          r.archiveManifests.some(
            (m) => m.archiveKey === o.key && m.archiveSha256 === o.sha256 && m.recordCount === o.records,
          ),
        ),
    };
    if (!r.archiveCheck.passed) throw Error('ARCHIVE_OBJECT_DEADLINE');
    r.checks = evaluateBusiness(state, r);
    r.checks['physical-s3-archives'] = r.archiveCheck.passed;
    r.gate = Object.values(r.checks).every(Boolean) ? 'PASS' : 'FAIL';
    save();
    console.log('All 8 uplinks and 3 downlinks have matching cloud business results.');
  } catch (e) {
    r.gate = 'FAIL';
    r.failure = String(e.message).slice(0, 500);
    console.log('Business probe failed: ' + r.failure);
    save();
  } finally {
    if (client) {
      try {
        await bounded(client.endAsync(false), 5000, 'DISCONNECT_TIMEOUT');
      } catch {
        client.end(true);
      }
      client = null;
    }
    const cleanup = async (name, fn) => {
      try {
        const detail = await fn();
        r.cleanup.push({ name, status: 'PASS', ...(detail === undefined ? {} : { detail }) });
      } catch (e) {
        r.cleanup.push({ name, status: 'FAIL', error: String(e.message).slice(0, 250) });
      }
      save();
    };
    if (seedAttempted) await cleanup('quiesce-owned-publishers', () => db('quiesce'));
    if (seedAttempted) {
      await pause(5000);
      await cleanup('delete-owned-database-fixtures', () => db('cleanup'));
      await cleanup('database-empty-readback', () => {
        const s = db('audit-empty');
        r.afterCleanup = s;
        const lists = [
          'devices',
          'certificates',
          'latest',
          'receipts',
          'telemetry',
          'reports',
          'alarms',
          'events',
          'tampers',
          'commands',
          'attempts',
          'acks',
          'targets',
          'otaHistory',
          'media',
          'mediaSessions',
          'outbox',
        ];
        if (
          lists.some((k) => s[k].length) ||
          Object.entries(s.fixtureCounts).some(([k, v]) => v !== (k === 'customers' ? 1 : 0)) ||
          !s.auditCustomerTombstone.some((c) => c.id === scope.customerId && c.status === 'SUSPENDED' && c.deleted_at)
        )
          throw Error('OWN_DATABASE_REMAINS');
        return {
          activeFixturesRemoved: true,
          auditLogsRetained: s.audits.length,
          auditCustomerTombstoneRetained: true,
        };
      });
    }
    for (const o of objects)
      await cleanup('delete-test-s3-object:' + o.key, () =>
        aws('s3api', 'delete-object', [
          '--bucket',
          o.bucket,
          '--key',
          o.key,
          ...(o.versionId ? ['--version-id', o.versionId] : []),
        ]),
      );
    if (seedAttempted && r.buckets) {
      const prefixes =
        r.archivePrefixes ??
        ['telemetry', 'report', 'alarm', 'event', 'tamper', 'ack']
          .map((t) => `raw/topic_type=${t}/customer_id=${scope.customerId}/`)
          .concat(
            ['publication', 'result'].map(
              (t) => `operations/operation_type=ota/record_type=${t}/customer_id=${scope.customerId}/`,
            ),
          );
      await cleanup('delete-owned-raw-archive-versions', () => {
        let deleted = 0;
        for (const prefix of prefixes) {
          const listed = aws('s3api', 'list-object-versions', ['--bucket', r.buckets.raw, '--prefix', prefix], true);
          const versions = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])];
          if (listed.IsTruncated || versions.length > 200) throw Error('ARCHIVE_VERSION_LIMIT');
          for (const obj of versions) {
            if (!obj.Key.startsWith(prefix)) throw Error('ARCHIVE_DELETE_SCOPE');
            aws('s3api', 'delete-object', ['--bucket', r.buckets.raw, '--key', obj.Key, '--version-id', obj.VersionId]);
            deleted++;
          }
          const after = aws('s3api', 'list-object-versions', ['--bucket', r.buckets.raw, '--prefix', prefix], true);
          if (after.Versions?.length || after.DeleteMarkers?.length) throw Error('ARCHIVE_VERSIONS_REMAIN');
        }
        return { deletedVersions: deleted, remaining: 0 };
      });
    }
    if (cert && createdPolicy)
      await cleanup('detach-iot-policy', () =>
        aws('iot', 'detach-policy', ['--policy-name', policy.policyName, '--target', cert.certificateArn]),
      );
    if (cert && createdThing)
      await cleanup('detach-iot-principal', () =>
        aws('iot', 'detach-thing-principal', ['--thing-name', deviceId, '--principal', cert.certificateArn]),
      );
    if (cert) {
      await cleanup('deactivate-test-certificate', () =>
        aws('iot', 'update-certificate', ['--certificate-id', cert.certificateId, '--new-status', 'INACTIVE']),
      );
      await cleanup('delete-test-certificate', () =>
        aws('iot', 'delete-certificate', ['--certificate-id', cert.certificateId]),
      );
    }
    if (createdPolicy)
      await cleanup('delete-iot-policy', () => aws('iot', 'delete-policy', ['--policy-name', policy.policyName]));
    if (createdThing) await cleanup('delete-iot-thing', () => aws('iot', 'delete-thing', ['--thing-name', deviceId]));
    if (createdFunction)
      await cleanup('delete-fixture-lambda', () => aws('lambda', 'delete-function', ['--function-name', name]));
    for (const helper of objectHelpers)
      await cleanup('delete-upload-helper:' + helper, () =>
        aws('lambda', 'delete-function', ['--function-name', helper]),
      );
    r.retainedAuditLogGroups = [...(createdFunction ? [name] : []), ...objectHelpers].map((n) => '/aws/lambda/' + n);
    r.auditRetentionReason =
      'Existing DenySecurityAuditTampering policy; no log deletion or IAM changes attempted by this run.';
    cert = null;
    r.finishedAt = new Date().toISOString();
    r.cleanupGate = r.cleanup.every((v) => v.status === 'PASS') ? 'PASS' : 'FAIL';
    save();
    console.log(JSON.stringify({ gate: r.gate, cleanup: r.cleanupGate, deviceId, output }));
  }
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const r = await main(process.argv[2]);
  if (r.gate !== 'PASS' || r.cleanupGate !== 'PASS') process.exitCode = 1;
}
