import { contractHandler } from '../../../contracts/testing/device-contract.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test, assert } from 'vitest';
import { certificateFingerprintFromPem } from '@fdp/auth';
import { createTestDb } from './helpers.js';
import { createDeviceSyncHandler } from '../src/device/sync-handler.js';
import { type DeviceSyncSnapshot, parseSyncRequest } from '../src/device/sync.js';
import { signLicensePayload } from '../src/admin/license/service.js';
import { createAdminLicenseHandlers } from '../src/admin/license/handler.js';
const NOW = new Date('2026-10-04T10:00:00.123Z');
let clock = NOW;
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 60000);
afterAll(async () => {
  await db.prisma.$disconnect();
  await db.pg.close();
});
const KEY = 'local-only-license-verifier-key';
async function fixture() {
  clock = NOW;
  const id = randomUUID();
  const customer = await db.prisma.customer.create({ data: { name: id } });
  const site = await db.prisma.site.create({ data: { customerId: customer.id, name: id } });
  const device = await db.prisma.device.create({
    data: {
      id,
      serialNumber: id,
      model: 'BNX-100',
      hardwareVersion: '1',
      manufacturer: 'test',
      manufactureDate: NOW,
      lifecycleStatus: 'Assigned',
      customerId: customer.id,
      siteId: site.id,
    },
  });
  await db.prisma.deviceAssignment.create({
    data: {
      deviceId: id,
      customerId: customer.id,
      siteId: site.id,
      status: 'ACTIVE',
      assignedBy: 'test',
      assignedAt: new Date(NOW.getTime() - 60000),
    },
  });
  const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(id).toString('base64')}\n-----END CERTIFICATE-----`;
  const certificate = await db.prisma.deviceCertificate.create({
    data: {
      id: randomUUID(),
      deviceId: id,
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      notBefore: new Date(NOW.getTime() - 60000),
      notAfter: new Date(NOW.getTime() + 7 * 86400000),
    },
  });
  const license = await db.prisma.license.create({
    data: {
      deviceId: id,
      customerId: customer.id,
      status: 'Issued',
      validFrom: new Date(NOW.getTime() - 12345),
      validTo: new Date(NOW.getTime() + 7 * 86400000),
      createdBy: 'test',
      entitlements: { create: [{ code: 'REMOTE_CONTROL', enabled: true }] },
    },
  });
  const payload = {
    licenseId: license.id,
    deviceId: id,
    customerId: customer.id,
    validFrom: license.validFrom,
    validTo: license.validTo,
    entitlements: ['REMOTE_CONTROL'],
  };
  await db.prisma.license.update({ where: { id: license.id }, data: { signature: signLicensePayload(KEY, payload) } });
  const call = (body?: unknown) =>
    contractHandler(
      'syncDevice',
      createDeviceSyncHandler({ client: db.prisma, now: () => clock, maintenanceSyncIntervalSeconds: 900 }),
    )({
      identity: { clientCertPem: pem },
      body,
      requestId: randomUUID(),
    });
  const serve = async () => {
    const response = await call();
    assert.equal(response.status, 200);
    await response.onCommitted?.();
    return response.body as DeviceSyncSnapshot;
  };
  const confirm = (snapshot: DeviceSyncSnapshot, status: 'RECEIVED' | 'VERIFIED') =>
    call({
      licenseConfirmation: {
        licenseId: license.id,
        version: snapshot.license!.version,
        snapshotEtag: snapshot.etag,
        status,
      },
    });
  return { device, license, certificate, call, serve, confirm };
}

const admin = {
  actorId: 'cloud-admin',
  username: 'cloud-admin',
  actorType: 'platform' as const,
  roles: ['PlatformSuperAdmin'] as const,
  customerId: null,
  tokenUse: 'access' as const,
};
const activate = (licenseId: string) =>
  createAdminLicenseHandlers({
    client: db.prisma,
    signingKey: KEY,
    now: () => clock,
  }).activate({
    actor: { ...admin, roles: [...admin.roles] },
    params: { licenseId },
    headers: {},
    requestId: randomUUID(),
  });
async function lifecycle(deviceId: string) {
  return (await db.prisma.device.findUniqueOrThrow({ where: { id: deviceId } })).lifecycleStatus;
}
async function activeLicense(f: Awaited<ReturnType<typeof fixture>>, status = 'Active') {
  await db.prisma.license.update({ where: { id: f.license.id }, data: { status } });
}

test('administrator License activation commits device activation, operational state, audit and notification together', async () => {
  const f = await fixture();
  assert.equal((await activate(f.license.id)).status, 200);
  assert.equal(await lifecycle(f.device.id), 'Active');
  assert.equal((await f.serve()).operationalStatus.lifecycleStatus, 'Active');
  const history = await db.prisma.deviceStateHistory.findMany({ where: { deviceId: f.device.id } });
  assert.deepEqual(
    history.map((x) => [x.axis, x.fromStatus, x.toStatus, x.actorType]),
    [
      ['lifecycle', 'Assigned', 'Active', 'SYSTEM'],
      ['operational', null, 'Active', 'SYSTEM'],
    ],
  );
  const audit = await db.prisma.auditLog.findFirstOrThrow({ where: { objectId: f.device.id, result: 'SUCCESS' } });
  assert.equal(audit.actorId, admin.actorId);
  assert.equal((audit.afterValue as Record<string, unknown>).activationSource, 'LICENSE_OPERATION');
  assert.equal(
    await db.prisma.outboxEvent.count({ where: { aggregateId: f.license.id, eventType: 'LICENSE_CHANGED' } }),
    1,
  );
  assert.equal(
    await db.prisma.auditLog.count({ where: { objectId: f.license.id, action: 'device.license.verified' } }),
    0,
  );
});

test('ordinary Sync repairs an already-active License once without either device confirmation', async () => {
  const f = await fixture();
  await activeLicense(f);
  const results = await Promise.all([f.call({ lastSyncTime: null }), f.call({ lastSyncTime: null })]);
  assert.deepEqual(
    results.map((x) => x.status),
    [200, 200],
  );
  assert.equal(await lifecycle(f.device.id), 'Active');
  assert.equal(await db.prisma.deviceStateHistory.count({ where: { deviceId: f.device.id, axis: 'lifecycle' } }), 1);
  assert.equal(await db.prisma.auditLog.count({ where: { objectId: f.device.id, result: 'SUCCESS' } }), 1);
  const snapshot = await f.serve();
  assert.equal(snapshot.operationalStatus.lifecycleStatus, 'Active');
});

test('Sync returns a retryable conflict when the device activation update no longer applies', async () => {
  const f = await fixture();
  await activeLicense(f);
  await db.pg.exec(`
    CREATE FUNCTION skip_sync_activation() RETURNS trigger AS $$
    BEGIN
      IF OLD.id = '${f.device.id}' AND NEW.lifecycle_status = 'Active' THEN
        RETURN NULL;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER skip_sync_activation BEFORE UPDATE ON devices
      FOR EACH ROW EXECUTE FUNCTION skip_sync_activation();
  `);
  try {
    const response = await f.call({ lastSyncTime: null });
    assert.equal(response.status, 409);
    assert.equal((response.body as { error: { code: string } }).error.code, 'CONFLICT');
    assert.equal(await lifecycle(f.device.id), 'Assigned');
    assert.equal(await db.prisma.deviceLatestState.count({ where: { deviceId: f.device.id } }), 0);
    assert.equal(await db.prisma.deviceStateHistory.count({ where: { deviceId: f.device.id } }), 0);
    assert.equal(await db.prisma.auditLog.count({ where: { objectId: f.device.id, result: 'SUCCESS' } }), 0);
  } finally {
    await db.pg.exec('DROP TRIGGER skip_sync_activation ON devices; DROP FUNCTION skip_sync_activation();');
  }
  assert.equal((await f.serve()).operationalStatus.lifecycleStatus, 'Active');
});

test('old RECEIVED and VERIFIED request shapes remain accepted and cannot activate an Issued license', async () => {
  const f = await fixture();
  const s = await f.serve();
  assert.equal((await f.confirm(s, 'RECEIVED')).status, 200);
  assert.equal((await f.confirm(s, 'VERIFIED')).status, 200);
  assert.equal(await lifecycle(f.device.id), 'Assigned');
  await activeLicense(f);
  assert.equal((await f.confirm(s, 'RECEIVED')).status, 200);
  assert.equal(await lifecycle(f.device.id), 'Active');
  assert.equal(
    await db.prisma.auditLog.count({ where: { objectId: f.license.id, action: { startsWith: 'device.license.' } } }),
    0,
  );
});

for (const state of ['Licensed', 'Suspended', 'Retired', 'Onboarded']) {
  test('cloud reconciliation respects lifecycle ' + state, async () => {
    const f = await fixture();
    await db.prisma.device.update({ where: { id: f.device.id }, data: { lifecycleStatus: state } });
    await activeLicense(f);
    const r = await f.call();
    // Retired Sync additionally requires its existing retirement window.
    assert.equal(r.status, state === 'Retired' ? 403 : 200);
    assert.equal(await lifecycle(f.device.id), state === 'Licensed' ? 'Active' : state);
  });
}

for (const bad of [
  'expired',
  'future',
  'revoked',
  'unsigned',
  'ended-assignment',
  'moved-site',
  'suspended-operational',
]) {
  test('ordinary Sync never activates ' + bad, async () => {
    const f = await fixture();
    await activeLicense(f);
    if (bad === 'expired')
      await db.prisma.license.update({ where: { id: f.license.id }, data: { validTo: new Date(NOW.getTime() - 1) } });
    if (bad === 'future')
      await db.prisma.license.update({ where: { id: f.license.id }, data: { validFrom: new Date(NOW.getTime() + 1) } });
    if (bad === 'revoked') await db.prisma.license.update({ where: { id: f.license.id }, data: { status: 'Revoked' } });
    if (bad === 'unsigned') await db.prisma.license.update({ where: { id: f.license.id }, data: { signature: null } });
    if (bad === 'ended-assignment')
      await db.prisma.deviceAssignment.updateMany({
        where: { deviceId: f.device.id },
        data: { endedAt: new Date(NOW.getTime() - 1) },
      });
    if (bad === 'moved-site') await db.prisma.device.update({ where: { id: f.device.id }, data: { siteId: null } });
    if (bad === 'suspended-operational')
      await db.prisma.deviceLatestState.create({
        data: { deviceId: f.device.id, customerId: f.device.customerId, operationalStatus: 'Suspended' },
      });
    assert.equal((await f.call()).status, 200);
    assert.equal(await lifecycle(f.device.id), 'Assigned');
  });
}

test('License activation and device activation roll back together if device history fails', async () => {
  const f = await fixture();
  await db.pg
    .exec(`CREATE FUNCTION cloud_activation_fail() RETURNS trigger AS $$ BEGIN IF NEW.device_id='${f.device.id}' THEN RAISE EXCEPTION 'history failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER cloud_activation_fail BEFORE INSERT ON device_state_history FOR EACH ROW EXECUTE FUNCTION cloud_activation_fail();`);
  try {
    assert.equal((await activate(f.license.id)).status, 500);
    assert.equal((await db.prisma.license.findUniqueOrThrow({ where: { id: f.license.id } })).status, 'Issued');
    assert.equal(await lifecycle(f.device.id), 'Assigned');
    assert.equal(await db.prisma.licenseHistory.count({ where: { licenseId: f.license.id } }), 0);
    assert.equal(await db.prisma.outboxEvent.count({ where: { aggregateId: f.license.id } }), 0);
    assert.equal(await db.prisma.auditLog.count({ where: { objectId: f.device.id, result: 'SUCCESS' } }), 0);
  } finally {
    await db.pg.exec(
      'DROP TRIGGER cloud_activation_fail ON device_state_history; DROP FUNCTION cloud_activation_fail();',
    );
  }
});

