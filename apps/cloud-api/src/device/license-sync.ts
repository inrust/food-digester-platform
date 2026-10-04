import { createHash } from 'node:crypto';
import { recordAudit, withTransaction, type DbClient } from '@fdp/database';
import { transitionLifecycle, type LifecycleStatus, type OperationalStatus } from '@fdp/domain';
import type { DeviceAuthContext } from '@fdp/auth';
import { DeviceSyncError, type DeviceSyncSnapshot, type LicenseConfirmation } from './sync.js';
import { EFFECTIVE_LICENSE_STATUSES } from '../admin/customer/repository.js';

/** A device must confirm a recent, actually served snapshot; lastSyncTime alone proves neither receipt nor verification. */
export const LICENSE_CONFIRMATION_MAX_AGE_SECONDS = 86400;
const SERVED = 'device.license.snapshot-served';
const RECEIVED = 'device.license.received';
const VERIFIED = 'device.license.verified';
interface Deps {
  readonly client: DbClient;
  readonly now?: () => Date;
}
const conflict = () => new DeviceSyncError('CONFLICT', 'The license confirmation is no longer applicable');
const digest = (signature: string) => createHash('sha256').update(signature).digest('hex');

async function lockedFacts(tx: DbClient, auth: DeviceAuthContext, licenseId: string, now: Date) {
  await tx.$queryRawUnsafe('SELECT id FROM devices WHERE id=$1 FOR UPDATE', auth.deviceId);
  await tx.$queryRawUnsafe(
    'SELECT id FROM device_certificates WHERE device_id=$1 AND fingerprint=$2 FOR UPDATE',
    auth.deviceId,
    auth.certificateFingerprint,
  );
  await tx.$queryRawUnsafe(
    "SELECT id FROM device_assignments WHERE device_id=$1 AND status='ACTIVE' FOR UPDATE",
    auth.deviceId,
  );
  await tx.$queryRawUnsafe('SELECT id FROM licenses WHERE id=$1 AND device_id=$2 FOR UPDATE', licenseId, auth.deviceId);
  const device = await tx.device.findFirst({ where: { id: auth.deviceId } });
  const license = await tx.license.findFirst({ where: { id: licenseId, deviceId: auth.deviceId } });
  const assignment = await tx.deviceAssignment.findFirst({
    where: {
      deviceId: auth.deviceId,
      status: 'ACTIVE',
      assignedAt: { lte: now },
      OR: [{ endedAt: null }, { endedAt: { gt: now } }],
    },
  });
  const certificate = await tx.deviceCertificate.findFirst({
    where: {
      deviceId: auth.deviceId,
      fingerprint: auth.certificateFingerprint,
      status: 'ACTIVE',
      notBefore: { lte: now },
      notAfter: { gt: now },
    },
  });
  if (
    !device ||
    !license ||
    !assignment ||
    !certificate ||
    device.customerId !== auth.customerId ||
    assignment.customerId !== device.customerId ||
    assignment.siteId !== device.siteId ||
    license.customerId !== device.customerId ||
    !['Assigned', 'Licensed', 'Active'].includes(device.lifecycleStatus) ||
    !license.signature ||
    !(EFFECTIVE_LICENSE_STATUSES as readonly string[]).includes(license.status) ||
    license.validFrom > now ||
    license.validTo <= now
  )
    throw conflict();
  return { device, license, assignment };
}
function binding(auth: DeviceAuthContext, facts: Awaited<ReturnType<typeof lockedFacts>>, etag: string) {
  return {
    deviceId: auth.deviceId,
    licenseId: facts.license.id,
    version: facts.license.version,
    snapshotEtag: etag,
    certificateFingerprint: auth.certificateFingerprint,
    signatureDigest: digest(facts.license.signature!),
    assignmentId: facts.assignment.id,
    customerId: facts.assignment.customerId,
    siteId: facts.assignment.siteId,
  };
}
async function receipt(tx: DbClient, action: string, expected: ReturnType<typeof binding>) {
  return tx.auditLog.findFirst({
    where: {
      objectType: 'license',
      objectId: expected.licenseId,
      action,
      result: 'SUCCESS',
      AND: Object.entries(expected).map(([key, value]) => ({ afterValue: { path: [key], equals: value } })),
    },
    orderBy: { createdAt: 'desc' },
  });
}
function recent(row: Awaited<ReturnType<typeof receipt>>, now: Date) {
  const servedAt = (row?.afterValue as { servedAt?: string } | null)?.servedAt;
  const time = typeof servedAt === 'string' ? Date.parse(servedAt) : NaN;
  return (
    Number.isFinite(time) &&
    time <= now.getTime() &&
    now.getTime() - time <= LICENSE_CONFIRMATION_MAX_AGE_SECONDS * 1000
  );
}

