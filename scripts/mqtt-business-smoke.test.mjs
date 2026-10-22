import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateScope, execute } from './mqtt-business-fixture.mjs';
import { archiveObjectKind, buildProbePayload, evaluateBusiness, main } from './run-mqtt-business-smoke.mjs';
function scope() {
  const s = {
    deviceId: 'mqttbiz-0123456789abcdef',
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
    mediaHash: 'a'.repeat(64),
    packageHash: 'b'.repeat(64),
  };
  s.commandId = 'CMD-' + s.deviceId.toUpperCase() + '-1';
  s.mediaKey = `media/${s.customerId}/${s.deviceId}/${s.mediaSessionId}/probe.png`;
  s.packageKey = `mqtt-business/${s.deviceId}/probe.bin`;
  return s;
}
test('fixture rejects non-owned device, cross-customer media key and unscoped object before SQL', async () => {
  for (const mutate of [
    (s) => (s.deviceId = 'existing-device'),
    (s) => (s.mediaKey = 'media/other/device/file'),
    (s) => (s.packageKey = 'firmware/existing.bin'),
    (s) => (s.commandId = 'existing-command'),
  ]) {
    const s = scope();
    mutate(s);
    let queries = 0;
    await assert.rejects(
      () =>
        execute(
          {
            query() {
              queries++;
            },
          },
          'cleanup',
          s,
        ),
      /INVALID_OWN_SCOPE/,
    );
    assert.equal(queries, 0);
  }
});
test('fresh scope accepted', () => assert.equal(validateScope(scope()).deviceId, 'mqttbiz-0123456789abcdef'));
test('operator must explicitly enable cloud execution', async () => {
  const old = process.env.FDP_MQTT_BUSINESS_TEST;
  delete process.env.FDP_MQTT_BUSINESS_TEST;
  try {
    await assert.rejects(() => main('/tmp/not-run-mqtt-business.json'), /EXPLICIT_ENABLE/);
  } finally {
    if (old === undefined) delete process.env.FDP_MQTT_BUSINESS_TEST;
    else process.env.FDP_MQTT_BUSINESS_TEST = old;
  }
});
test('PUBACK and downlinks alone cannot satisfy cloud business checks', () => {
  const r = {
    scope: scope(),
    uplink: [],
    downlink: ['cmd', 'ota', 'notification'].map((type) => ({ type, schemaValid: true })),
  };
  const s = Object.fromEntries(
    [
      'receipts',
      'latest',
      'telemetry',
      'reports',
      'alarms',
      'events',
      'tampers',
      'commands',
      'acks',
      'targets',
      'otaHistory',
      'media',
      'mediaSessions',
      'attempts',
      'outbox',
    ].map((k) => [k, []]),
  );
  const checks = evaluateBusiness(s, r);
  assert.equal(checks.heartbeat, false);
  assert.equal(checks.ack, false);
  assert.equal(checks.media, false);
  assert.equal(checks['downlink-cmd'], true);
  assert(!Object.values(checks).every(Boolean));
});

test('published alarm snapshot remains unchanged when caller clears the next alarm', () => {
  const data = { code: 'MQTT_PROBE_TEMP', status: 'ACTIVE', currentValue: 88 };
  const first = buildProbePayload('alarm', data, 'mqttbiz-0123456789abcdef', 1);
  data.status = 'CLEARED';
  data.currentValue = 72;
  const second = buildProbePayload('alarm', data, 'mqttbiz-0123456789abcdef', 2);
  assert.equal(first.data.status, 'ACTIVE');
  assert.equal(first.data.currentValue, 88);
  assert.equal(second.data.status, 'CLEARED');
  assert.equal(first.meta.seq, 1);
  assert.equal(second.meta.seq, 2);
});

test('cleanup preserves append-only audits and closes their customer parent', async () => {
  const queries = [],
    s = scope();
  const client = {
    async query(sql) {
      queries.push(sql);
      return { rows: sql.startsWith('SELECT id FROM customers') ? [{ id: s.customerId }] : [], rowCount: 0 };
    },
  };
  const result = await execute(client, 'cleanup', s);
  assert.equal(result.auditLogsPreserved, true);
  assert.equal(result.auditCustomerTombstoneRetained, true);
  assert(queries.some((sql) => sql.startsWith('UPDATE customers SET')));
  assert(!queries.some((sql) => /^DELETE FROM (customers|audit_logs)/.test(sql)));
});

test('archive reader separates JSON manifests from gzip data objects', () => {
  assert.equal(archiveObjectKind('raw/part-1.manifest.json'), 'manifest');
  assert.equal(archiveObjectKind('raw/part-1.json.gz'), 'gzip');
  assert.throws(() => archiveObjectKind('raw/unknown.bin'), /UNKNOWN_ARCHIVE_OBJECT_KIND/);
});
