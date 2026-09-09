import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';

export const OTA_DISPATCH_LEASE_MS = 60_000;

export interface ClaimedOtaDispatch {
  readonly target: {
    readonly id: string;
    readonly campaignId: string;
    readonly deviceId: string;
    readonly batchNo: number;
    readonly scheduledTime: Date | null;
    readonly dispatchAttemptNo: number;
  };
  readonly pkg: {
    readonly id: string;
    readonly version: string;
    readonly packageType: string;
    readonly sha256: string;
    readonly s3Key: string;
  };
  readonly customerId: string;
  readonly leaseToken: string;
  readonly downloadToken: string;
  readonly downloadTokenHash: string;
  readonly downloadExpiresAt: Date;
}

type Delegate = {
  findFirst(args: { where: Record<string, unknown> }): Promise<unknown>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
};

const delegate = (client: DbClient, name: string): Delegate =>
  (client as unknown as Record<string, unknown>)[name] as Delegate;

export function hashOtaDownloadToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** DEC-016 归档 customerId：优先设备归属，兼容取有效 License 所属。 */
export async function resolveOtaArchiveCustomerId(client: DbClient, deviceId: string): Promise<string> {
  const device = (await delegate(client, 'device').findFirst({ where: { id: deviceId } })) as {
    customerId: string | null;
  } | null;
  if (device?.customerId) return device.customerId;
  const license = (await delegate(client, 'license').findFirst({
    where: { deviceId, status: { in: ['Active', 'ExpiringSoon'] } },
  })) as { customerId: string } | null;
  if (!license) throw new Error(`Cannot resolve archive customerId for device ${deviceId}`);
  return license.customerId;
}

export function buildOtaDownloadGrantUrl(baseUrl: string, targetId: string, token: string): string {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (base.protocol !== 'https:' && base.hostname !== 'localhost') {
    throw new Error('OTA download grant base URL must use HTTPS');
  }
  const url = new URL(`api/v1/device/ota/targets/${encodeURIComponent(targetId)}/download`, base);
  url.searchParams.set('token', token);
  return url.toString();
}

