import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction, acquireTransactionLock } from '@fdp/database';

export const CERTIFICATE_ROTATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export interface VerificationInput {
  readonly deviceId: string;
  readonly certificateFingerprint: string;
  readonly channel: 'mqtt' | 'rest';
}
interface CertificateRow {
  id: string;
  deviceId: string;
  status: string;
  rotatedFromId: string | null;
  rotationDeadlineAt: Date | null;
  rotationConfirmedAt: Date | null;
  mqttVerifiedAt: Date | null;
  restVerifiedAt: Date | null;
}
function certificates(client: DbClient) {
  return (client as any).deviceCertificate as {
    findFirst(args: any): Promise<CertificateRow | null>;
    findMany(args: any): Promise<CertificateRow[]>;
    updateMany(args: any): Promise<{ count: number }>;
  };
}

/** Both channels use this transaction, so either arrival order completes the same durable transition. */
export async function recordCertificateVerification(client: DbClient, input: VerificationInput, now = new Date()) {
  return withTransaction(client, async (tx) => {
    await acquireTransactionLock(tx, `certificate-rotation:${input.deviceId}`);
    const certs = certificates(tx);
    const preview = await certs.findFirst({
      where: {
        deviceId: input.deviceId,
        fingerprint: input.certificateFingerprint,
        status: 'ACTIVE',
        revokedAt: null,
        notBefore: { lte: now },
        notAfter: { gt: now },
      },
    });
    if (!preview) return { confirmed: false, revokedCertificateId: null };
    await acquireTransactionLock(tx, `certificate-verification:${preview.id}`);
    const channelField = input.channel === 'mqtt' ? 'mqttVerifiedAt' : 'restVerifiedAt';
    await certs.updateMany({
      where: { id: preview.id, status: 'ACTIVE', revokedAt: null, [channelField]: null },
      data: { [channelField]: now },
    });
    const certificate = await certs.findFirst({ where: { id: preview.id, status: 'ACTIVE', revokedAt: null } });
    if (
      !certificate?.rotatedFromId ||
      certificate.rotationConfirmedAt ||
      !certificate.mqttVerifiedAt ||
      !certificate.restVerifiedAt ||
      !certificate.rotationDeadlineAt ||
      certificate.rotationDeadlineAt <= now
    )
      return { confirmed: false, revokedCertificateId: null };
    const old = await certs.findFirst({
      where: { id: certificate.rotatedFromId, deviceId: input.deviceId, status: 'ACTIVE', revokedAt: null },
    });
    if (!old) return { confirmed: false, revokedCertificateId: null };
    const claimed = await certs.updateMany({
      where: {
        id: certificate.id,
        status: 'ACTIVE',
        rotationConfirmedAt: null,
        rotationDeadlineAt: { gt: now },
        mqttVerifiedAt: { not: null },
        restVerifiedAt: { not: null },
      },
      data: { rotationConfirmedAt: now },
    });
    if (claimed.count !== 1) return { confirmed: false, revokedCertificateId: null };
    const revoked = await certs.updateMany({
      where: { id: old.id, deviceId: input.deviceId, status: 'ACTIVE', revokedAt: null },
      data: { status: 'REVOKED', revokedAt: now, iotDeactivationPending: true },
    });
    if (revoked.count !== 1) throw new Error('Certificate rotation changed concurrently');
    await certs.updateMany({
      where: { id: certificate.id },
      data: { packageCiphertext: null, packageKmsKeyId: null, packageExpiresAt: null },
    });
    await (tx as any).certificateRotationRequest.updateMany({
      where: { deviceId: input.deviceId, certificateId: old.id, status: 'PENDING' },
      data: { status: 'COMPLETED', completedAt: now },
    });
    await recordAudit(tx, {
      objectType: 'deviceCertificate',
      objectId: certificate.id,
      actorId: 'system:certificate-rotation',
      action: 'CERT_ROTATION_CONFIRM',
      result: 'SUCCESS',
      afterValue: {
        oldCertificateId: old.id,
        mqttVerifiedAt: certificate.mqttVerifiedAt.toISOString(),
        restVerifiedAt: certificate.restVerifiedAt.toISOString(),
        iotDeactivationPending: true,
      },
    });
    return { confirmed: true, revokedCertificateId: old.id };
  });
}

/** Database revocation and AWS intent commit together. AWS failure never restores application access. */
export async function sweepCertificateLifecycle(
  client: DbClient,
  deactivateCertificate: (id: string) => Promise<void>,
  now = new Date(),
  batchSize = 100,
) {
  const expired = await certificates(client).findMany({
    where: {
      status: 'ACTIVE',
      rotatedFromId: { not: null },
      rotationConfirmedAt: null,
      rotationDeadlineAt: { lte: now },
    },
    orderBy: { rotationDeadlineAt: 'asc' },
    take: batchSize,
  });
  for (const certificate of expired)
    await withTransaction(client, async (tx) => {
      await acquireTransactionLock(tx, `certificate-verification:${certificate.id}`);
      const changed = await certificates(tx).updateMany({
        where: { id: certificate.id, status: 'ACTIVE', rotationConfirmedAt: null, rotationDeadlineAt: { lte: now } },
        data: {
          status: 'REVOKED',
          revokedAt: now,
          iotDeactivationPending: true,
          packageCiphertext: null,
          packageKmsKeyId: null,
          packageExpiresAt: null,
        },
      });
      if (changed.count)
        await recordAudit(tx, {
          objectType: 'deviceCertificate',
          objectId: certificate.id,
          action: 'CERT_ROTATION_TIMEOUT',
          result: 'SUCCESS',
          afterValue: { oldCertificateId: certificate.rotatedFromId, iotDeactivationPending: true },
        });
    });
  const pending = await certificates(client).findMany({
    where: { status: 'REVOKED', iotDeactivationPending: true },
    orderBy: [{ iotDeactivationAttempts: 'asc' }, { revokedAt: 'asc' }],
    take: batchSize,
  });
  const deactivated: string[] = [];
  const failed: string[] = [];
  for (const certificate of pending) {
    await certificates(client).updateMany({
      where: { id: certificate.id, iotDeactivationPending: true },
      data: { iotDeactivationAttempts: { increment: 1 } },
    });
    try {
      await deactivateCertificate(certificate.id);
    } catch {
      failed.push(certificate.id);
      continue;
    }
    await withTransaction(client, async (tx) => {
      const updated = await certificates(tx).updateMany({
        where: { id: certificate.id, status: 'REVOKED', iotDeactivationPending: true },
        data: { iotDeactivationPending: false, iotDeactivatedAt: now },
      });
      if (updated.count)
        await recordAudit(tx, {
          objectType: 'deviceCertificate',
          objectId: certificate.id,
          action: 'CERT_IOT_DEACTIVATED',
          result: 'SUCCESS',
        });
    });
    deactivated.push(certificate.id);
  }
  return { expired: expired.map((certificate) => certificate.id), deactivated, failed };
}

/** Transaction-level ownership claim prevents two devices concurrently enrolling the same key. */
export async function claimDevicePublicKey(client: DbClient, deviceId: string, fingerprint: string) {
  return withTransaction(client, async (tx) => {
    await acquireTransactionLock(tx, `device-public-key:${fingerprint}`);
    const keys = (tx as any).devicePublicKey;
    const existing = await keys.findFirst({ where: { fingerprint } });
    if (existing) return existing.deviceId === deviceId;
    await keys.create({ data: { fingerprint, deviceId } });
    return true;
  });
}
