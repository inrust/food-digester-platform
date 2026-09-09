/**
 * BE-OTA-03 OTA MQTT 下发发布器（框架无关；注入式端口，无 AWS 依赖——部署层接 IoT Data Plane 与 S3 presign）。
 *
 * 事实源与规则：
 * - Topic：CT-03 topic-catalog `bnx/device/{deviceId}/ota`（downlink，QoS 1）；通知经 Outbox
 *   `bnx/device/{deviceId}/notification`（OTA_AVAILABLE，deviceAction=AWAIT_OTA_MESSAGE）；
 * - Payload：CT-03 ota.schema.json（meta+data：version/packageType/downloadUrl/sha256/mandatory/
 *   scheduledTime）；meta.id = otaTargetId（DEC-006 幂等键，重发稳定去重）；
 * - 下载 URL：15 分钟（900s）一次性 grant URL，经 Device mTLS API 校验
 *   deviceId+otaTargetId+packageId+expiry+unused/revoked 后才兑换短期 S3 URL；数据库只存 token hash；
 * - 下发范围：仅 RUNNING Campaign 的 PENDING 且到期（scheduledTime ≤ now）target——
 *   暂停/取消后不得产生新下发；包必须仍为 VERIFIED；Retired 设备跳过；
 * - DEC-016：每次成功下发写 OPERATION_RECORD/PUBLICATION 归档记录（Outbox，eventType=ARCHIVE，
 *   operations/operation_type=ota/record_type=publication 前缀由 BE-ARC 消费）；
 * - 并发：target 先以条件更新领取 lease，发布前重读 Campaign/target/package/device/grant；
 *   MQTT 成功后由 lease owner 在同一事务写 target+history+notification/publication Outbox；
 * - 功能边界：不实现设备端下载和安装；OTA_CANCELLED 由 BE-OTA-02 取消流程经 Outbox 发出。
 */
import type { DbClient } from '@fdp/database';
import { otaCampaignNotFound } from '../admin/ota-campaign/errors.js';
import type { OtaCampaignDeps } from '../admin/ota-campaign/service.js';
import {
  buildOtaDownloadGrantUrl,
  claimOtaDispatch,
  finalizeOtaDispatch,
  releaseOtaDispatch,
  revalidateOtaDispatch,
} from './dispatch-store.js';

// ---------- CT-03 常量 ----------

/** OTA 下载预签名 URL 有效期（秒）：15 分钟。 */
export const OTA_DOWNLOAD_URL_TTL_SECONDS = 900 as const;

/** OTA 下发 Topic（CT-03：bnx/device/{deviceId}/ota，downlink）。 */
export function otaTopicOf(deviceId: string): string {
  return `bnx/device/${deviceId}/ota`;
}

/** 通知 Topic（CT-03：bnx/device/{deviceId}/notification）。 */
export function otaNotificationTopicOf(deviceId: string): string {
  return `bnx/device/${deviceId}/notification`;
}

/** OTA 下发 AWS 有效 QoS（CT-03 topic-catalog：ota specified 1 / AWS 有效 1）。 */
export const OTA_PUBLISH_QOS = 1 as const;

/** CT-04 通知类型与设备动作（notification-catalog.json）。 */
export const OTA_AVAILABLE_NOTIFICATION = 'OTA_AVAILABLE' as const;
export const OTA_AVAILABLE_ACTION = 'AWAIT_OTA_MESSAGE' as const;
export const OTA_CANCELLED_NOTIFICATION = 'OTA_CANCELLED' as const;
export const OTA_CANCELLED_ACTION = 'CANCEL_PENDING_OTA' as const;

// ---------- 注入端口（部署层接 AWS IoT Data Plane / S3 presign） ----------

export interface OtaMqttPublisher {
  publish(input: {
    readonly topic: string;
    readonly payload: string;
    readonly qos: 1;
  }): Promise<void | { readonly providerMessageId?: string }>;
}

