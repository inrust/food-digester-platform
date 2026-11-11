import { withTransaction, type DbClient } from '@fdp/database';
import type { DeviceAuthContext } from '@fdp/auth';
import { verifyDeviceCertificate } from '@fdp/auth';
import type { ClientCertIdentity } from '@fdp/auth';
import { activateDeviceForCloudLicense } from './license-activation.js';

/** Reconcile previously cloud-activated licenses without a device receipt or verification claim. */
export async function reconcileCloudLicense(
  client: DbClient,
  auth: DeviceAuthContext,
  identity: ClientCertIdentity | undefined,
  now: Date,
): Promise<void> {
  if (!auth.customerId || !['Assigned', 'Licensed'].includes(auth.deviceLifecycleStatus)) return;
  await withTransaction(client, async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM devices WHERE id = $1 FOR UPDATE', auth.deviceId);
    const fresh = await verifyDeviceCertificate(tx, identity, { now, retiredAccess: 'SYNC' });
    if (fresh.customerId !== auth.customerId) return;
    await tx.$queryRawUnsafe('SELECT id FROM licenses WHERE device_id = $1 ORDER BY id FOR UPDATE', auth.deviceId);
    const license = await tx.license.findFirst({
      where: {
        deviceId: auth.deviceId,
        customerId: auth.customerId ?? '',
        status: { in: ['Active', 'ExpiringSoon', 'Renewed'] },
        validFrom: { lte: now },
        validTo: { gt: now },
      },
      orderBy: [{ validTo: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    if (license)
      await activateDeviceForCloudLicense(tx, license, now, 'system:license-reconciliation', 'SYNC_RECONCILIATION');
  });
}