/** 原子领取 PENDING target，并创建只保存哈希的一次性、设备/target/package 绑定下载授权。 */
export async function claimOtaDispatch(
  client: DbClient,
  input: {
    readonly targetId: string;
    readonly now: Date;
    readonly downloadExpiresAt: Date;
    readonly leaseMs?: number;
    readonly leaseToken?: string;
    readonly downloadToken?: string;
  },
): Promise<ClaimedOtaDispatch | null> {
  const leaseToken = input.leaseToken ?? randomUUID();
  const downloadToken = input.downloadToken ?? randomBytes(32).toString('base64url');
  const downloadTokenHash = hashOtaDownloadToken(downloadToken);
  const leaseUntil = new Date(input.now.getTime() + (input.leaseMs ?? OTA_DISPATCH_LEASE_MS));

  return withTransaction(client, async (tx) => {
    const target = (await delegate(tx, 'otaTarget').findFirst({ where: { id: input.targetId } })) as {
      id: string;
      campaignId: string;
      deviceId: string;
      batchNo: number;
      status: string;
      scheduledTime: Date | null;
      dispatchAttemptCount: number;
    } | null;
    if (!target || target.status !== 'PENDING') return null;
    if (target.scheduledTime && target.scheduledTime.getTime() > input.now.getTime()) return null;

    const campaign = (await delegate(tx, 'otaCampaign').findFirst({ where: { id: target.campaignId } })) as {
      packageId: string;
      targetModel: string;
      status: string;
    } | null;
    if (!campaign || campaign.status !== 'RUNNING') return null;
    const pkg = (await delegate(tx, 'firmwarePackage').findFirst({ where: { id: campaign.packageId } })) as {
      id: string;
      model: string;
      version: string;
      packageType: string;
      sha256: string;
      s3Key: string;
      status: string;
    } | null;
    if (!pkg || pkg.status !== 'VERIFIED' || pkg.model !== campaign.targetModel) return null;
    const device = (await delegate(tx, 'device').findFirst({ where: { id: target.deviceId } })) as {
      customerId: string | null;
      model: string;
      lifecycleStatus: string;
    } | null;
    if (
      !device?.customerId ||
      device.model !== campaign.targetModel ||
      !['Active', 'Maintenance'].includes(device.lifecycleStatus)
    ) {
      return null;
    }
    const license = await delegate(tx, 'license').findFirst({
      where: {
        deviceId: target.deviceId,
        customerId: device.customerId,
        status: { in: ['Active', 'ExpiringSoon'] },
        validFrom: { lte: input.now },
        validTo: { gte: input.now },
        entitlements: { some: { code: 'OTA_UPDATE', enabled: true } },
      },
    });
    if (!license) return null;

    const claimed = await delegate(tx, 'otaTarget').updateMany({
      where: {
        id: target.id,
        status: 'PENDING',
        OR: [{ dispatchLeaseUntil: null }, { dispatchLeaseUntil: { lte: input.now } }],
      },
      data: {
        dispatchClaimedAt: input.now,
        dispatchLeaseUntil: leaseUntil,
        dispatchLeaseToken: leaseToken,
        dispatchAttemptCount: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return null;

    await delegate(tx, 'otaDownloadGrant').updateMany({
      where: { targetId: target.id, usedAt: null, revokedAt: null },
      data: { revokedAt: input.now },
    });
    await delegate(tx, 'otaDownloadGrant').create({
      data: {
        id: randomUUID(),
        tokenHash: downloadTokenHash,
        targetId: target.id,
        deviceId: target.deviceId,
        packageId: pkg.id,
        expiresAt: input.downloadExpiresAt,
        createdAt: input.now,
      },
    });
    return {
      target: {
        id: target.id,
        campaignId: target.campaignId,
        deviceId: target.deviceId,
        batchNo: target.batchNo,
        scheduledTime: target.scheduledTime,
        dispatchAttemptNo: target.dispatchAttemptCount + 1,
      },
      pkg: {
        id: pkg.id,
        version: pkg.version,
        packageType: pkg.packageType,
        sha256: pkg.sha256,
        s3Key: pkg.s3Key,
      },
      customerId: device.customerId,
      leaseToken,
      downloadToken,
      downloadTokenHash,
      downloadExpiresAt: input.downloadExpiresAt,
    };
  });
}

/** MQTT 前最后一次读取权威状态；暂停/取消或 lease 被回收即失败关闭。 */
export async function revalidateOtaDispatch(client: DbClient, claim: ClaimedOtaDispatch, now: Date): Promise<boolean> {
  const target = (await delegate(client, 'otaTarget').findFirst({
    where: { id: claim.target.id, status: 'PENDING', dispatchLeaseToken: claim.leaseToken },
  })) as { dispatchLeaseUntil: Date | null } | null;
  if (!target?.dispatchLeaseUntil || target.dispatchLeaseUntil.getTime() <= now.getTime()) return false;
  const campaign = (await delegate(client, 'otaCampaign').findFirst({
    where: { id: claim.target.campaignId },
  })) as { packageId: string; status: string } | null;
  if (!campaign || campaign.status !== 'RUNNING' || campaign.packageId !== claim.pkg.id) return false;
  const pkg = (await delegate(client, 'firmwarePackage').findFirst({ where: { id: claim.pkg.id } })) as {
    status: string;
  } | null;
  const device = (await delegate(client, 'device').findFirst({ where: { id: claim.target.deviceId } })) as {
    lifecycleStatus: string;
  } | null;
  const grant = (await delegate(client, 'otaDownloadGrant').findFirst({
    where: { tokenHash: claim.downloadTokenHash },
  })) as { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date } | null;
  return (
    pkg?.status === 'VERIFIED' &&
    !!device &&
    ['Active', 'Maintenance'].includes(device.lifecycleStatus) &&
    !!grant &&
    grant.usedAt === null &&
    grant.revokedAt === null &&
    grant.expiresAt.getTime() > now.getTime()
  );
}

export async function releaseOtaDispatch(client: DbClient, claim: ClaimedOtaDispatch, now: Date): Promise<void> {
  await withTransaction(client, async (tx) => {
    await delegate(tx, 'otaDownloadGrant').updateMany({
      where: { tokenHash: claim.downloadTokenHash, usedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    await delegate(tx, 'otaTarget').updateMany({
      where: { id: claim.target.id, status: 'PENDING', dispatchLeaseToken: claim.leaseToken },
      data: { dispatchClaimedAt: null, dispatchLeaseUntil: null, dispatchLeaseToken: null },
    });
  });
}

/** 状态、历史、两个 Outbox 与审计在同一事务提交，并验证 lease 所有权。 */
export async function finalizeOtaDispatch(client: DbClient, claim: ClaimedOtaDispatch, now: Date): Promise<boolean> {
  return withTransaction(client, async (tx) => {
    const campaign = (await delegate(tx, 'otaCampaign').findFirst({ where: { id: claim.target.campaignId } })) as {
      status: string;
      packageId: string;
    } | null;
    if (!campaign || campaign.status !== 'RUNNING' || campaign.packageId !== claim.pkg.id) return false;
    const updated = await delegate(tx, 'otaTarget').updateMany({
      where: { id: claim.target.id, status: 'PENDING', dispatchLeaseToken: claim.leaseToken },
      data: {
        status: 'NOTIFIED',
        dispatchClaimedAt: null,
        dispatchLeaseUntil: null,
        dispatchLeaseToken: null,
        updatedAt: now,
      },
    });
    if (updated.count !== 1) return false;
    await delegate(tx, 'otaStatusHistory').create({
      data: {
        id: randomUUID(),
        targetId: claim.target.id,
        fromStatus: 'PENDING',
        toStatus: 'NOTIFIED',
        detail: { reason: 'ota payload published', batchNo: claim.target.batchNo },
        createdAt: now,
      },
    });
    await delegate(tx, 'outboxEvent').create({
      data: {
        eventType: 'OTA_AVAILABLE',
        aggregateType: 'ota_target',
        aggregateId: claim.target.id,
        idempotencyKey: `ota-target:${claim.target.id}:dispatch:${claim.target.dispatchAttemptNo}:available`,
        payload: {
          topic: `bnx/device/${claim.target.deviceId}/notification`,
          data: { type: 'OTA_AVAILABLE', action: 'AWAIT_OTA_MESSAGE' },
          otaTargetId: claim.target.id,
        },
      },
    });
    await delegate(tx, 'outboxEvent').create({
      data: {
        eventType: 'ARCHIVE',
        aggregateType: 'ota_target',
        aggregateId: claim.target.id,
        idempotencyKey: `ota-target:${claim.target.id}:dispatch:${claim.target.dispatchAttemptNo}:publication`,
        payload: {
          archiveClass: 'OPERATION_RECORD',
          envelopeVersion: '1.0',
          operationType: 'ota',
          recordType: 'PUBLICATION',
          aggregateId: claim.target.id,
          customerId: claim.customerId,
          deviceId: claim.target.deviceId,
          occurredAt: now.toISOString(),
          data: {
            campaignId: claim.target.campaignId,
            packageId: claim.pkg.id,
            version: claim.pkg.version,
            packageType: claim.pkg.packageType,
            sha256: claim.pkg.sha256,
            batchNo: claim.target.batchNo,
            urlExpiresAt: claim.downloadExpiresAt.toISOString(),
          },
        },
      },
    });
    await recordAudit(tx, {
      objectType: 'ota_target',
      objectId: claim.target.id,
      action: 'ota.target.publish',
      result: 'SUCCESS',
      actorId: 'system:ota-dispatcher',
      customerId: claim.customerId,
      reason: 'PENDING → NOTIFIED',
      afterValue: { status: 'NOTIFIED', dispatchAttempt: true },
    });
    return true;
  });
}
