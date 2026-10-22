import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { publicSnapshot, snapshotEtag, evaluateSnapshot, ownArchivePrefix } from './rest-sync-evidence.mjs';
import { validateScope, execute } from './rest-sync-fixture.mjs';
import { main } from './run-rest-sync-smoke.mjs';
import { deviceContract } from '../contracts/testing/device-contract.ts';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const serial = 'syncprobe-0123456789abcdef',
  scope = {
    serial,
    username: serial + '@example.invalid',
    model: 'SYNC-0123456789ABCDEF',
    names: [serial + '-a', serial + '-b'],
  };
const phc =
  '$argon2id$v=19$m=32768,t=3,p=1$' +
  Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '') +
  '$' +
  Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '');
function facts() {
  const s = {
    deviceId: 'd',
    assignment: {
      assignmentId: 'a',
      customerId: 'c',
      customerName: 'customer',
      siteId: 'site',
      siteName: 'site',
      region: 'APAC',
      subregion: 'SG',
      assignedAt: '2026-10-22T00:00:00.000Z',
      endedAt: null,
    },
    device: { deviceId: 'd', serialNumber: serial, model: scope.model, alias: 'alias', firmwareVersion: null },
    license: {
      licenseId: 'l',
      status: 'ACTIVE',
      version: 3,
      effective: true,
      validFrom: '2026-10-21',
      validTo: '2026-11-22',
      signature: 'v1.' + 'a'.repeat(43),
      entitlements: ['REMOTE_CONTROL', 'OTA', 'ESG_REPORTING'],
      signaturePayload: {
        licenseId: 'l',
        deviceId: 'd',
        customerId: 'c',
        validFrom: '2026-10-21T00:00:00.000Z',
        validTo: '2026-11-22T00:00:00.000Z',
        entitlements: ['ESG_REPORTING', 'OTA', 'REMOTE_CONTROL'],
      },
    },
    deviceUsers: [{ userId: 'u', username: 'operator', displayName: 'Operator', status: 'ACTIVE', passwordHash: phc }],
    configuration: {
      heartbeatInterval: 45,
      telemetryInterval: 15,
      cameraRefreshInterval: 3,
      temperatureThreshold: 74.5,
    },
    operationalStatus: {
      lifecycleStatus: 'Assigned',
      operationalStatus: 'ACTIVE',
      lastHeartbeatAt: '2026-10-22T00:00:01.000Z',
      connectivity: 'ONLINE',
      syncIntervalSeconds: 300,
    },
  };
  s.etag = snapshotEtag(s);
  const expected = {
    deviceId: 'd',
    serial,
    model: scope.model,
    alias: 'alias',
    customerId: 'c',
    customerName: 'customer',
    siteId: 'site',
    siteName: 'site',
    region: 'APAC',
    subregion: 'SG',
    licenseId: 'l',
    userId: 'u',
    displayName: 'Operator',
    lifecycle: 'Assigned',
    configuration: s.configuration,
  };
  const state = {
    devices: [{ id: 'd', lifecycle_status: 'Assigned', firmware_version: null }],
    assignments: [
      {
        id: 'a',
        customer_id: 'c',
        site_id: 'site',
        status: 'ACTIVE',
        assigned_at: s.assignment.assignedAt,
        ended_at: null,
      },
    ],
    licenses: [
      {
        id: 'l',
        status: 'Active',
        version: 3,
        valid_from: s.license.signaturePayload.validFrom,
        valid_to: s.license.signaturePayload.validTo,
        signature: s.license.signature,
      },
    ],
    entitlements: ['REMOTE_CONTROL', 'OTA_UPDATE', 'ESG_REPORTING'].map((code) => ({
      license_id: 'l',
      code,
      enabled: true,
    })),
    deviceUsers: [{ id: 'u', customer_id: 'c', status: 'ACTIVE', argon2id: true, password_hash_sha256: sha(phc) }],
    userAssignments: [{ device_user_id: 'u', device_id: 'd', status: 'ACTIVE' }],
    latest: [{ operational_status: 'ACTIVE', last_heartbeat_at: s.operationalStatus.lastHeartbeatAt }],
  };
  return { s, expected, state };
}
test('requires explicit live opt-in before creating output/resources', async () => {
  const old = process.env.FDP_REST_SYNC_TEST;
  delete process.env.FDP_REST_SYNC_TEST;
  try {
    await assert.rejects(main('/tmp/not-a-live-sync.json'), /EXPLICIT_ENABLE/);
  } finally {
    if (old !== undefined) process.env.FDP_REST_SYNC_TEST = old;
  }
});
test('observer/cleanup rejects broad names, foreign model and setup writes before SQL', async () => {
  const client = {
    query() {
      throw Error('SQL_MUST_NOT_RUN');
    },
  };
  assert.deepEqual(validateScope(scope), scope);
  for (const bad of [
    { ...scope, serial: 'production' },
    { ...scope, model: 'BNX-100' },
    { ...scope, names: ['foreign', 'tenant'] },
    { ...scope, username: 'other@example.invalid' },
  ])
    await assert.rejects(execute(client, 'cleanup', bad), /INVALID_OWN_SYNC_SCOPE/);
  await assert.rejects(execute(client, 'seed', scope), /INVALID_ACTION/);
});
test('cleanup stops when own serial is assigned to an unrelated parent', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      return {
        rows: sql.startsWith('SELECT id,serial_number')
          ? [{ id: 'd', model: scope.model, customer_id: 'foreign', site_id: null }]
          : [],
      };
    },
  };
  await assert.rejects(execute(client, 'cleanup', scope), /OWN_DEVICE_SCOPE_DRIFT/);
  assert(!calls.some((s) => /^(DELETE|INSERT|UPDATE)/.test(s)));
  assert.equal(calls.at(-1), 'ROLLBACK');
});
test('public snapshot redacts verifier, records DEC-004 parameters, preserves original data', () => {
  const { s } = facts(),
    v = publicSnapshot(s);
  assert.equal(s.deviceUsers[0].passwordHash, phc);
  assert(!JSON.stringify(v).includes(phc));
  assert.equal(v.verifierDigests[0].sha256, sha(phc));
  assert.equal(v.verifierDigests[0].saltBytes, 16);
  assert.equal(v.verifierDigests[0].hashBytes, 32);
  assert.equal(v.computedEtag, s.etag);
});
test('reject malformed KDF/length before publishing evidence', () => {
  for (const value of [
    phc.replace('m=32768', 'm=8192'),
    phc.replace(Buffer.alloc(16, 1).toString('base64').replace(/=+$/, ''), 'short'),
    null,
  ]) {
    const { s } = facts();
    s.deviceUsers[0].passwordHash = value;
    assert.throws(() => publicSnapshot(s), /INVALID_/);
  }
});
test('stable ETag ignores volatile fields and changes for each stable domain', () => {
  const { s } = facts(),
    etag = s.etag;
  const volatile = structuredClone(s);
  volatile.snapshotAt = 'later';
  volatile.lastSyncTime = 'last';
  Object.assign(volatile.operationalStatus, { connectivity: 'OFFLINE', lastHeartbeatAt: 'later' });
  assert.equal(snapshotEtag(volatile), etag);
  for (const mutate of [
    (x) => (x.assignment.siteName = 'new'),
    (x) => (x.device.alias = 'new'),
    (x) => x.license.version++,
    (x) => (x.deviceUsers[0].displayName = 'new'),
    (x) => x.configuration.temperatureThreshold++,
    (x) => (x.operationalStatus.lifecycleStatus = 'Licensed'),
  ]) {
    const copy = structuredClone(s);
    mutate(copy);
    assert.notEqual(snapshotEtag(copy), etag);
  }
});
test('full snapshot comparison detects tenant, license, config, filtered-user and receipt-hash drift', () => {
  const { s, expected, state } = facts(),
    row = { ...publicSnapshot(s), schemaValid: true };
  assert(Object.values(evaluateSnapshot(row, expected, state)).every(Boolean));
  for (const mutate of [
    (x) => (x.body.assignment.customerId = 'other'),
    (x) => (x.body.license.signature = 'invalid'),
    (x) => (x.body.license.signaturePayload.customerId = 'other'),
    (x) => x.body.configuration.temperatureThreshold++,
    (x) => x.body.deviceUsers.push({ ...x.body.deviceUsers[0], userId: 'foreign' }),
    (x) => (x.verifierDigests[0].sha256 = 'wrong'),
    (x) => (x.schemaValid = false),
  ]) {
    const bad = structuredClone(row);
    mutate(bad);
    assert(Object.values(evaluateSnapshot(bad, expected, state)).some((v) => !v));
  }
});
test('archive prefix needs a precise customer id', () => {
  assert.throws(() => ownArchivePrefix(''), /INVALID_OWN_CUSTOMER/);
  assert.equal(
    ownArchivePrefix('12345678-1234-1234-1234-123456789abc'),
    'domain/entity_type=license/customer_id=12345678-1234-1234-1234-123456789abc/',
  );
});

