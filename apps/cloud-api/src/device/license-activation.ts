import { recordAudit, type DbClient } from '@fdp/database';
import { licenseStateNotAllowed } from '../admin/license/errors.js';
import { transitionLifecycle, type LifecycleStatus, type OperationalStatus } from '@fdp/domain';

interface ActivationLicense {
  readonly id: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly status: string;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly signature: string | null;
  readonly version: number;
}

/** Called under device -> license row locks, inside the caller's authority-aware transaction. */
export async function activateDeviceForCloudLicense(
  tx: DbClient,
  license: ActivationLicense,
  now: Date,
  actorId: string,
  source: 'LICENSE_OPERATION' | 'SYNC_RECONCILIATION',
): Promise<void> {
  if (
    !['Active', 'ExpiringSoon', 'Renewed'].includes(license.status) ||
    !license.signature ||
    license.validFrom > now ||
    license.validTo <= now
  )
    return;
  const device = await tx.device.findUnique({ where: { id: license.deviceId } });
  if (!device || !['Assigned', 'Licensed'].includes(device.lifecycleStatus)) return;
  if (!device.customerId || !device.siteId || device.customerId !== license.customerId) {
    if (source === 'LICENSE_OPERATION')
      throw licenseStateNotAllowed('The device assignment does not match the license');
    return;
  }
  const assignment = await tx.deviceAssignment.findFirst({
    where: {
      deviceId: device.id,
      customerId: device.customerId,
      siteId: device.siteId,
      status: 'ACTIVE',
      assignedAt: { lte: now },
      OR: [{ endedAt: null }, { endedAt: { gt: now } }],
    },
  });
  if (!assignment) {
    if (source === 'LICENSE_OPERATION') throw licenseStateNotAllowed('The device has no current assignment');
    return;
  }
  const latest = await tx.deviceLatestState.findUnique({ where: { deviceId: device.id } });
  if (latest && ['Suspended', 'Retired'].includes(latest.operationalStatus ?? '')) return;
  const effects = transitionLifecycle(
    {
      id: device.id,
      lifecycleStatus: device.lifecycleStatus as LifecycleStatus,
      operationalStatus: (latest?.operationalStatus ?? null) as OperationalStatus | null,
    },
    'Active',
    { actorType: 'SYSTEM', actorId },
    { cloudLicenseActive: true },
  );
  const updated = await tx.device.updateMany({
    where: { id: device.id, customerId: device.customerId, lifecycleStatus: device.lifecycleStatus },
    data: { lifecycleStatus: 'Active' },
  });
  if (updated.count !== 1) throw new Error('CLOUD_LICENSE_ACTIVATION_CONFLICT');
  await tx.deviceLatestState.upsert({
    where: { deviceId: device.id },
    create: { deviceId: device.id, customerId: device.customerId, operationalStatus: 'Active' },
    update: { operationalStatus: 'Active' },
  });
  for (const entry of effects.stateHistory) await tx.deviceStateHistory.create({ data: entry });
  await recordAudit(tx, {
    objectType: 'device',
    objectId: device.id,
    action: effects.auditEvent.action,
    actorId,
    actorRole: 'SYSTEM',
    customerId: device.customerId,
    result: 'SUCCESS',
    beforeValue: { lifecycleStatus: device.lifecycleStatus },
    afterValue: {
      ...effects.auditEvent.afterValue,
      licenseId: license.id,
      licenseVersion: license.version,
      activationSource: source,
    },
  });
}