export interface OtaPublisherDeps extends OtaCampaignDeps {
  readonly mqtt: OtaMqttPublisher;
  /** Device mTLS API 公网基址；消息中只放一次性 grant URL，不放 S3 bearer URL。 */
  readonly downloadGrantBaseUrl: string;
  readonly downloadUrlTtlSeconds?: number;
  readonly dispatchLeaseMs?: number;
  readonly newLeaseToken?: () => string;
  readonly newDownloadToken?: () => string;
  /** 测试/可观测钩子：claim 已提交、MQTT 前执行；不得改变生产业务语义。 */
  readonly afterClaim?: (targetId: string) => Promise<void>;
}

// ---------- 行类型与数据访问 ----------

interface CampaignRow {
  readonly id: string;
  readonly packageId: string;
  readonly targetModel: string;
  readonly status: string;
}

interface PackageRow {
  readonly id: string;
  readonly version: string;
  readonly packageType: string;
  readonly sha256: string;
  readonly s3Key: string;
  readonly status: string;
}

interface TargetRow {
  readonly id: string;
  readonly campaignId: string;
  readonly deviceId: string;
  readonly batchNo: number;
  readonly status: string;
  readonly scheduledTime: Date | null;
}

function table(client: DbClient, name: string) {
  return (client as unknown as Record<string, unknown>)[name] as {
    findFirst(args: { where: Record<string, unknown> }): Promise<never>;
    findMany(args: Record<string, unknown>): Promise<never[]>;
  };
}

const campaigns = (c: DbClient) => table(c, 'otaCampaign');
const packages = (c: DbClient) => table(c, 'firmwarePackage');
const targetsOf = (c: DbClient) => table(c, 'otaTarget');

// ---------- Payload 序列化（ota.schema.json：meta+data） ----------

export interface OtaPayloadInput {
  readonly targetId: string;
  readonly version: string;
  readonly packageType: string;
  readonly downloadUrl: string;
  readonly sha256: string;
  readonly mandatory: boolean;
  readonly scheduledTime: Date | null;
  readonly at: Date;
}

/**
 * OTA 下行消息幂等键（DEC-006）：由 otaTargetId 确定性派生（重投稳定去重）。
 * CT-03 common.schema.json metaBase 要求大写字母数字与连字符。
 */
export function otaMessageIdOf(targetId: string): string {
  return `OTA-${targetId.toUpperCase()}`;
}

/** 构造 OTA 下发 Payload（CT-03 ota.schema.json；meta.id 由 otaTargetId 派生幂等键）。 */
export function buildOtaPayload(input: OtaPayloadInput): string {
  return JSON.stringify({
    meta: { id: otaMessageIdOf(input.targetId), ts: input.at.toISOString() },
    data: {
      version: input.version,
      packageType: input.packageType,
      downloadUrl: input.downloadUrl,
      sha256: input.sha256,
      mandatory: input.mandatory,
      ...(input.scheduledTime ? { scheduledTime: input.scheduledTime.toISOString() } : {}),
    },
  });
}

// ---------- 下发 ----------

export interface OtaTargetDispatchResult {
  readonly targetId: string;
  readonly deviceId: string;
  /** NOTIFIED=本次成功下发；FAILED=发布失败（保持 PENDING 待下次调度）；SKIPPED=不满足下发条件 */
  readonly status: 'NOTIFIED' | 'FAILED' | 'SKIPPED';
  readonly reason?: string;
}

export interface OtaDispatchResult {
  readonly campaignId: string;
  readonly publishedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
  readonly results: readonly OtaTargetDispatchResult[];
}

