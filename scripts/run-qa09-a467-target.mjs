import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, X509Certificate, createPrivateKey } from 'node:crypto';
import { request } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { connectAsync, connect } from 'mqtt';
import { observeMqttConnect, oldMqttDenial } from './qa09-bounded-mqtt-connect.mjs';
import { main, createCsr, mtlsPost, publishKnown } from './run-qa09-ten-device-acceptance.mjs';
import { assertRotationProof, assertRotationSchedule } from './qa09-a467-proof.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let deactivationBudget;
export function deviceRequest(cert, key, path, body) {
  if (!['/api/v1/device/certificate/rotate', '/api/v1/device/media/upload-sessions'].includes(path))
    throw Error('FIXED_DEVICE_PATH_REQUIRED');
  return new Promise((resolve) => {
    const req = request(
      'https://device-api.bio-nexa.com' + path,
      {
        method: 'POST',
        cert,
        key,
        rejectUnauthorized: true,
        timeout: 20000,
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
const extension = async ({ receipt, held, clients, db, check, save, observation }) => {
  receipt.batchArchiveCleanup = true;
  const id = receipt.devices[0],
    k = held.get(id);
  const r = { gate: 'RUNNING', before: observation, deviceId: id };
  receipt.rotation = r;
  save();
  r.oldCertificateId = r.before.certificates[0].id;
  const before = await mtlsPost(k.cert, k.key);
  check('rotation-old-rest-valid-control', before.status === 200 && !!before.requestId, {
    status: before.status,
    requestId: before.requestId,
  });
  const media = await deviceRequest(k.cert, k.key, '/api/v1/device/media/upload-sessions', {
    mediaType: 'IMAGE',
    fileName: 'qa09.png',
    sizeKb: 1,
    sizeBytes: 1,
    sha256: hash(Buffer.from('x')),
  });
  check('media-onboarded-lifecycle-denied', media.status === 403 && !!media.requestId, {
    status: media.status,
    requestId: media.requestId,
  });
  receipt.mediaDisposition = 'POSITIVE_UPLOAD_REQUIRES_ACTIVE_OR_MAINTENANCE_DEFERRED_WITH_A2_NOT_ACCEPTED';
  const next = createCsr(id);
  const result = await deviceRequest(k.cert, k.key, '/api/v1/device/certificate/rotate', {
    currentCertificateId: r.oldCertificateId,
    csrPem: next.csrPem,
  });
  check('rotation-real-csr-issued', result.status === 200 && !!result.requestId, {
    status: result.status,
    requestId: result.requestId,
  });
  const v = result.body?.data ?? result.body;
  const cert = new X509Certificate(v.certificatePem);
  check(
    'rotation-new-key-match',
    cert.checkPrivateKey(createPrivateKey(next.key)) && v.certificateId !== r.oldCertificateId,
  );
  r.newCertificateId = v.certificateId;
  r.newFingerprint = hash(cert.raw);
  save();
  await k.client.endAsync(true);
  const mqtt = await connectAsync(`mqtts://${k.endpoint}:8883`, {
    clientId: id,
    cert: v.certificatePem,
    key: next.key,
    rejectUnauthorized: true,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 15000,
  });
  mqtt.on('error', () => {});
  clients.push(mqtt);
  r.newMqttConnected = mqtt.connected;
  const payload = k.sim.payload('heartbeat'),
    raw = JSON.stringify(payload);
  await publishKnown(mqtt, `bnx/device/${id}/heartbeat`, raw);
  receipt.published.push({
    deviceId: id,
    type: 'heartbeat',
    messageId: payload.meta.id,
    seq: payload.meta.seq,
    bodySha256: hash(raw),
  });
  save();
  const newer = await mtlsPost(v.certificatePem, next.key);
  r.newRestStatus = newer.status;
  check('rotation-new-rest', newer.status === 200 && !!newer.requestId, {
    status: newer.status,
    requestId: newer.requestId,
  });
  const deadline = Date.now() + 120000;
  do {
    r.after = await db('observe');
    save();
    if (r.after.certificates.some((c) => c.id === r.newCertificateId && c.rotation_confirmed_at)) break;
    if (Date.now() > deadline) throw Error('DUAL_CHANNEL_CONFIRMATION_DEADLINE');
    await sleep(5000);
  } while (!r.after.certificates.some((c) => c.id === r.newCertificateId && c.rotation_confirmed_at));
  const old = await mtlsPost(k.cert, k.key);
  r.oldRestStatus = old.status;
  check('rotation-old-rest-denied', old.status === 401 && !!old.requestId, {
    status: old.status,
    requestId: old.requestId,
  });
  const exec = promisify(execFile);
  // The existing certificate sweeper runs every five minutes; DB reads do not consume this allowance.
  const deactivationDeadline = Date.now() + deactivationBudget;
  do {
    const { stdout } = await exec(
      'aws',
      [
        'iot',
        'describe-certificate',
        '--certificate-id',
        r.oldCertificateId,
        '--profile',
        'esgiot-readonly',
        '--region',
        'ap-southeast-1',
        '--output',
        'json',
        '--no-cli-pager',
      ],
      { timeout: 20000 },
    );
    r.oldIotStatus = JSON.parse(stdout).certificateDescription.status;
    save();
    if (r.oldIotStatus === 'INACTIVE') break;
    if (Date.now() > deactivationDeadline) throw Error('OLD_IOT_DEACTIVATION_DEADLINE');
    await sleep(10000);
  } while (r.oldIotStatus !== 'INACTIVE');
  await mqtt.endAsync(true);
  const options = {
    clientId: id,
    rejectUnauthorized: true,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 15000,
  };
  const negative = await observeMqttConnect(connect, `mqtts://${k.endpoint}:8883`, {
    ...options,
    cert: k.cert,
    key: k.key,
  });
  if (negative.client) {
    clients.push(negative.client);
    negative.client.end(true);
  }
  r.oldMqttOutcome = negative.outcome;
  r.oldMqttErrorCode = negative.errorCode;
  save();
  const control = await observeMqttConnect(connect, `mqtts://${k.endpoint}:8883`, {
    ...options,
    cert: v.certificatePem,
    key: next.key,
  });
  r.adjacentNewMqttControl = control.outcome === 'CONNECTED';
  if (control.client) {
    clients.push(control.client);
    control.client.end(true);
  }
  r.oldMqttRejection = oldMqttDenial(negative.outcome, r.oldIotStatus, r.adjacentNewMqttControl);
  Object.assign(r, assertRotationProof(r));
  save();
};
extension.rotationOnly = true;
const [output, versionPath] = process.argv.slice(2);
if (!output || !versionPath || existsSync(output) || existsSync(output + '.sources.json'))
  throw Error('FRESH_TARGET_AND_VERSION_REQUIRED');
deactivationBudget = assertRotationSchedule(
  JSON.parse(readFileSync(join(dirname(output), 'cert-sweeper-schedule.json'))),
);
const paths = [
  'scripts/run-qa09-a467-target.mjs',
  'scripts/qa09-a467-proof.mjs',
  'scripts/qa09-bounded-mqtt-connect.mjs',
  'scripts/qa09-a7-tablet-browser.mjs',
  'scripts/run-qa09-ten-device-acceptance.mjs',
  'scripts/qa09-ten-device-db.mjs',
];
writeFileSync(
  output + '.sources.json',
  JSON.stringify(
    {
      sources: paths.map((path) => {
        const b = readFileSync(path);
        return { path, sha256: hash(b), sourceBase64: b.toString('base64') };
      }),
    },
    null,
    2,
  ) + '\n',
);
const result = await main(output, versionPath, extension, { reviewOnly: false, rotationOnly: true });
console.log(
  JSON.stringify({
    gate: result.gate,
    rotation: result.rotation?.gate,
    tablet: result.tabletGap?.gate,
    failure: result.failure,
  }),
);
process.exitCode = result.gate === 'PASS' ? 0 : 1;
