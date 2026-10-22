/** Offline reconciliation, pinned to the executed commit rather than a future working tree. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { evaluateSnapshot } from '../../../../scripts/rest-sync-evidence.mjs';
import { canonicalizeJson } from '../../../../contracts/mqtt/payload-normalization.ts';
import { scanContent } from '../../../../scripts/check-secrets.mjs';
const dir = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(dir, '../../../..');
const read = (p) => readFileSync(resolve(dir, p));
const json = (p) => JSON.parse(read(p));
const sha = (v) => createHash('sha256').update(v).digest('hex');
const r = json('attempt-1/receipt.json');
assert.equal(r.sourceCommit, 'a21008b73e23891c3c718183b38e4958d9259c5b');
assert.equal(r.gate, 'PASS');
assert.equal(r.businessGate, 'PASS');
assert.equal(r.schemaFindings.length, 0);
assert(r.checks.every((c) => c.result === 'PASS'));
assert(r.cleanup.every((c) => c.result === 'PASS'));
assert.equal(r.licenseDeviceVerification, 'NOT_RUN_NO_INDEPENDENT_DEVICE_HMAC_KEY');
assert.equal(r.physicalDevice, false);
assert.equal(r.fullQa09Accepted, false);
const local = json('local-checks.json');
assert.equal(local.sourceCommit, r.sourceCommit);
for (const [path, hash] of Object.entries(local.sourceHashes))
  assert.equal(sha(execFileSync('git', ['show', local.sourceCommit + ':' + path], { cwd: root })), hash);
assert(/Tests\s+329 passed/.test(read('local-unit.log').toString()));
assert(/ℹ pass 37\n/.test(read('local-contract.log').toString()));
assert(/Tests\s+6 passed/.test(read('deployment-template-attempt-2-pass.log').toString()));
assert(local.checks.some((c) => c.exitCode === 1 && c.log === 'deployment-template-attempt-1-fail.log'));
for (const [path, hash] of Object.entries(r.sourceHashes)) {
  const frozen = json('sources.json')[path];
  assert.equal(sha(Buffer.from(frozen.base64, 'base64')), hash);
  assert.equal(frozen.sha256, hash);
  assert.equal(scanContent(Buffer.from(frozen.base64, 'base64').toString()).length, 0);
  assert.equal(sha(execFileSync('git', ['show', r.sourceCommit + ':' + path], { cwd: root })), hash);
}
const version = json('application-version.json');
const inputs = json('deployment-inputs.json');
assert.equal(inputs.sourceCommit, r.sourceCommit);
assert.equal(inputs.runId, '39778666876');
assert.equal(inputs.gate, 'PASS');
assert.equal(inputs.fullQa09Accepted, false);
assert.equal(version.sourceCommit, r.sourceCommit);
assert.equal(version.gate, 'PASS');
assert.equal(version.github.headSha, r.sourceCommit);
assert.equal(version.github.conclusion, 'success');
assert.equal(version.ci.headSha, r.sourceCommit);
assert.equal(version.ci.conclusion, 'success');
assert(version.lambdaArtifacts.every((a) => a.matches && a.codeSha256 === a.artifactSha256));
const blockedVersion = json('application-version-attempt-1-blocked.json');
assert.equal(blockedVersion.gate, 'BLOCKED');
assert.equal(blockedVersion.lambdaArtifacts.filter((a) => !a.matches).length, 18);
assert.equal(json('version-attempt-2-interruption.json').status, 'INTERRUPTED');
assert.equal(version.artifactVerificationMode, 's3-full-object-sha256');
assert.equal(version.lambdaArtifacts.length, 19);
for (const item of version.lambdaArtifacts) {
  const before = blockedVersion.lambdaArtifacts.find((a) => a.name === item.name);
  assert.equal(item.codeSha256, before.codeSha256);
  assert.equal(item.s3Key, before.s3Key);
  assert.equal(item.sourceVersion, before.sourceVersion);
  assert.equal(item.bytesDownloadedLocally, false);
  assert.equal(item.checksumReceipt.type, 'FULL_OBJECT');
  assert.equal(item.checksumReceipt.sha256, item.codeSha256);
  assert.equal(item.checksumReceipt.versionId, item.sourceVersion);
  assert.equal(item.checksumReceipt.objectSize, item.contentLength);
}
for (const [path, frozen] of Object.entries(json('artifact-executor-sources.json'))) {
  assert.equal(sha(Buffer.from(frozen.base64, 'base64')), frozen.sha256);
  assert.equal(sha(execFileSync('git', ['show', r.sourceCommit + ':' + path], { cwd: root })), frozen.sha256);
}
assert.equal(
  version.executorSha256,
  json('artifact-executor-sources.json')['scripts/collect-qa09-application-version.mjs'].sha256,
);
assert.deepEqual(r.workersBefore, r.workersAfter);
for (const worker of r.workersBefore) {
  const deployed = version.lambdaArtifacts.find((a) => a.name === worker.Name);
  assert(deployed, 'missing deployed worker ' + worker.Name);
  assert.equal(deployed.codeSha256, worker.Hash);
}
for (const row of r.snapshots) {
  assert.equal(row.status, 200);
  assert.equal(row.schemaValid, true);
  assert.equal(row.body.operationalStatus.operationalStatus, 'Active');
  assert.equal(row.computedEtag, row.body.etag);
  assert(/^[a-f0-9]{64}$/.test(row.rawSha256));
  assert(row.requestId);
  for (const user of row.body.deviceUsers) assert.equal(user.passwordHash, '[REDACTED:device-verifier]');
}
assert.equal(r.snapshotComparisons.length, 9);
for (const compare of r.snapshotComparisons) {
  const row = r.snapshots.find((s) => s.label === compare.label);
  const state = json('attempt-1/' + compare.database).result;
  assert.deepEqual(evaluateSnapshot(row, compare.expected, state), compare.results);
  assert(Object.values(compare.results).every(Boolean));
  assert.deepEqual(row.verifierChecks, { correctPassword: true, wrongPasswordRejected: true });
}
const snap = (label) => {
  const row = r.snapshots.find((s) => s.label === label);
  assert(row, 'missing snapshot ' + label);
  return row.body;
};
assert.equal(r.finalState.latest[0].operational_status, 'Active');
assert.equal(r.legacyProbe.legacyUpdate.device_id, r.deviceId);
assert.equal(r.legacyProbe.legacyUpdate.operational_status, 'ACTIVE');
const legacyIndex = r.database.findIndex((d) => d.action === 'legacy-active');
assert(legacyIndex >= 0);
assert.equal(r.database[legacyIndex + 1].action, 'observe');
const legacyReadState = json('attempt-1/' + r.database[legacyIndex + 1].file).result;
assert.equal(legacyReadState.latest[0].device_id, r.deviceId);
assert.equal(legacyReadState.latest[0].operational_status, 'ACTIVE');
assert.equal(snap('legacy-active-sync').operationalStatus.operationalStatus, 'Active');
assert.equal(snap('legacy-active-sync').etag, snap('canonical-before-legacy').etag);
assert.equal(r.statusRestoredState.latest[0].operational_status, 'Active');
assert.equal(snap('restored-canonical-sync').etag, snap('legacy-active-sync').etag);
assert.equal(snap('same-etag-full-and-ack').etag, snap('full-model-fallback').etag);
assert.equal(snap('draft-not-effective').etag, snap('device-overrides-model').etag);
assert.notEqual(snap('new-published-version').etag, snap('draft-not-effective').etag);
assert.equal(snap('future-version-not-effective').etag, snap('new-published-version').etag);
assert.equal(snap('heartbeat-keeps-etag').etag, snap('future-version-not-effective').etag);
assert.notEqual(snap('user-new-version').etag, snap('heartbeat-keeps-etag').etag);
assert.equal(snap('license-received').operationalStatus.lifecycleStatus, 'Licensed');
assert(r.http.every((h) => h.requestBody?.licenseConfirmation?.status !== 'VERIFIED'));
const heartbeats = r.checks.filter((c) => c.puback);
assert.equal(heartbeats.length, 3);
for (const h of heartbeats) {
  assert.equal(h.payload.data.operationalStatus, 'ACTIVE');
  assert(
    r.statusRestoredState.receipts.some(
      (v) =>
        v.seq === h.payload.meta.seq && v.result === 'PROCESSED' && v.payload_hash === sha(canonicalizeJson(h.payload)),
    ),
  );
}
const cleanup = json('cleanup-readback.json');
assert.equal(cleanup.deviceId, r.deviceId);
assert.equal(cleanup.gate, 'PASS');
assert(cleanup.checks.every((c) => c.result === 'PASS'));
assert.equal(r.afterDatabaseCleanup.devices.length, 0);
assert.equal(r.afterDatabaseCleanup.certificates.length, 0);
assert.equal(r.afterDatabaseCleanup.licenses.length, 0);
assert.equal(r.afterDatabaseCleanup.deviceUsers.length, 0);
assert.equal(r.afterDatabaseCleanup.configurations.length, 0);
assert.deepEqual(r.baseline.outsideBusinessFingerprints, r.afterDatabaseCleanup.outsideBusinessFingerprints);
// Historical contract failure and every archived byte remain unchanged.
const oldDir = resolve(dir, '../rest-sync-2026-10-22');
for (const [path, hash] of Object.entries(JSON.parse(readFileSync(oldDir + '/manifest.json'))))
  assert.equal(sha(readFileSync(resolve(oldDir, path))), hash);
const old = JSON.parse(readFileSync(oldDir + '/attempt-3/receipt.json'));
assert.equal(old.gate, 'FAIL_CONTRACT');
assert.equal(old.schemaFindings.length, 12);
const files = (p = '') =>
  readdirSync(resolve(dir, p), { withFileTypes: true }).flatMap((v) =>
    v.isDirectory() ? files(p + v.name + '/') : [p + v.name],
  );
const manifest = json('manifest.json');
assert.deepEqual(
  Object.keys(manifest).sort(),
  files()
    .filter((p) => !['manifest.json', 'verification.json'].includes(p))
    .sort(),
);
for (const [path, hash] of Object.entries(manifest)) {
  const bytes = read(path);
  assert.equal(sha(bytes), hash, 'changed evidence: ' + path);
  assert.equal(scanContent(bytes.toString()).length, 0, 'secret: ' + path);
  assert(
    !/\$argon2id\$v=19\$m=32768,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}/.test(bytes.toString()),
    'unredacted PHC: ' + path,
  );
}
console.log(
  JSON.stringify(
    {
      evidenceGate: 'PASS_RECONCILED',
      liveGate: r.gate,
      wireContractGate: 'PASS',
      liveChecks: r.checks.length,
      successfulSyncs: r.snapshots.length,
      businessSnapshotsCompared: r.snapshotComparisons.length,
      cleanupGate: cleanup.gate,
      legacyReadGate: 'PASS',
      historicalContractFailurePreserved: true,
      physicalFirmwareAccepted: false,
      licenseHmacVerification: 'NOT_RUN',
      productionAccepted: false,
      artifactVerification: 'FIXED_VERSION_FULL_OBJECT_SHA256',
      finalMethodDownloadsFullZip: false,
      manifestFiles: Object.keys(manifest).length,
    },
    null,
    2,
  ),
);