test('License activation before validFrom and unauthorized administrator cannot activate the device', async () => {
  const f = await fixture();
  await db.prisma.license.update({ where: { id: f.license.id }, data: { validFrom: new Date(NOW.getTime() + 1000) } });
  assert.equal((await activate(f.license.id)).status, 409);
  const h = createAdminLicenseHandlers({ client: db.prisma, signingKey: KEY, now: () => clock });
  assert.equal(
    (
      await h.activate({
        actor: { ...admin, roles: ['Auditor'] },
        params: { licenseId: f.license.id },
        headers: {},
        requestId: 'denied',
      })
    ).status,
    403,
  );
  assert.equal(await lifecycle(f.device.id), 'Assigned');
});

test('legacy confirmation values still use strict validation', () => {
  assert.throws(() => parseSyncRequest({ licenseConfirmation: { status: 'INVALID' } }));
  assert.throws(() => parseSyncRequest({ unexpected: true }));
});

test('administrator activation rejects a missing current assignment and rolls back License changes', async () => {
  const f = await fixture();
  await db.prisma.deviceAssignment.updateMany({
    where: { deviceId: f.device.id },
    data: { status: 'ENDED', endedAt: NOW },
  });
  assert.equal((await activate(f.license.id)).status, 409);
  assert.equal(await lifecycle(f.device.id), 'Assigned');
  assert.equal((await db.prisma.license.findUniqueOrThrow({ where: { id: f.license.id } })).status, 'Issued');
});

test('revoked certificate cannot reconcile an otherwise active License', async () => {
  const f = await fixture();
  await activeLicense(f);
  await db.prisma.deviceCertificate.update({
    where: { id: f.certificate.id },
    data: { revokedAt: NOW, status: 'REVOKED' },
  });
  assert.equal((await f.call()).status, 401);
  assert.equal(await lifecycle(f.device.id), 'Assigned');
});

test('future and expired licenses do not activate through the administrator operation', async () => {
  const f = await fixture();
  await db.prisma.license.update({ where: { id: f.license.id }, data: { validTo: new Date(NOW.getTime() - 1) } });
  assert.equal((await activate(f.license.id)).status, 409);
  assert.equal(await lifecycle(f.device.id), 'Assigned');
});
