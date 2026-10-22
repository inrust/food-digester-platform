/** Offline evidence verification only; never makes a network request. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { canonicalizeJson } from '../../../../contracts/mqtt/payload-normalization.ts';
const dir = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(dir, '../../../..');
const read = (f) => readFileSync(resolve(dir, f));
const json = (f) => JSON.parse(read(f));
const sha = (v) => createHash('sha256').update(v).digest('hex');
const r = json('attempt-1/receipt.json');
assert.equal(r.gate, 'PASS');
assert.equal(r.mode, 'REAL_APPLICATION_CSR_NO_DB_SEED');
assert.equal(r.target.account, '065986019555');
assert.equal(r.target.region, 'ap-southeast-1');
assert.equal(r.physicalDevice, false);
assert.equal(r.fullQa09Accepted, false);
assert.equal(r.privateKeysPersisted, false);
assert(r.checks.length >= 45 && r.checks.every((c) => c.result === 'PASS'));
assert.equal(r.cleanup.length, 3);
assert(r.cleanup.every((c) => c.result === 'PASS'));
assert.equal(r.certificates.length, 3);
assert.equal(new Set(r.certificates.map((c) => c.publicKeyFingerprint)).size, 3);
const sources = json('sources.json');
for (const [path, hash] of Object.entries(r.sourceHashes)) {
  assert.equal(sources[path].sha256, hash);
  assert.equal(sha(Buffer.from(sources[path].base64, 'base64')), hash);
  assert.equal(sha(readFileSync(resolve(root, path))), hash, 'current execution source drift: ' + path);
}
assert.deepEqual(r.workersBefore, r.workersAfter);
assert(r.workersBefore.every((w) => w.State === 'Active'));
assert.equal(r.schedules[1].State, 'ENABLED');
assert.equal(r.schedules[1].ScheduleExpression, 'rate(5 minutes)');
for (const row of r.database) {
  assert.equal(row.result, 'PASS');
  const d = json('attempt-1/' + row.file);
  assert.equal(d.scope, r.scope.serial);
  assert(!d.error);
  assert.deepEqual(d.result.outsideFingerprints, r.baseline.outsideFingerprints);
}
const states = r.database.map((row) => json('attempt-1/' + row.file).result);
const pending = states.find(
  (s) => s.devices[0]?.lifecycle_status === 'OnboardingApproved' && s.certificates[0]?.status === 'PENDING_CLAIM',
);
assert(pending && !pending.certificates[0].mqtt_verified_at && !pending.certificates[0].rest_verified_at);
const activated = states.find(
  (s) =>
    s.devices[0]?.lifecycle_status === 'Onboarded' &&
    s.certificates[0]?.mqtt_verified_at &&
    !s.certificates[0]?.rest_verified_at,
);
assert(activated && activated.certificates[0].package_destroyed);
assert(activated.history.some((h) => h.from_status === 'OnboardingApproved' && h.to_status === 'Onboarded'));
for (const c of r.certificates) {
  const leaf = new X509Certificate(read('attempt-1/' + c.label + '-certificate.pem'));
  const blocks = read('attempt-1/' + c.label + '-chain.pem')
    .toString()
    .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  const chain = blocks.map((p) => new X509Certificate(p));
  assert.equal(sha(leaf.raw), c.fingerprint);
  assert.equal(c.id, c.fingerprint);
  assert.equal(leaf.subject, 'CN=' + r.deviceId);
  assert(leaf.subjectAltName.includes('URI:urn:fdp:device:' + r.deviceId));
  for (const [i, cert] of [leaf, ...chain].entries()) {
    const issuer = chain[i] ?? cert;
    assert(cert.checkIssued(issuer) && cert.verify(issuer.publicKey));
    if (i > 0) assert(cert.ca);
  }
  assert.deepEqual(
    chain.map((v) => sha(v.raw)),
    r.certificates[0].chainFingerprints,
  );
  const csr = forge.pki.certificationRequestFromPem(
    c.label === 'initial'
      ? json('attempt-1/initial-request.json').csrPem
      : read('attempt-1/' + c.label + '-csr.pem').toString(),
  );
  assert(csr.verify());
  const fc = forge.pki.certificateFromPem(leaf.toString());
  assert.equal(csr.publicKey.n.toString(16), fc.publicKey.n.toString(16));
  assert.equal(csr.publicKey.e.toString(16), fc.publicKey.e.toString(16));
  assert(fc.getExtension('keyUsage').digitalSignature && fc.getExtension('extKeyUsage').clientAuth);
}
assert.equal(r.cloudProvisioning.thing.thingName, r.deviceId);
assert.equal(r.cloudProvisioning.certificate.certificateDescription.status, 'ACTIVE');
assert(
  r.cloudProvisioning.principals.principals.includes(
    `arn:aws:iot:ap-southeast-1:065986019555:cert/${r.certificates[0].id}`,
  ),
);
const policy = JSON.parse(json('attempt-1/device-policy.json').policyDocument);
assert.equal(policy.Statement.length, 4);
assert(
  policy.Statement.every(
    (s) => s.Effect === 'Allow' && s.Resource.every((v) => v.includes(r.deviceId) && !v.includes('*')),
  ),
);
assert.equal(policy.Statement.find((s) => s.Sid === 'PublishOwnUplink').Resource.length, 8);
assert.equal(policy.Statement.find((s) => s.Sid === 'SubscribeOwnDownlink').Resource.length, 3);
assert.deepEqual(
  r.rotations.map((v) => v.order),
  ['MQTT_THEN_REST', 'REST_THEN_MQTT'],
);
for (const rot of r.rotations) {
  const old = rot.single.certificates.find((c) => c.id === rot.oldId),
    next = rot.single.certificates.find((c) => c.id === rot.newId),
    channel = rot.order === 'MQTT_THEN_REST' ? 'mqtt' : 'rest';
  assert.equal(old.status, 'ACTIVE');
  assert(!old.revoked_at);
  assert.equal(next.status, 'ACTIVE');
  assert.equal(next.rotated_from_id, rot.oldId);
  assert(next[channel + '_verified_at']);
  assert(!next[(channel === 'mqtt' ? 'rest' : 'mqtt') + '_verified_at']);
  assert(!next.rotation_confirmed_at);
  assert.equal(rot.oldIotSingle, 'ACTIVE');
  const dOld = rot.dual.certificates.find((c) => c.id === rot.oldId),
    dNew = rot.dual.certificates.find((c) => c.id === rot.newId);
  assert.equal(dOld.status, 'REVOKED');
  assert(
    dOld.revoked_at &&
      dNew.mqtt_verified_at &&
      dNew.rest_verified_at &&
      dNew.rotation_confirmed_at &&
      dNew.package_destroyed,
  );
  assert.equal(dNew.rotated_from_id, rot.oldId);
  assert(Date.parse(dNew.rotation_confirmed_at) < Date.parse(dNew.rotation_deadline_at));
  assert.equal(rot.oldIotStatus, 'INACTIVE');
  assert(rot.adjacentNewMqttControl);
  assert(['CLOSED_BEFORE_CONNACK', 'CONNECTION_RESET', 'NOT_AUTHORIZED'].includes(rot.oldMqttOutcome));
  assert(rot.oldMqttDenial);
  const swept = r.finalState.certificates.find((c) => c.id === rot.oldId);
  assert.equal(swept.iot_deactivation_pending, false);
  assert(swept.iot_deactivated_at);
}
const heartbeats = r.checks.filter((c) => c.puback);
assert.equal(heartbeats.length, 3);
assert.equal(r.finalState.receipts.length, 3);
for (const m of heartbeats) {
  assert.equal(m.rawSha256, sha(JSON.stringify(m.payload)));
  assert(
    r.finalState.receipts.some(
      (v) =>
        v.result === 'PROCESSED' && v.seq === m.payload.meta.seq && v.payload_hash === sha(canonicalizeJson(m.payload)),
    ),
  );
}
assert.equal(r.finalState.history.filter((h) => h.to_status === 'Onboarded').length, 1);
const http = (label) => {
  const v = r.http.find((v) => v.label === label);
  assert(v?.requestId);
  return v;
};
assert.equal(http('csr-application').status, 201);
assert.equal(http('nonce-replay').status, 401);
assert.equal(http('admin-approve').status, 200);
for (const label of ['initial-rest-sync', 'latest-rest-valid-control']) {
  const v = http(label);
  assert.equal(v.status, 200);
  assert.equal(v.body.deviceId, r.deviceId);
  assert.equal(v.body.assignment, null);
  assert.equal(v.body.license, null);
  assert.deepEqual(v.body.deviceUsers, []);
  assert.equal(v.body.operationalStatus.lifecycleStatus, 'Onboarded');
}
for (const channel of ['mqtt', 'rest']) {
  assert.equal(http('old-valid-after-' + channel + '-only').status, 200);
  assert.equal(http('old-revoked-after-' + channel + '-dual').status, 401);
}
assert.equal(r.cleanupState.devices.length, 0);
assert.equal(r.cleanupState.requests.length, 0);
assert.equal(r.cleanupState.certificates.length, 0);
assert(r.cleanupState.users.every((u) => u.status === 'DISABLED'));
const deletion = r.cleanup.find((c) => c.label === 'owned-iot-and-database').detail;
assert.equal(deletion.deleted.devices, 1);
assert.equal(deletion.deleted.device_certificates, 3);
assert.equal(deletion.deleted.device_public_keys, 3);
assert.equal(deletion.deleted.ingestion_receipts, 3);
assert(deletion.auditRowsRetained > 0);
const readback = json('cleanup-readback.json');
assert(
  readback.checks.length === 7 &&
    readback.checks.every(
      (c) => c.result === 'PASS' && ['ResourceNotFoundException', 'UserNotFoundException'].includes(c.code),
    ),
);
assert(/ℹ tests 78\n/.test(read('local-tests.log').toString()));
assert(/ℹ fail 0\n/.test(read('local-tests.log').toString()));
const files = (base = '') =>
  readdirSync(resolve(dir, base), { withFileTypes: true }).flatMap((v) =>
    v.isDirectory() ? files(base + v.name + '/') : [base + v.name],
  );
const manifest = json('manifest.json');
assert.deepEqual(
  Object.keys(manifest).sort(),
  files()
    .filter((f) => !['manifest.json', 'verification.json'].includes(f))
    .sort(),
);
for (const [f, hash] of Object.entries(manifest)) {
  const bytes = read(f);
  assert.equal(sha(bytes), hash, 'evidence bytes drift: ' + f);
  assert(
    !/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}|X-Amz-(?:Credential|Signature)=/.test(
      bytes.toString(),
    ),
    'secret-shaped evidence: ' + f,
  );
}
console.log(
  JSON.stringify(
    {
      gate: 'PASS',
      liveChecks: r.checks.length,
      localTests: 78,
      channelOrders: 2,
      certificates: 3,
      processedHeartbeats: 3,
      cleanupReadbacks: readback.checks.length,
      manifestFiles: Object.keys(manifest).length,
      scope: 'ONE_SOFTWARE_DEVICE_REAL_CSR_AND_TWO_DUAL_CHANNEL_ROTATIONS',
      physicalFirmwareAccepted: false,
      productionAccepted: false,
    },
    null,
    2,
  ),
);
