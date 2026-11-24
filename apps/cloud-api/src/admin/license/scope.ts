import type { ActorContext } from '@fdp/auth';
import type { DbClient } from '@fdp/database';
import { licenseConflict, licenseNotFound, licenseValidationFailed } from './errors.js';

export interface LicenseScopeInput {
  readonly contractId?: string;
  readonly deviceId?: string;
  readonly associationId?: string;
}

export interface LicenseScopeDevice {
  readonly deviceId: string;
  readonly customerId: string;
  readonly associationId: string | null;
  readonly label: string;
  readonly canCreate: boolean;
}

export interface LicenseScopeView {
  readonly contractId: string | null;
  readonly devices: readonly LicenseScopeDevice[];
}

export function parseLicenseScope(
  query: Readonly<Record<string, string | undefined>> = {},
): LicenseScopeInput | undefined {
  const { contractId, scopeDeviceId, associationId } = query;
  if ([contractId, scopeDeviceId, associationId].every((id) => id === undefined)) return undefined;
  if (
    [contractId, scopeDeviceId, associationId].some((id) => id !== undefined && (!id.trim() || id.includes(','))) ||
    (!contractId && !scopeDeviceId) ||
    (associationId !== undefined && (!contractId || !scopeDeviceId))
  ) {
    throw licenseValidationFailed('Invalid license scope');
  }
  return {
    ...(contractId !== undefined ? { contractId } : {}),
    ...(scopeDeviceId !== undefined ? { deviceId: scopeDeviceId } : {}),
    ...(associationId !== undefined ? { associationId } : {}),
  };
}

export async function resolveLicenseScope(
  client: DbClient,
  actor: ActorContext,
  scope: LicenseScopeInput,
  at: Date,
): Promise<LicenseScopeView> {
  const contract =
    scope.contractId === undefined
      ? null
      : await client.contract.findFirst({
          where: {
            id: scope.contractId,
            ...(actor.actorType === 'customer' ? { customerId: actor.customerId ?? '' } : {}),
          },
          select: { id: true, customerId: true },
        });
  if (scope.contractId && !contract) throw licenseNotFound();
  const links = await client.contractDevice.findMany({
    where: {
      ...(contract ? { contractId: contract.id, customerId: contract.customerId } : {}),
      ...(scope.deviceId ? { deviceId: scope.deviceId } : {}),
      status: 'ACTIVE',
      validFrom: { lte: at },
      OR: [{ validTo: null }, { validTo: { gt: at } }],
      contract: { status: { in: ['EFFECTIVE', 'EXPIRING_SOON'] }, startAt: { lte: at }, endAt: { gt: at } },
    },
    select: {
      id: true,
      contractId: true,
      deviceId: true,
      customerId: true,
      contract: { select: { customerId: true } },
    },
  });
  const ids = scope.deviceId ? [scope.deviceId] : links.map(({ deviceId }) => deviceId);
  const rows =
    ids.length === 0
      ? []
      : await client.device.findMany({
          where: {
            id: { in: ids },
            ...(contract ? { customerId: contract.customerId } : {}),
            ...(actor.actorType === 'customer' ? { customerId: actor.customerId ?? '' } : {}),
          },
          select: { id: true, customerId: true, alias: true, serialNumber: true, lifecycleStatus: true },
          orderBy: { id: 'asc' },
        });
  let contractId = contract?.id ?? null;
  const devices: LicenseScopeDevice[] = [];
  for (const row of rows) {
    if (!row.customerId) continue;
    const link = links.find(
      (item) =>
        item.deviceId === row.id && item.customerId === row.customerId && item.contract.customerId === row.customerId,
    );
    if (contract && !link) continue;
    contractId ??= link?.contractId ?? null;
    devices.push({
      deviceId: row.id,
      customerId: row.customerId,
      associationId: link?.id ?? null,
      label: row.alias ?? row.serialNumber,
      canCreate: row.lifecycleStatus !== 'Retired',
    });
  }
  if (scope.deviceId && devices.length !== 1) throw licenseNotFound();
  if (scope.associationId !== undefined && devices[0]?.associationId !== scope.associationId) {
    throw licenseConflict('The contract association changed; refresh and retry');
  }
  return { contractId, devices };
}

export async function assertLicenseScope(
  client: DbClient,
  actor: ActorContext,
  scope: LicenseScopeInput | undefined,
  subject: { deviceId: string; customerId: string },
  at: Date,
  write = false,
): Promise<void> {
  if (!scope) return;
  if (scope.deviceId && scope.deviceId !== subject.deviceId) throw licenseNotFound();
  if (write) {
    if (scope.deviceId === undefined || (scope.contractId !== undefined && scope.associationId === undefined)) {
      throw licenseValidationFailed('The device and current contract association are required for this operation');
    }
    await client.$queryRaw`SELECT id FROM devices WHERE id = ${subject.deviceId} FOR UPDATE`;
    // Contract state changes and device association changes serialize with this check.
    await client.$queryRaw`SELECT id FROM contracts WHERE id IN (
      SELECT contract_id FROM contract_devices WHERE device_id = ${subject.deviceId} AND status = 'ACTIVE'
    ) ORDER BY id FOR UPDATE`;
  }
  const resolved = await resolveLicenseScope(client, actor, { ...scope, deviceId: subject.deviceId }, at);
  if (resolved.devices[0]?.customerId !== subject.customerId) throw licenseNotFound();
  if (resolved.contractId !== (scope.contractId ?? null)) {
    throw licenseConflict('The device now has a contract association; reopen the license workbench');
  }
}
