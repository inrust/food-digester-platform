/** Run from repository root: node --import tsx docs/audit/evidence/mqtt-business-2026-10-22/verify.mjs */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { canonicalizeJson, verifyAuditHash } from '../../../../contracts/mqtt/payload-normalization.ts';
import { SchemaRegistry, validate } from '../../../../contracts/mqtt/validator.mjs';
import { scanContent } from '../../../../scripts/check-secrets.mjs';
const base = dirname(new URL(import.meta.url).pathname),
  sha = (x) => createHash('sha256').update(x).digest('hex');
const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const r = json(base + '/attempt-4/result.json');
assert.equal(r.gate, 'PASS');
assert.equal(r.cleanupGate, 'PASS');
assert(Object.values(r.checks).every(Boolean));
assert.equal(r.mode, 'OWN_FIXTURES_IN_SHARED_TEST_ENVIRONMENT');
assert.equal(r.physicalDevice, false);
assert.equal(r.projectCaOnboarding, false);
assert.equal(r.firmwareInstall, false);
assert.equal(r.privateKeysPersisted, false);
assert.equal(r.uplink.length, 12);
assert.equal(new Set(r.uplink.map((m) => m.type)).size, 8);
assert.equal(new Set(r.downlink.map((m) => m.type)).size, 3);
assert.equal(r.downlink.length, 4);
assert.equal(r.finalState.receipts.length, 12);
const schemas = new SchemaRegistry(resolve('contracts/mqtt/schemas'));
for (const m of r.uplink) {
  const f = m.type + '.schema.json';
  assert.deepEqual(validate(schemas.load(f).doc, f, m.payload, schemas), []);
  assert.equal(m.puback, true);
  assert.equal(sha(JSON.stringify(m.payload)), m.rawSha256);
  if (m.payload.audit) assert(verifyAuditHash(m.payload));
  const row = r.finalState.receipts.find((v) => v.topic_type === m.type && v.seq === m.payload.meta.seq);
  assert(row);
  assert.equal(row.device_id, r.scope.deviceId);
  assert.equal(row.customer_id, r.scope.customerId);
  assert.equal(row.site_id, r.scope.siteId);
  assert.equal(row.payload_hash, sha(canonicalizeJson(m.payload)));
  assert.equal(row.result, 'PROCESSED');
}
const telemetry = r.uplink.find((m) => m.type === 'telemetry').payload.data;
assert.equal(Object.keys(telemetry).length, 13);
for (const [key, value] of Object.entries(telemetry)) {
  const metric = r.finalState.telemetry[0].metrics[key];
  assert.equal(metric.avg, value);
  assert.equal(metric.min, value);
  assert.equal(metric.max, value);
  assert.equal(metric.count, 1);
}
assert.equal(r.finalState.telemetry[0].sample_count, 1);
for (const m of r.downlink) {
  const f = m.type + '.schema.json';
  assert.deepEqual(validate(schemas.load(f).doc, f, m.payload, schemas), []);
  assert.equal(m.topic, `bnx/device/${r.scope.deviceId}/${m.type}`);
  if (m.type === 'ota') assert.equal(new URL(m.payload.data.downloadUrl).searchParams.get('token'), 'REDACTED');
}
assert.equal(r.finalState.commands[0].status, 'SUCCEEDED');
assert.equal(r.finalState.targets[0].status, 'SUCCEEDED');
assert.deepEqual(
  r.finalState.otaHistory.map((h) => h.to_status),
  ['NOTIFIED', 'DOWNLOADING', 'INSTALLING', 'SUCCEEDED'],
);
assert.equal(r.finalState.media[0].sha256, r.scope.mediaHash);
assert.equal(r.finalState.mediaSessions[0].status, 'COMPLETED');
assert.equal(r.archives.length, 11);
assert.equal(r.archiveManifests.length, 11);
const events = new Set();
let rawRecords = 0;
for (const [index, obj] of r.archives.entries()) {
  const bytes = readFileSync(base + `/attempt-4/archive-${index}.json.gz`);
  assert.equal(sha(bytes), obj.sha256);
  const lines = gunzipSync(bytes).toString().trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, obj.records);
  const manifest = r.archiveManifests.find((m) => m.archiveKey === obj.key);
  assert(manifest);
  assert.equal(manifest.archiveSha256, obj.sha256);
  assert.equal(manifest.recordCount, obj.records);
  for (const line of lines) {
    assert.equal(line.deviceId, r.scope.deviceId);
    assert.equal(line.customerId, r.scope.customerId);
    events.add(line.eventId);
    if (line.rawBody) {
      const body = JSON.parse(line.rawBody);
      assert.equal(body.iotDeviceId, r.scope.deviceId);
      const payload = Object.fromEntries(
        Object.entries(body).filter(
          ([k]) => !['iotTopic', 'iotDeviceId', 'iotType', 'iotReceivedAt', 'iotPrincipal'].includes(k),
        ),
      );
      const message = r.uplink.find((m) => m.payload.meta.id === payload.meta.id);
      assert(message);
      assert.equal(sha(canonicalizeJson(payload)), sha(canonicalizeJson(message.payload)));
      rawRecords++;
    }
  }
}
assert.equal(rawRecords, 7);
assert.equal(events.size, 11);
assert(r.archiveCheck.expectedEventIds.every((id) => events.has(id)));
assert(r.cleanup.every((c) => c.status === 'PASS'));
assert.equal(r.afterCleanup.devices.length, 0);
assert.equal(r.afterCleanup.receipts.length, 0);
assert.equal(r.afterCleanup.outbox.length, 0);
assert.equal(r.afterCleanup.auditCustomerTombstone[0].status, 'SUSPENDED');
assert(r.afterCleanup.auditCustomerTombstone[0].deleted_at);
assert(r.afterCleanup.audits.length > 0);
assert.equal(json(base + '/cleanup-readback.json').allRuntimeResourcesAbsent, true);
for (const n of [1, 2, 3]) assert.equal(json(base + `/attempt-${n}/result.json`).gate, 'FAIL');
assert.equal(json(base + '/attempt-2/recovery/result.json').gate, 'PASS');
const sources = json(base + '/sources.json');
for (const [p, h] of Object.entries(sources.files)) assert.equal(sha(readFileSync(p)), h);
for (const [p, h] of Object.entries(r.sourceHashes)) assert.equal(sources.files[p], h);
const integrity = json(base + '/manifest.json');
for (const item of integrity.files) assert.equal(sha(readFileSync(resolve(base, item.path))), item.sha256, item.path);
let sensitiveFiles = 0;
for (const f of integrity.files) {
  if (f.path.endsWith('.gz')) continue;
  const text = readFileSync(resolve(base, f.path), 'utf8');
  assert.deepEqual(scanContent(text), [], f.path);
  sensitiveFiles++;
}
let links = 0;
for (const path of [
  'docs/audit/2026-10-22-mqtt-business-live-test.md',
  'docs/api/iot.bio-nexa.com.md',
  'docs/api/README.md',
  'docs/api/mqtt-message-examples.md',
]) {
  const text = readFileSync(path, 'utf8');
  for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith('#')) continue;
    assert(existsSync(resolve(dirname(path), decodeURIComponent(target.split('#')[0]))), path + ':' + target);
    links++;
  }
}
const log = readFileSync(base + '/local-checks.log', 'utf8');
assert(log.includes('tests 79') && log.includes('pass 79') && log.includes('fail 0'));
console.log(
  JSON.stringify(
    {
      gate: 'PASS_SCOPED_MQTT_BUSINESS_WITH_OWN_FIXTURES',
      uplinkTypes: 8,
      publishedMessages: 12,
      processedReceipts: 12,
      downlinkTypes: 3,
      receivedDownlinkMessages: 4,
      telemetryMetricsVerified: 13,
      archiveObjects: 11,
      archiveManifests: 11,
      rawRecordsMatched: rawRecords,
      allEventIdsMatched: true,
      sourceHashes: 'PASS',
      integrityFiles: integrity.files.length,
      sensitiveFilesChecked: sensitiveFiles,
      localLinksChecked: links,
      localTestsPassed: 79,
      activeCloudResourcesRemoved: true,
      auditRecordsAndSoftDeletedCustomersRetained: true,
      physicalDeviceAccepted: false,
      projectCaOnboardingAccepted: false,
      firmwareInstallationAccepted: false,
      fullQa09Accepted: false,
      productionAccepted: false,
    },
    null,
    2,
  ),
);
