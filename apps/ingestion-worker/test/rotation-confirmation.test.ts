import { afterAll, beforeAll, describe, test, expect } from 'vitest';
import {
  certificateFingerprintFromPem,
  recordCertificateVerification,
  sweepCertificateLifecycle,
  claimDevicePublicKey,
  verifyDeviceCertificate,
  SecurePackageService,
  createLocalTestKeyProvider,
  CERTIFICATE_PACKAGE_RETENTION_SECONDS,
} from '@fdp/auth';
import { confirmCertificateRotationOnFirstHeartbeat } from '../src/index.js';
import { createTestDb } from '../../cloud-api/test/helpers.js';
import { resolveDeviceContext } from '../src/ingest/identity.js';
const NOW = new Date('2026-10-01T00:00:00Z');
const DEADLINE = new Date(NOW.getTime() + 86400000);
let db: Awaited<ReturnType<typeof createTestDb>>;
let securePackage: SecurePackageService;
let counter = 0;
beforeAll(async () => {
  db = await createTestDb();
  securePackage = new SecurePackageService({
    db: db.prisma,
    keyProvider: createLocalTestKeyProvider('dual-channel'),
    config: { retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS, maxClaims: 1, now: () => NOW },
  });
}, 60000);
afterAll(async () => {
  await db.prisma.$disconnect();
  await db.pg.close();
});
async function window() {
  const suffix = ++counter;
  const deviceId = `dual-${suffix}`;
  const oldId = `old-${suffix}`;
  const newId = `new-${suffix}`;
  await db.prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-DUAL-${suffix}`,
      model: 'BNX',
      hardwareVersion: '1',
      manufacturer: 'test',
      manufactureDate: NOW,
      lifecycleStatus: 'Active',
    },
  });
  const oldPem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(oldId).toString('base64')}\n-----END CERTIFICATE-----`;
  const newPem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(newId).toString('base64')}\n-----END CERTIFICATE-----`;
  for (const [id, pem] of [
    [oldId, oldPem],
    [newId, newPem],
  ])
    await db.prisma.deviceCertificate.create({
      data: {
        id: id!,
        deviceId,
        fingerprint: certificateFingerprintFromPem(pem!),
        status: 'ACTIVE',
        notBefore: NOW,
        notAfter: new Date('2028-01-01T00:00:00Z'),
        ...(id === newId ? { rotatedFromId: oldId, rotationDeadlineAt: DEADLINE } : {}),
      },
    });
  await securePackage.storePackage(newId, Buffer.from('{}'));
  const input = { deviceId, certificateFingerprint: certificateFingerprintFromPem(newPem) };
  const mqtt = () =>
    confirmCertificateRotationOnFirstHeartbeat({ client: db.prisma, securePackage, now: () => NOW }, input);
  const rest = () => recordCertificateVerification(db.prisma, { ...input, channel: 'rest' }, NOW);
  return { deviceId, oldId, newId, oldPem, newPem, input, mqtt, rest };
}
const certificate = (id: string) => db.prisma.deviceCertificate.findUniqueOrThrow({ where: { id } });
describe('certificate dual-channel lifecycle', () => {
  test('MQTT first: old certificate remains valid until REST, then durable AWS intent and admin completion', async () => {
    const f = await window();
    await db.prisma.certificateRotationRequest.create({
      data: { deviceId: f.deviceId, certificateId: f.oldId, status: 'PENDING', requestedBy: 'admin', notifiedAt: NOW },
    });
    expect((await f.mqtt()).confirmed).toBe(false);
    expect((await certificate(f.oldId)).status).toBe('ACTIVE');
    expect((await certificate(f.newId)).mqttVerifiedAt).toEqual(NOW);
    expect((await f.rest()).confirmed).toBe(true);
    expect((await certificate(f.oldId)).iotDeactivationPending).toBe(true);
    expect((await certificate(f.newId)).packageCiphertext).toBeNull();
    expect((await db.prisma.certificateRotationRequest.findFirst({ where: { deviceId: f.deviceId } }))?.status).toBe(
      'COMPLETED',
    );
    await expect(verifyDeviceCertificate(db.prisma, { clientCertPem: f.oldPem }, { now: NOW })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
  test('REST first and repeated Heartbeat: one confirmation and first timestamps retained', async () => {
    const f = await window();
    expect((await f.rest()).confirmed).toBe(false);
    expect((await f.mqtt()).confirmed).toBe(true);
    expect((await f.mqtt()).confirmed).toBe(false);
    expect((await f.rest()).confirmed).toBe(false);
    const audits = await db.prisma.auditLog.findMany({ where: { objectId: f.newId, action: 'CERT_ROTATION_CONFIRM' } });
    expect(audits).toHaveLength(1);
  });
  test('concurrent channels and repetitions complete exactly once', async () => {
    const f = await window();
    const results = await Promise.all([f.mqtt(), f.rest(), f.mqtt(), f.rest()]);
    expect(results.filter((result) => result.confirmed)).toHaveLength(1);
  });
  test('cross-device fingerprint cannot record evidence or revoke any certificate', async () => {
    const f = await window();
    const other = await window();
    const result = await recordCertificateVerification(
      db.prisma,
      { deviceId: other.deviceId, certificateFingerprint: f.input.certificateFingerprint, channel: 'rest' },
      NOW,
    );
    expect(result.confirmed).toBe(false);
    expect((await certificate(f.newId)).restVerifiedAt).toBeNull();
    expect((await certificate(f.oldId)).status).toBe('ACTIVE');
  });
  test('ordinary onboarding certificate records channel health without requiring rotation', async () => {
    const f = await window();
    const result = await recordCertificateVerification(
      db.prisma,
      { deviceId: f.deviceId, certificateFingerprint: certificateFingerprintFromPem(f.oldPem), channel: 'rest' },
      NOW,
    );
    expect(result.confirmed).toBe(false);
    expect((await certificate(f.oldId)).restVerifiedAt).toEqual(NOW);
  });
  test('failed AWS deactivation remains pending, next sweep succeeds and duplicate sweep is harmless', async () => {
    const f = await window();
    await f.mqtt();
    await f.rest();
    const first = await sweepCertificateLifecycle(
      db.prisma,
      async (id) => {
        if (id === f.oldId) throw new Error('AWS unavailable');
      },
      NOW,
    );
    expect(first.failed).toContain(f.oldId);
    expect((await certificate(f.oldId)).iotDeactivationPending).toBe(true);
    expect((await certificate(f.oldId)).status).toBe('REVOKED');
    const retried = await sweepCertificateLifecycle(db.prisma, async () => {}, NOW);
    expect(retried.deactivated).toContain(f.oldId);
    const row = await certificate(f.oldId);
    expect(row.iotDeactivationAttempts).toBe(2);
    expect(row.iotDeactivatedAt).toEqual(NOW);
    expect(
      (
        await sweepCertificateLifecycle(
          db.prisma,
          async () => {
            throw new Error('must not repeat');
          },
          NOW,
        )
      ).deactivated,
    ).not.toContain(f.oldId);
  });
  test('24h boundary rejects new REST/MQTT even before sweep; timeout revokes new and keeps old', async () => {
    const f = await window();
    await f.mqtt();
    await expect(
      verifyDeviceCertificate(db.prisma, { clientCertPem: f.newPem }, { now: DEADLINE }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(
      resolveDeviceContext(
        db.prisma,
        { iotPrincipal: `arn:aws:iot:r:a:cert/${f.newId}`, iotDeviceId: f.deviceId },
        DEADLINE,
      ),
    ).rejects.toThrow();
    expect((await recordCertificateVerification(db.prisma, { ...f.input, channel: 'rest' }, DEADLINE)).confirmed).toBe(
      false,
    );
    const swept = await sweepCertificateLifecycle(db.prisma, async () => {}, DEADLINE);
    expect(swept.expired).toContain(f.newId);
    expect((await certificate(f.newId)).status).toBe('REVOKED');
    expect((await certificate(f.oldId)).status).toBe('ACTIVE');
  });
  test('concurrent public-key reuse is permanently owned by one device; same-device retry allowed', async () => {
    const a = await window();
    const b = await window();
    const results = await Promise.all([
      claimDevicePublicKey(db.prisma, a.deviceId, 'shared-key'),
      claimDevicePublicKey(db.prisma, b.deviceId, 'shared-key'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimDevicePublicKey(db.prisma, a.deviceId, 'shared-key')).toBe(results[0]);
  });
});
