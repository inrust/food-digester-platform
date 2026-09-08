/** DEC-014：退役完成后的 AWS IoT 证书停用恢复器。 */
import { randomUUID } from 'node:crypto';
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';

export const RETIREMENT_IOT_REVOCATION_LEASE_SECONDS = 300;

export interface RetirementCertificateRevoker {
  deactivateCertificate(certificateId: string): Promise<void>;
}

interface RetirementRow {
  readonly id: string;
  readonly deviceId: string;
  readonly certificateRevokedAt: Date | null;
}

interface RetirementDelegate {
  findMany(args: Record<string, unknown>): Promise<RetirementRow[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface CertificateDelegate {
  findMany(args: { where: Record<string, unknown>; select: Record<string, boolean> }): Promise<Array<{ id: string }>>;
}

const retirements = (client: DbClient): RetirementDelegate =>
  (client as unknown as Record<string, unknown>).deviceRetirement as RetirementDelegate;
const certificates = (client: DbClient): CertificateDelegate =>
  (client as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;

export interface RetirementIotRevocationResult {
  readonly examined: number;
  readonly completed: number;
  readonly failed: number;
  readonly skipped: number;
}

export async function processRetirementIotRevocations(
  rootClient: DbClient,
  revoker: RetirementCertificateRevoker,
  options: {
    readonly now?: Date;
    readonly batchSize?: number;
    readonly deviceId?: string;
    readonly leaseSeconds?: number;
  } = {},
): Promise<RetirementIotRevocationResult> {
  const at = options.now ?? new Date();
  const leaseSeconds = options.leaseSeconds ?? RETIREMENT_IOT_REVOCATION_LEASE_SECONDS;
  const candidates = await retirements(rootClient).findMany({
    where: {
      status: 'CONFIRMED',
      ...(options.deviceId ? { deviceId: options.deviceId } : {}),
      OR: [
        { iotRevocationStatus: 'PENDING' },
        { iotRevocationStatus: 'FAILED' },
        { iotRevocationStatus: 'IN_PROGRESS', iotRevocationLeaseUntil: { lte: at } },
      ],
    },
    orderBy: { confirmedAt: 'asc' },
    take: Math.max(1, Math.min(options.batchSize ?? 100, 1000)),
  });
  let completed = 0;
  let failed = 0;
  let skipped = 0;

  for (const retirement of candidates) {
    const leaseToken = randomUUID();
    const claimed = await retirements(rootClient).updateMany({
      where: {
        id: retirement.id,
        status: 'CONFIRMED',
        OR: [
          { iotRevocationStatus: 'PENDING' },
          { iotRevocationStatus: 'FAILED' },
          { iotRevocationStatus: 'IN_PROGRESS', iotRevocationLeaseUntil: { lte: at } },
        ],
      },
      data: {
        iotRevocationStatus: 'IN_PROGRESS',
        iotRevocationAttempts: { increment: 1 },
        iotRevocationLastAttemptAt: at,
        iotRevocationLeaseUntil: new Date(at.getTime() + leaseSeconds * 1000),
        iotRevocationLeaseToken: leaseToken,
        iotRevocationLastError: null,
      },
    });
    if (claimed.count !== 1) {
      skipped += 1;
      continue;
    }

    try {
      const certificateRows = retirement.certificateRevokedAt
        ? await certificates(rootClient).findMany({
            where: {
              deviceId: retirement.deviceId,
              status: 'REVOKED',
              revokedAt: retirement.certificateRevokedAt,
            },
            select: { id: true },
          })
        : [];
      for (const certificate of certificateRows) await revoker.deactivateCertificate(certificate.id);
      const won = await withTransaction(rootClient, async (tx) => {
        const updated = await retirements(tx).updateMany({
          where: { id: retirement.id, iotRevocationStatus: 'IN_PROGRESS', iotRevocationLeaseToken: leaseToken },
          data: {
            iotRevocationStatus: 'COMPLETED',
            iotRevocationCompletedAt: at,
            iotRevocationLeaseUntil: null,
            iotRevocationLeaseToken: null,
          },
        });
        if (updated.count === 1) {
          await recordAudit(tx, {
            objectType: 'deviceCertificate',
            objectId: retirement.deviceId,
            action: 'device.retire.iot_certificate_deactivate',
            result: 'SUCCESS',
            actorId: 'system:retirement-iot-revocation',
            actorRole: 'SYSTEM',
            reason: 'DEC-014',
            afterValue: { certificateIds: certificateRows.map((item) => item.id), newStatus: 'INACTIVE' },
          });
        }
        return updated.count;
      });
      completed += won;
      skipped += won === 0 ? 1 : 0;
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'IOT_DEACTIVATE_FAILED';
      await withTransaction(rootClient, async (tx) => {
        const updated = await retirements(tx).updateMany({
          where: { id: retirement.id, iotRevocationStatus: 'IN_PROGRESS', iotRevocationLeaseToken: leaseToken },
          data: {
            iotRevocationStatus: 'FAILED',
            iotRevocationLastError: reason,
            iotRevocationLeaseUntil: null,
            iotRevocationLeaseToken: null,
          },
        });
        if (updated.count === 1) {
          await recordAudit(tx, {
            objectType: 'deviceCertificate',
            objectId: retirement.deviceId,
            action: 'device.retire.iot_certificate_deactivate',
            result: 'FAILURE',
            actorId: 'system:retirement-iot-revocation',
            actorRole: 'SYSTEM',
            reason,
          });
          failed += 1;
        } else {
          skipped += 1;
        }
      });
    }
  }

  return { examined: candidates.length, completed, failed, skipped };
}
