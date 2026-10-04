import { contractHandler } from '../../../contracts/testing/device-contract.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test, assert } from 'vitest';
import { certificateFingerprintFromPem } from '@fdp/auth';
import { assertOpenApiResponse } from './openapi-response.js';
import { createTestDb } from './helpers.js';
import { createDeviceSyncHandler } from '../src/device/sync-handler.js';
import { type DeviceSyncSnapshot, parseSyncRequest } from '../src/device/sync.js';
import { signLicensePayload, verifyLicensePayloadSignature } from '../src/admin/license/service.js';
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
test('real PostgreSQL: served snapshot and signed local verification drive Assigned→Licensed→Active once', async () => {
  const f = await fixture();
  const s = await f.serve();
  assert.equal(s.operationalStatus.lifecycleStatus, 'Assigned');
  assert.equal((await db.prisma.device.findUnique({ where: { id: f.device.id } }))!.lifecycleStatus, 'Assigned');
  const payload = s.license!.signaturePayload;
  assert.notEqual(payload.validFrom, s.license!.validFrom);
  assert.isTrue(
    verifyLicensePayloadSignature(
      { active: KEY },
      { ...payload, validFrom: new Date(payload.validFrom), validTo: new Date(payload.validTo) },
      s.license!.signature!,
    ),
  );
  assert.isFalse(
    verifyLicensePayloadSignature(
      { active: 'wrong-key' },
      { ...payload, validFrom: new Date(payload.validFrom), validTo: new Date(payload.validTo) },
      s.license!.signature!,
    ),
  );
  assert.equal((await f.confirm(s, 'VERIFIED')).status, 409);
  const received = await f.confirm(s, 'RECEIVED');
  assert.equal(received.status, 200);
  assert.equal((received.body as DeviceSyncSnapshot).operationalStatus.lifecycleStatus, 'Licensed');
  const active = await f.confirm(s, 'VERIFIED');
  assert.equal(active.status, 200);
  assert.equal((active.body as DeviceSyncSnapshot).operationalStatus.lifecycleStatus, 'Active');
  assert.equal((active.body as DeviceSyncSnapshot).operationalStatus.operationalStatus, 'Active');
  assert.equal((await f.confirm(s, 'RECEIVED')).status, 200);
  assert.equal((await f.confirm(s, 'VERIFIED')).status, 200);
  const history = await db.prisma.deviceStateHistory.findMany({
    where: { deviceId: f.device.id },
    orderBy: { createdAt: 'asc' },
  });
  assert.deepEqual(
    history.filter((x) => x.axis === 'lifecycle').map((x) => [x.fromStatus, x.toStatus, x.actorType]),
    [
      ['Assigned', 'Licensed', 'SYSTEM'],
      ['Licensed', 'Active', 'DEVICE'],
    ],
  );
  assert.equal(history.filter((x) => x.axis === 'operational').length, 1);
  assert.equal(
    await db.prisma.auditLog.count({ where: { objectId: f.license.id, action: 'device.license.snapshot-served' } }),
    1,
  );
  assert.equal(
    await db.prisma.auditLog.count({ where: { objectId: f.license.id, action: 'device.license.verified' } }),
    1,
  );
  const audit = JSON.stringify(await db.prisma.auditLog.findMany({ where: { objectId: f.license.id } }));
  assert.notInclude(audit, s.license!.signature!);
  assert.notInclude(audit, KEY);
});
test('a built but uncommitted response and lastSyncTime cannot prove license delivery', async () => {
  const f = await fixture();
  const r = await f.call({ lastSyncTime: NOW.toISOString() });
  assert.equal(r.status, 200);
  assert.equal((await f.confirm(r.body as DeviceSyncSnapshot, 'RECEIVED')).status, 409);
  assert.equal((await db.prisma.device.findUnique({ where: { id: f.device.id } }))!.lifecycleStatus, 'Assigned');
});
test('cross-device and forged etag confirmation are rejected without state change', async () => {
  const a = await fixture(),
    b = await fixture();
  const s = await a.serve();
  assert.equal(
    (
      await b.call({
        licenseConfirmation: {
          licenseId: a.license.id,
          version: s.license!.version,
          snapshotEtag: s.etag,
          status: 'RECEIVED',
        },
      })
    ).status,
    409,
  );
  assert.equal((await a.confirm({ ...s, etag: '0'.repeat(64) }, 'RECEIVED')).status, 409);
  assert.equal(await db.prisma.deviceStateHistory.count({ where: { deviceId: a.device.id } }), 0);
});
test('renewed version or changed signature invalidates a previously served confirmation', async () => {
  const f = await fixture(),
    s = await f.serve();
  await db.prisma.license.update({
    where: { id: f.license.id },
    data: { version: { increment: 1 }, signature: 'v1.changed' },
  });
  assert.equal((await f.confirm(s, 'RECEIVED')).status, 409);
  assert.equal(await db.prisma.deviceStateHistory.count({ where: { deviceId: f.device.id } }), 0);
});
test('expired/revoked licenses and changed assignment cannot activate a device', async () => {
  for (const change of ['expired', 'revoked', 'assignment']) {
    const f = await fixture(),
      s = await f.serve();
    assert.equal((await f.confirm(s, 'RECEIVED')).status, 200);
    if (change === 'expired') await db.prisma.license.update({ where: { id: f.license.id }, data: { validTo: NOW } });
    if (change === 'revoked')
      await db.prisma.license.update({ where: { id: f.license.id }, data: { status: 'Revoked' } });
    if (change === 'assignment')
      await db.prisma.deviceAssignment.updateMany({
        where: { deviceId: f.device.id },
        data: { status: 'ENDED', endedAt: NOW },
      });
    assert.equal((await f.confirm(s, 'VERIFIED')).status, 409);
    assert.equal((await db.prisma.device.findUnique({ where: { id: f.device.id } }))!.lifecycleStatus, 'Licensed');
  }
});
test('receipt expires after24h and a rotated certificate cannot reuse old certificate delivery', async () => {
  const f = await fixture(),
    s = await f.serve();
  clock = new Date(NOW.getTime() + 86400001);
  assert.equal((await f.confirm(s, 'RECEIVED')).status, 409);
  clock = new Date(NOW.getTime() + 86400000);
  assert.equal((await f.confirm(s, 'RECEIVED')).status, 200);
  clock = NOW;
  await db.prisma.deviceCertificate.update({ where: { id: f.certificate.id }, data: { status: 'REVOKED' } });
  assert.equal((await f.confirm(s, 'RECEIVED')).status, 401);
  const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from('rotated-' + f.device.id).toString('base64')}\n-----END CERTIFICATE-----`;
  await db.prisma.deviceCertificate.create({
    data: {
      id: randomUUID(),
      deviceId: f.device.id,
      fingerprint: certificateFingerprintFromPem(pem),
      status: 'ACTIVE',
      notBefore: NOW,
      notAfter: new Date(NOW.getTime() + 7 * 86400000),
    },
  });
  const rotated = await createDeviceSyncHandler({
    client: db.prisma,
    now: () => clock,
    maintenanceSyncIntervalSeconds: 900,
  })({
    identity: { clientCertPem: pem },
    body: {
      licenseConfirmation: {
        licenseId: f.license.id,
        version: s.license!.version,
        snapshotEtag: s.etag,
        status: 'RECEIVED',
      },
    },
    requestId: randomUUID(),
  });
  assert.equal(rotated.status, 409);
});
test('stale confirmation cannot restore Suspended and serializable concurrent confirmations do not duplicate history', async () => {
  const f = await fixture(),
    s = await f.serve();
  const responses = await Promise.all([f.confirm(s, 'RECEIVED'), f.confirm(s, 'RECEIVED')]);
  assert.isTrue(responses.every((r) => [200, 409].includes(r.status)));
  assert.equal(await db.prisma.deviceStateHistory.count({ where: { deviceId: f.device.id, axis: 'lifecycle' } }), 1);
  await db.prisma.device.update({ where: { id: f.device.id }, data: { lifecycleStatus: 'Suspended' } });
  assert.equal((await f.confirm(s, 'VERIFIED')).status, 409);
  assert.equal((await db.prisma.device.findUnique({ where: { id: f.device.id } }))!.lifecycleStatus, 'Suspended');
});
test('confirmation schema fails closed on unknown fields and malformed identifiers', () => {
  for (const c of [
    null,
    { licenseId: randomUUID(), version: 1, snapshotEtag: 'a'.repeat(64), status: 'VERIFIED', verified: true },
    { licenseId: randomUUID(), version: 0, snapshotEtag: 'a'.repeat(64), status: 'RECEIVED' },
    { licenseId: randomUUID(), version: 1, snapshotEtag: 'bad', status: 'RECEIVED' },
  ])
    assert.throws(() => parseSyncRequest({ licenseConfirmation: c }));
});

test('confirmation audit failure rolls back lifecycle, operational mirror and history atomically', async () => {
  const f = await fixture(),
    s = await f.serve();
  await db.pg.exec(`CREATE FUNCTION qa09_reject_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = 'device.license.received' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER qa09_reject_confirmation BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION qa09_reject_confirmation();`);
  try {
    assert.equal((await f.confirm(s, 'RECEIVED')).status, 500);
    assert.equal(
      (await db.prisma.device.findUniqueOrThrow({ where: { id: f.device.id } })).lifecycleStatus,
      'Assigned',
    );
    assert.equal(await db.prisma.deviceStateHistory.count({ where: { deviceId: f.device.id } }), 0);
    assert.equal(
      await db.prisma.auditLog.count({ where: { objectId: f.license.id, action: 'device.license.received' } }),
      0,
    );
  } finally {
    await db.pg.exec('DROP TRIGGER qa09_reject_confirmation ON audit_logs; DROP FUNCTION qa09_reject_confirmation();');
  }
  assert.equal((await f.confirm(s, 'RECEIVED')).status, 200);
});

test('unsigned Draft response is contract-valid and cannot create a delivery acknowledgement', async () => {
  const f = await fixture();
  await db.prisma.license.update({ where: { id: f.license.id }, data: { status: 'Draft', signature: null } });
  const snapshot = await f.serve();
  assertOpenApiResponse('syncDevice', 200, snapshot);
  assert.equal(snapshot.license!.signature, null);
  assert.equal((await f.confirm(snapshot, 'RECEIVED')).status, 409);
  assert.equal(
    await db.prisma.auditLog.count({ where: { objectId: f.license.id, action: 'device.license.snapshot-served' } }),
    0,
  );
});