async function publishTarget(deps: OtaPublisherDeps, target: TargetRow, now: Date): Promise<OtaTargetDispatchResult> {
  const ttl = deps.downloadUrlTtlSeconds ?? OTA_DOWNLOAD_URL_TTL_SECONDS;
  const urlExpiresAt = new Date(now.getTime() + ttl * 1000);
  const claim = await claimOtaDispatch(deps.client, {
    targetId: target.id,
    now,
    downloadExpiresAt: urlExpiresAt,
    ...(deps.dispatchLeaseMs !== undefined ? { leaseMs: deps.dispatchLeaseMs } : {}),
    ...(deps.newLeaseToken ? { leaseToken: deps.newLeaseToken() } : {}),
    ...(deps.newDownloadToken ? { downloadToken: deps.newDownloadToken() } : {}),
  });
  if (!claim) {
    return { targetId: target.id, deviceId: target.deviceId, status: 'SKIPPED', reason: 'NOT_CLAIMED' };
  }
  const downloadUrl = buildOtaDownloadGrantUrl(deps.downloadGrantBaseUrl, target.id, claim.downloadToken);
  const payload = buildOtaPayload({
    targetId: target.id,
    version: claim.pkg.version,
    packageType: claim.pkg.packageType,
    downloadUrl,
    sha256: claim.pkg.sha256,
    mandatory: false, // 试运营禁止默认全量强制升级
    scheduledTime: target.scheduledTime,
    at: now,
  });

  await deps.afterClaim?.(target.id);
  if (!(await revalidateOtaDispatch(deps.client, claim, now))) {
    await releaseOtaDispatch(deps.client, claim, now);
    return { targetId: target.id, deviceId: target.deviceId, status: 'SKIPPED', reason: 'STATE_CHANGED' };
  }
  try {
    await deps.mqtt.publish({ topic: otaTopicOf(target.deviceId), payload, qos: OTA_PUBLISH_QOS });
  } catch {
    await releaseOtaDispatch(deps.client, claim, now);
    return { targetId: target.id, deviceId: target.deviceId, status: 'FAILED', reason: 'MQTT_PUBLISH_FAILED' };
  }
  if (!(await finalizeOtaDispatch(deps.client, claim, now))) {
    await releaseOtaDispatch(deps.client, claim, now);
    return { targetId: target.id, deviceId: target.deviceId, status: 'SKIPPED', reason: 'LEASE_OR_STATE_LOST' };
  }
  return { targetId: target.id, deviceId: target.deviceId, status: 'NOTIFIED' };
}

/**
 * 下发指定 Campaign 的待下发 target（仅 RUNNING + PENDING + scheduledTime 到期）。
 * 暂停/取消后不得产生新下发：非 RUNNING 直接返回空结果。
 */
export async function dispatchOtaCampaign(deps: OtaPublisherDeps, campaignId: string): Promise<OtaDispatchResult> {
  const now = deps.now?.() ?? new Date();
  const campaign = (await campaigns(deps.client).findFirst({
    where: { id: campaignId },
  })) as unknown as CampaignRow | null;
  if (!campaign) throw otaCampaignNotFound();
  if (campaign.status !== 'RUNNING') {
    return { campaignId, publishedCount: 0, failedCount: 0, skippedCount: 0, results: [] };
  }
  // 包必须仍为 VERIFIED（RETIRED 包不再下发）
  const pkg = (await packages(deps.client).findFirst({
    where: { id: campaign.packageId },
  })) as unknown as PackageRow | null;
  if (!pkg || pkg.status !== 'VERIFIED') {
    return { campaignId, publishedCount: 0, failedCount: 0, skippedCount: 0, results: [] };
  }
  const pending = (await targetsOf(deps.client).findMany({
    where: { campaignId, status: 'PENDING' },
  })) as unknown as TargetRow[];

  const results: OtaTargetDispatchResult[] = [];
  for (const target of pending) {
    if (target.scheduledTime && target.scheduledTime.getTime() > now.getTime()) {
      results.push({ targetId: target.id, deviceId: target.deviceId, status: 'SKIPPED', reason: 'NOT_DUE' });
      continue;
    }
    results.push(await publishTarget(deps, target, now));
  }
  return {
    campaignId,
    publishedCount: results.filter((r) => r.status === 'NOTIFIED').length,
    failedCount: results.filter((r) => r.status === 'FAILED').length,
    skippedCount: results.filter((r) => r.status === 'SKIPPED').length,
    results,
  };
}

/** 调度全部 RUNNING Campaign 的待下发 target（部署层定时器/事件触发入口）。 */
export async function dispatchPendingOtaTargets(deps: OtaPublisherDeps): Promise<OtaDispatchResult[]> {
  const running = (await campaigns(deps.client).findMany({
    where: { status: 'RUNNING' },
  })) as unknown as CampaignRow[];
  const out: OtaDispatchResult[] = [];
  for (const campaign of running) {
    out.push(await dispatchOtaCampaign(deps, campaign.id));
  }
  return out;
}
