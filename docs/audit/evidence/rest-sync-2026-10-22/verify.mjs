/** Offline reconciliation: a checked contract failure must remain a failure. No AWS requests. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, X509Certificate } from 'node:crypto';
import { evaluateSnapshot } from '../../../../scripts/rest-sync-evidence.mjs';
import { canonicalizeJson } from '../../../../contracts/mqtt/payload-normalization.ts';
import { scanContent } from '../../../../scripts/check-secrets.mjs';
const dir = fileURLToPath(new URL('.', import.meta.url)),
  root = resolve(dir, '../../../..');
const read = (f) => readFileSync(resolve(dir, f)),
  json = (f) => JSON.parse(read(f)),
  sha = (v) => createHash('sha256').update(v).digest('hex');
const a = json('attempt-1/receipt.json'),
  b = json('attempt-2/receipt.json'),
  r = json('attempt-3/receipt.json'),
  recovery = json('attempt-2/recovery.json');
assert.equal(a.gate, 'FAIL');
assert.equal(a.checks.length, 1);
assert.equal(a.cleanup.length, 0);
assert(!a.fixture && !a.identity && !a.deviceId);
assert.equal(a.failure.message, 'events:describe-rule:FAILED');
assert.equal(b.gate, 'FAIL');
assert.equal(b.failure.message, 'ASSERT_full-model-fallback-all-six-domains-match');
assert.deepEqual(b.snapshots.at(-1).body.configuration, b.snapshotComparisons.at(-1).expected.configuration);
assert.equal(b.snapshotComparisons.at(-1).results.configuration, false);
assert.notEqual(
  JSON.stringify(b.snapshots.at(-1).body.configuration),
  JSON.stringify(b.snapshotComparisons.at(-1).expected.configuration),
);
assert(
  b.cleanup.some(
    (c) =>
      c.label === 'owned-iot-and-database' && c.result === 'FAIL' && c.error === 'ACTIVE_JOB_OR_OUTBOX_CLEANUP_HELD',
  ),
);
assert.equal(recovery.gate, 'PASS');
assert(recovery.observerRemoved);
assert.equal(recovery.parents, 4);
assert.equal(recovery.after.devices.length, 0);
assert(recovery.after.customers.every((c) => c.deleted_at) && recovery.after.sites.every((s) => s.deleted_at));
assert.deepEqual(recovery.after.outsideFingerprints, b.baseline.outsideFingerprints);
assert.deepEqual(recovery.after.outsideBusinessFingerprints, b.baseline.outsideBusinessFingerprints);
assert.equal(recovery.parentSha256, sha(read('attempt-2/receipt.json')));
for (const [name, receipt] of [
  ['attempt-1', a],
  ['attempt-2', b],
  ['attempt-3', r],
]) {
  const sources = json(name + '/sources.json');
  for (const [path, hash] of Object.entries(receipt.sourceHashes)) {
    assert.equal(sources[path].sha256, hash);
    const bytes = Buffer.from(sources[path].base64, 'base64');
    assert.equal(sha(bytes), hash);
    assert.equal(scanContent(bytes.toString()).length, 0, 'source secret: ' + path);
    if (name === 'attempt-3')
      assert.equal(sha(readFileSync(resolve(root, path))), hash, 'current source drift: ' + path);
  }
}
for (const [p, v] of Object.entries(json('local-sources.json'))) {
  assert.equal(sha(Buffer.from(v.base64, 'base64')), v.sha256);
  assert.equal(sha(readFileSync(resolve(root, p))), v.sha256);
}
const rs = json('attempt-2/recovery-sources.json');
for (const [p, h] of Object.entries(recovery.sourceHashes)) {
  assert.equal(rs[p].sha256, h);
  assert.equal(sha(Buffer.from(rs[p].base64, 'base64')), h);
}
assert.equal(r.mode, 'REAL_ASSIGNED_REST_SYNC_NO_DB_SEED');
assert.equal(r.target.account, '065986019555');
assert.equal(r.target.region, 'ap-southeast-1');
assert.equal(r.gate, 'FAIL_CONTRACT');
assert.equal(r.businessGate, 'PASS');
assert.equal(r.licenseDeviceVerification, 'NOT_RUN_NO_INDEPENDENT_DEVICE_HMAC_KEY');
assert.equal(r.physicalDevice, false);
assert.equal(r.fullQa09Accepted, false);
assert(r.schemaFindings.length > 0);
const failed = r.checks.filter((c) => c.result === 'FAIL');
assert.equal(failed.length, r.schemaFindings.length);
assert(failed.every((c) => c.id.endsWith('-http-schema')));
assert(r.checks.filter((c) => !c.id.endsWith('-http-schema')).every((c) => c.result === 'PASS'));
for (const row of r.snapshots) {
  assert.equal(row.status, 200);
  assert.equal(row.schemaValid, false);
  assert.equal(row.body.operationalStatus.operationalStatus, 'ACTIVE');
  assert(row.schemaError.includes('data/operationalStatus/operationalStatus'));
  assert(!row.schemaError.includes('data/license') && !row.schemaError.includes('data/deviceUsers'));
  assert.equal(row.computedEtag, row.body.etag);
  assert(/^[a-f0-9]{64}$/.test(row.rawSha256));
  assert(row.requestId);
  for (const u of row.body.deviceUsers) assert.equal(u.passwordHash, '[REDACTED:device-verifier]');
}
assert.deepEqual(r.workersBefore, r.workersAfter);
assert.equal(r.customers.length, 2);
assert.equal(r.sites.length, 2);
assert.equal(r.deviceUsers.length, 4);
assert.equal(r.configurations.length, 2);
assert.equal(r.snapshotComparisons.length, 9);
for (const compare of r.snapshotComparisons) {
  const row = r.snapshots.find((s) => s.label === compare.label),
    state = json('attempt-3/' + compare.database).result;
  assert(row);
  const evaluated = evaluateSnapshot(row, compare.expected, state);
  assert.deepEqual(evaluated, compare.results);
  assert.equal(evaluated.schema, false);
  assert(
    Object.entries(evaluated)
      .filter(([k]) => k !== 'schema')
      .every(([, v]) => v),
  );
  assert.deepEqual(row.verifierChecks, { correctPassword: true, wrongPasswordRejected: true });
}
const snap = (label) => {
  const s = r.snapshots.find((s) => s.label === label);
  assert(s, 'missing snapshot ' + label);
  return s;
};
assert.equal(snap('initial-rest-sync').body.assignment, null);
assert.equal(snap('initial-rest-sync').body.license, null);
assert.equal(snap('same-etag-full-and-ack').body.etag, snap('full-model-fallback').body.etag);
assert.equal(snap('same-etag-full-and-ack').body.lastSyncTime, snap('full-model-fallback').body.snapshotAt);
assert.notEqual(snap('device-overrides-model').body.etag, snap('license-received').body.etag);
assert.equal(snap('draft-not-effective').body.etag, snap('device-overrides-model').body.etag);
assert.notEqual(snap('new-published-version').body.etag, snap('draft-not-effective').body.etag);
assert.equal(snap('future-version-not-effective').body.etag, snap('new-published-version').body.etag);
assert.equal(snap('heartbeat-keeps-etag').body.etag, snap('future-version-not-effective').body.etag);
assert.notEqual(
  snap('heartbeat-keeps-etag').body.operationalStatus.lastHeartbeatAt,
  snap('future-version-not-effective').body.operationalStatus.lastHeartbeatAt,
);
assert.notEqual(snap('user-new-version').body.etag, snap('heartbeat-keeps-etag').body.etag);
assert.notEqual(
  snap('user-new-version').verifierDigests[0].sha256,
  snap('heartbeat-keeps-etag').verifierDigests[0].sha256,
);
assert.equal(snap('final-complete-acknowledged').body.etag, snap('user-new-version').body.etag);
const st = r.finalState;
assert.equal(st.devices[0].lifecycle_status, 'Licensed');
assert.equal(st.licenses[0].status, 'Active');
assert.equal(st.userAssignments.length, 2);
assert.equal(st.deviceUsers.length, 4);
assert.equal(st.syncReceipts.length, 2);
assert(st.syncReceipts.every((s) => s.acknowledged_at));
assert.deepEqual(st.syncReceipts.map((s) => s.entity_version).sort(), [2, 3]);
assert.equal(st.audits.filter((a) => a.action === 'device.license.received' && a.result === 'SUCCESS').length, 1);
assert.equal(st.audits.filter((a) => a.action === 'device.license.verified').length, 0);
assert(st.history.some((h) => h.from_status === 'Assigned' && h.to_status === 'Licensed'));
assert(!st.history.some((h) => h.to_status === 'Active'));
assert.equal(st.versions.length, 4);
assert(st.versions.every((v) => v.status === 'PUBLISHED'));
assert.equal(st.outbox.filter((o) => o.event_type === 'ARCHIVE').length, 3);
assert(st.outbox.every((o) => o.status === 'PUBLISHED'));
const http = (label) => {
  const v = r.http.find((h) => h.label === label);
  assert(v?.requestId);
  return v;
};
assert.equal(http('cross-customer-site-denied').status, 400);
assert.equal(http('foreign-user-assignment-denied').status, 409);
assert.equal(http('unknown-field-rejected').status, 400);
const finalUser = http('final-user-sync-state').body.data;
assert(
  finalUser.syncStates.some(
    (s) =>
      s.deviceId === r.deviceId &&
      s.deliveredEntityVersion === 3 &&
      s.snapshotStatus === 'ACKNOWLEDGED' &&
      s.deviceApplyStatus === 'NOT_REPORTED',
  ),
);
assert(r.http.every((h) => h.requestBody?.licenseConfirmation?.status !== 'VERIFIED'));
const heartbeats = r.checks.filter((c) => c.puback);
assert.equal(heartbeats.length, 2);
assert.equal(st.receipts.length, 2);
for (const h of heartbeats) {
  assert(
    st.receipts.some(
      (v) =>
        v.seq === h.payload.meta.seq && v.result === 'PROCESSED' && v.payload_hash === sha(canonicalizeJson(h.payload)),
    ),
  );
}
const cert = new X509Certificate(read('attempt-3/initial-certificate.pem'));
assert.equal(cert.subject, 'CN=' + r.deviceId);
assert.equal(sha(cert.raw), r.certificates[0].fingerprint);
assert.equal(st.certificates[0].status, 'ACTIVE');
assert(
  st.certificates[0].mqtt_verified_at && st.certificates[0].rest_verified_at && st.certificates[0].package_destroyed,
);
assert.equal(r.cleanup.length, 4);
assert(r.cleanup.every((c) => c.result === 'PASS'));
assert.equal(r.cleanupState.devices.length, 0);
assert.equal(r.cleanupState.deviceUsers.length, 0);
assert.equal(r.cleanupState.licenses.length, 0);
assert.equal(r.cleanupState.configurations.length, 0);
assert(r.cleanupState.customers.every((c) => c.deleted_at) && r.cleanupState.sites.every((s) => s.deleted_at));
assert.equal(r.archiveCleanup.length, 2);
for (const c of r.archiveCleanup)
  assert(!c.after.IsTruncated && !(c.after.Versions ?? []).length && !(c.after.DeleteMarkers ?? []).length);
for (const row of r.database) {
  const data = json('attempt-3/' + row.file);
  assert(!data.error && data.scope === r.scope.serial);
  assert.deepEqual(data.result.outsideFingerprints, r.baseline.outsideFingerprints);
  assert.deepEqual(data.result.outsideBusinessFingerprints, r.baseline.outsideBusinessFingerprints);
}
assert.equal(json('cleanup-readback.json').gate, 'PASS');
assert.equal(json('cleanup-readback.json').checks.length, 14);
assert(json('cleanup-readback.json').checks.every((c) => c.result === 'PASS'));
const manifest = json('manifest.json'),
  files = (p = '') =>
    readdirSync(resolve(dir, p), { withFileTypes: true }).flatMap((v) =>
      v.isDirectory() ? files(p + v.name + '/') : [p + v.name],
    );
assert.deepEqual(
  Object.keys(manifest).sort(),
  files()
    .filter((f) => !['manifest.json', 'verification.json'].includes(f))
    .sort(),
);
for (const [f, h] of Object.entries(manifest)) {
  const bytes = read(f),
    raw = bytes.toString();
  assert.equal(sha(bytes), h, 'changed evidence: ' + f);
  assert.equal(scanContent(raw).length, 0, 'secret evidence: ' + f);
  assert(!/\$argon2id\$v=19\$m=32768,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}/.test(raw), 'unredacted PHC: ' + f);
}
const localTests = Number(
  read('local-tests.log')
    .toString()
    .match(/ℹ tests (\d+)/)?.[1],
);
assert(localTests >= 36);
assert(/ℹ fail 0\n/.test(read('local-tests.log').toString()));
console.log(
  JSON.stringify(
    {
      evidenceGate: 'PASS_RECONCILED',
      liveGate: r.gate,
      businessDataGate: r.businessGate,
      wireContractGate: 'FAIL',
      schemaFailures: r.schemaFindings.length,
      liveChecks: r.checks.length,
      livePass: r.checks.length - failed.length,
      fullSnapshotsCompared: r.snapshotComparisons.length,
      localTests,
      failedAttemptsPreserved: 2,
      recoveryGate: recovery.gate,
      cleanupGate: 'PASS',
      physicalFirmwareAccepted: false,
      deviceLicenseHmacVerification: 'NOT_RUN',
      productionAccepted: false,
      manifestFiles: Object.keys(manifest).length,
    },
    null,
    2,
  ),
);