/** Durable binding in existing append-only audit storage; device row lock makes repeated serves/confirmations idempotent. */
export async function recordLicenseSnapshotServed(
  deps: Deps,
  auth: DeviceAuthContext,
  snapshot: DeviceSyncSnapshot,
  requestId: string,
): Promise<void> {
  if (
    !snapshot.license?.effective ||
    !snapshot.license.signature ||
    !snapshot.assignment ||
    !['Assigned', 'Licensed', 'Active'].includes(snapshot.operationalStatus.lifecycleStatus)
  )
    return;
  const now = deps.now?.() ?? new Date();
  await withTransaction(deps.client, async (tx) => {
    const facts = await lockedFacts(tx, auth, snapshot.license!.licenseId, now);
    if (
      facts.license.version !== snapshot.license!.version ||
      digest(facts.license.signature!) !== digest(snapshot.license!.signature!) ||
      facts.assignment.id !== snapshot.assignment!.assignmentId ||
      facts.device.lifecycleStatus !== snapshot.operationalStatus.lifecycleStatus
    )
      throw conflict();
    const expected = binding(auth, facts, snapshot.etag);
    if (recent(await receipt(tx, SERVED, expected), now)) return;
    await recordAudit(tx, {
      objectType: 'license',
      objectId: facts.license.id,
      action: SERVED,
      result: 'SUCCESS',
      actorId: auth.deviceId,
      actorRole: 'DEVICE',
      customerId: facts.device.customerId,
      requestId,
      afterValue: { ...expected, servedAt: now.toISOString() },
    });
  });
}

export async function confirmLicenseSnapshot(
  deps: Deps,
  auth: DeviceAuthContext,
  confirmation: LicenseConfirmation,
  requestId: string,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await withTransaction(deps.client, async (tx) => {
    const facts = await lockedFacts(tx, auth, confirmation.licenseId, now);
    if (facts.license.version !== confirmation.version) throw conflict();
    const expected = binding(auth, facts, confirmation.snapshotEtag);
    if (!recent(await receipt(tx, SERVED, expected), now)) throw conflict();
    const action = confirmation.status === 'RECEIVED' ? RECEIVED : VERIFIED;
    if (
      confirmation.status === 'VERIFIED' &&
      (!['Licensed', 'Active'].includes(facts.device.lifecycleStatus) ||
        !recent(await receipt(tx, RECEIVED, expected), now))
    )
      throw conflict();
    if (recent(await receipt(tx, action, expected), now)) return;
    const from = facts.device.lifecycleStatus as LifecycleStatus;
    const to =
      confirmation.status === 'RECEIVED' && from === 'Assigned'
        ? 'Licensed'
        : confirmation.status === 'VERIFIED' && from === 'Licensed'
          ? 'Active'
          : null;
    if (to) {
      const latest = await tx.deviceLatestState.findFirst({ where: { deviceId: auth.deviceId } });
      const actor =
        to === 'Licensed'
          ? { actorType: 'SYSTEM' as const, actorId: 'system:license-sync' }
          : { actorType: 'DEVICE' as const, actorId: auth.deviceId };
      const effects = transitionLifecycle(
        {
          id: auth.deviceId,
          lifecycleStatus: from,
          operationalStatus: (latest?.operationalStatus ?? null) as OperationalStatus | null,
        },
        to,
        actor,
        to === 'Licensed' ? { licenseIssuedAndSynced: true } : { licenseVerifiedByDevice: true },
      );
      const updated = await tx.device.updateMany({
        where: { id: auth.deviceId, lifecycleStatus: from },
        data: { lifecycleStatus: to },
      });
      if (updated.count !== 1) throw conflict();
      for (const entry of effects.stateHistory) await tx.deviceStateHistory.create({ data: { ...entry } });
      if (to === 'Active')
        await tx.deviceLatestState.upsert({
          where: { deviceId: auth.deviceId },
          create: { deviceId: auth.deviceId, customerId: facts.device.customerId, operationalStatus: 'Active' },
          update: { operationalStatus: 'Active' },
        });
      await recordAudit(tx, {
        objectType: 'device',
        objectId: auth.deviceId,
        action: effects.auditEvent.action,
        result: 'SUCCESS',
        actorId: actor.actorId,
        actorRole: actor.actorType,
        customerId: facts.device.customerId,
        requestId,
        beforeValue: { lifecycleStatus: from },
        afterValue: effects.auditEvent.afterValue,
      });
    }
    await recordAudit(tx, {
      objectType: 'license',
      objectId: facts.license.id,
      action,
      result: 'SUCCESS',
      actorId: auth.deviceId,
      actorRole: 'DEVICE',
      customerId: facts.device.customerId,
      requestId,
      afterValue: {
        ...expected,
        servedAt: now.toISOString(),
        confirmation: confirmation.status,
        lifecycleStatus: to ?? from,
      },
    });
  });
}