test('wire contract rejects uppercase MQTT status in REST and accepts title case REST value', () => {
  const { s } = facts();
  assert.throws(() => deviceContract.assertResponse('syncDevice', { status: 200, body: s }), /operationalStatus/);
  s.operationalStatus.operationalStatus = 'Active';
  assert.doesNotThrow(() => deviceContract.assertResponse('syncDevice', { status: 200, body: s }));
});

test('JSON field ordering does not change configuration equality', () => {
  const { s, expected, state } = facts();
  const row = { ...publicSnapshot(s), schemaValid: true };
  row.body.configuration = Object.fromEntries(Object.entries(row.body.configuration).reverse());
  assert.equal(evaluateSnapshot(row, expected, state).configuration, true);
});
test('parent closure refuses to run while an owned device remains', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      return {
        rows: sql.startsWith('SELECT id,serial_number')
          ? [{ id: 'own', model: scope.model, customer_id: null, site_id: null }]
          : sql.includes('count(*)::int AS n')
            ? [{ n: 0 }]
            : [],
      };
    },
  };
  await assert.rejects(execute(client, 'close-parents', scope), /OWN_CHILDREN_REMAIN/);
  assert(!calls.some((s) => /^(DELETE|INSERT|UPDATE)/.test(s)));
  assert.equal(calls.at(-1), 'ROLLBACK');
});
