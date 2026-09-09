/**
 * BE-OTA-02 OTA Campaign 状态机与领域服务（框架无关）。
 *
 * Campaign 状态机（DB-01 封闭集合）：创建即 RUNNING（首批随创建进入下发队列）；
 * RUNNING⇄PAUSED；RUNNING/PAUSED/DRAFT→CANCELLED（级联未完成 target → CANCELLED）；
 * 全部 target SUCCEEDED → 自动 COMPLETED（recordTargetStatus 内评估）。
 *
 * Target 状态机（DB-01 封闭集合）：PENDING → NOTIFIED → DOWNLOADING → INSTALLING →
 * SUCCEEDED/FAILED/ROLLED_BACK；FAILED →(retry)→ PENDING；CANCELLED 为终态。
 * 设备回报状态经 recordTargetStatus 推进（DEC-015：ACK 为唯一通道，BE-OTA-03 复用）。
 *
 * 规则：
 * - 首批强制恰好 1 台（灰度）；扩大批次仅 RUNNING；默认禁止一次选择该型号全部
 *   合格设备（试运营禁止默认全量强制升级，schema 注释对齐）；
 * - 设备资格：型号匹配 + 生命周期 Active/Maintenance（DEC-001 Maintenance 允许 OTA）+
 *   有效 License 且 OTA_UPDATE Entitlement enabled（沿用 BE-CMD-01 门模式）；
 * - 包必须 VERIFIED（坏包/未校验包不可建 Campaign，BE-OTA-01 保证可发布 = VERIFIED）；
 * - 暂停/取消后不得产生新下发：下发器（BE-OTA-03）只消费 RUNNING Campaign 的
 *   PENDING target；取消级联未完成 target → CANCELLED；
 * - 审计：Campaign 每次状态变化经 audited 写 audit_logs（DOM-03）；Target 每次
 *   状态变化写 ota_status_history（同事务）；
 * - 功能边界：不执行固件安装；MQTT 下发与 ACK 处理属 BE-OTA-03。
 */
import { randomUUID } from 'node:crypto';
import type { DbClient, Page } from '@fdp/database';
import { audited, decodeKeysetCursor, encodeKeysetCursor, normalizeLimit, recordAudit } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { otaCampaignConflict, otaCampaignNotFound, otaCampaignValidationFailed } from './errors.js';

// ---------- 封闭集合（DB-01 注释对齐） ----------

export const OTA_CAMPAIGN_STATUSES = ['DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'] as const;
export type OtaCampaignStatus = (typeof OTA_CAMPAIGN_STATUSES)[number];

export const OTA_TARGET_STATUSES = [
  'PENDING',
  'NOTIFIED',
  'DOWNLOADING',
  'INSTALLING',
  'SUCCEEDED',
  'FAILED',
  'ROLLED_BACK',
  'CANCELLED',
] as const;
export type OtaTargetStatus = (typeof OTA_TARGET_STATUSES)[number];

/** 可由暂停/取消阻断下发的未完成 target 状态。 */
const UNFINISHED_TARGET_STATUSES: readonly OtaTargetStatus[] = ['PENDING', 'NOTIFIED', 'DOWNLOADING', 'INSTALLING'];

/** Target 终态。 */
const TERMINAL_TARGET_STATUSES: readonly OtaTargetStatus[] = ['SUCCEEDED', 'ROLLED_BACK', 'CANCELLED'];

/** 设备回报允许的迁移（DEC-015 ACK 通道）；FAILED→PENDING 仅经 retry。 */
const TARGET_ALLOWED_TRANSITIONS: Readonly<Record<string, readonly OtaTargetStatus[]>> = {
  PENDING: ['NOTIFIED'],
  NOTIFIED: ['DOWNLOADING', 'FAILED'],
  DOWNLOADING: ['INSTALLING', 'FAILED'],
  INSTALLING: ['SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
  FAILED: [],
  SUCCEEDED: [],
  ROLLED_BACK: [],
  CANCELLED: [],
} as const;

/** OTA 资格生命周期（DEC-001：Maintenance 允许 OTA 下发）。 */
const OTA_ELIGIBLE_LIFECYCLES = ['Active', 'Maintenance'] as const;

/** OTA Entitlement 编码（与 DOM-02/DB 存储一致；REST 投影别名 OTA 见 CT 对齐测试）。 */
const OTA_ENTITLEMENT_CODE = 'OTA_UPDATE' as const;

/** 首批强制恰好 1 台（灰度）。 */
const FIRST_BATCH_SIZE = 1 as const;

/** 单次扩大批次设备数上限（暂定值）。 */
const MAX_BATCH_DEVICE_COUNT = 500 as const;

// ---------- 行类型与数据访问 ----------

interface FirmwarePackageRow {
  readonly id: string;
  readonly model: string;
  readonly status: string;
}

interface DeviceRow {
  readonly id: string;
  readonly model: string;
  readonly lifecycleStatus: string;
}

interface LicenseRow {
  readonly deviceId: string;
}

interface OtaCampaignRow {
  readonly id: string;
  readonly name: string;
  readonly packageId: string;
  readonly targetModel: string;
  readonly strategy: string;
  readonly status: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface OtaTargetRow {
  readonly id: string;
  readonly campaignId: string;
  readonly deviceId: string;
  readonly batchNo: number;
  readonly status: string;
  readonly scheduledTime: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface Delegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<never>;
  findMany(args: Record<string, unknown>): Promise<never[]>;
  create(args: { data: Record<string, unknown> }): Promise<never>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function table(client: DbClient, name: string): Delegate {
  return (client as unknown as Record<string, unknown>)[name] as Delegate;
}

const firmwarePackages = (c: DbClient) => table(c, 'firmwarePackage');
const devices = (c: DbClient) => table(c, 'device');
const licenses = (c: DbClient) => table(c, 'license');
const campaigns = (c: DbClient) => table(c, 'otaCampaign');
const targets = (c: DbClient) => table(c, 'otaTarget');
const targetHistory = (c: DbClient) => table(c, 'otaStatusHistory');
const downloadGrants = (c: DbClient) => table(c, 'otaDownloadGrant');

export interface OtaCampaignDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

// ---------- DTO ----------

export interface OtaCampaignView {
  readonly campaignId: string;
  readonly name: string;
  readonly packageId: string;
  readonly targetModel: string;
  readonly strategy: string;
  readonly status: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OtaCampaignDetailView extends OtaCampaignView {
  readonly targetCounts: Record<'total' | OtaTargetStatus, number>;
}

export interface OtaTargetView {
  readonly targetId: string;
  readonly campaignId: string;
  readonly deviceId: string;
  readonly batchNo: number;
  readonly status: string;
  readonly scheduledTime: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toCampaignView(row: OtaCampaignRow): OtaCampaignView {
  return {
    campaignId: row.id,
    name: row.name,
    packageId: row.packageId,
    targetModel: row.targetModel,
    strategy: row.strategy,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toTargetView(row: OtaTargetRow): OtaTargetView {
  return {
    targetId: row.id,
    campaignId: row.campaignId,
    deviceId: row.deviceId,
    batchNo: row.batchNo,
    status: row.status,
    scheduledTime: row.scheduledTime ? row.scheduledTime.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function campaignAuditEntry(
  actor: ActorContext,
  campaignId: string,
  action: string,
  reason: string,
  afterValue: (result: unknown) => Record<string, unknown>,
) {
  return {
    objectType: 'ota_campaign',
    objectId: campaignId,
    action,
    reason,
    actorId: actor.actorId,
    actorRole: actor.roles[0],
    customerId: null,
    afterValue,
  };
}

// ---------- 设备资格（型号 + 生命周期 + OTA Entitlement） ----------

/**
 * 设备资格门：型号匹配 + 生命周期 Active/Maintenance + 有效 License 且
 * OTA_UPDATE Entitlement enabled。任一不满足 → 400（消息不含敏感信息）。
 */
async function assertEligibleDevices(
  client: DbClient,
  targetModel: string,
  deviceIds: readonly string[],
  now: Date,
): Promise<void> {
  const rows = (await devices(client).findMany({ where: { id: { in: [...deviceIds] } } })) as unknown as DeviceRow[];
  const found = new Map(rows.map((d) => [d.id, d]));
  if (deviceIds.some((id) => !found.has(id))) {
    throw otaCampaignValidationFailed('Some deviceIds do not exist');
  }
  if (deviceIds.some((id) => found.get(id)?.model !== targetModel)) {
    throw otaCampaignValidationFailed('Some devices do not match the package target model');
  }
  if (
    deviceIds.some(
      (id) => !(OTA_ELIGIBLE_LIFECYCLES as readonly string[]).includes(found.get(id)?.lifecycleStatus ?? ''),
    )
  ) {
    throw otaCampaignValidationFailed('Some devices are not in an OTA-eligible lifecycle state (Active/Maintenance)');
  }
  const licensed = (await licenses(client).findMany({
    where: {
      deviceId: { in: [...deviceIds] },
      status: { in: ['Active', 'ExpiringSoon'] },
      validFrom: { lte: now },
      validTo: { gt: now },
      entitlements: { some: { code: OTA_ENTITLEMENT_CODE, enabled: true } },
    },
  })) as unknown as LicenseRow[];
  const licensedIds = new Set(licensed.map((l) => l.deviceId));
  if (deviceIds.some((id) => !licensedIds.has(id))) {
    throw otaCampaignValidationFailed('Some devices lack an effective license with OTA entitlement');
  }
}

/** 该型号全部合格设备（型号 + 生命周期 + Entitlement），用于"禁止全量"判定。 */
async function listEligibleDeviceIds(client: DbClient, targetModel: string, now: Date): Promise<Set<string>> {
  const rows = (await devices(client).findMany({
    where: { model: targetModel, lifecycleStatus: { in: [...OTA_ELIGIBLE_LIFECYCLES] } },
  })) as unknown as DeviceRow[];
  if (rows.length === 0) return new Set();
  const licensed = (await licenses(client).findMany({
    where: {
      deviceId: { in: rows.map((d) => d.id) },
      status: { in: ['Active', 'ExpiringSoon'] },
      validFrom: { lte: now },
      validTo: { gt: now },
      entitlements: { some: { code: OTA_ENTITLEMENT_CODE, enabled: true } },
    },
  })) as unknown as LicenseRow[];
  return new Set(licensed.map((l) => l.deviceId));
}

/** 默认禁止一次选择全部合格设备强制升级（单次选择或合并后覆盖全量均拒绝）。 */
function assertNotFullRollout(eligibleIds: Set<string>, selectedIds: ReadonlySet<string>): void {
  if (eligibleIds.size === 0) return;
  const coversAll = [...eligibleIds].every((id) => selectedIds.has(id));
  if (coversAll) {
    throw otaCampaignValidationFailed('Selecting all eligible devices for a forced rollout is forbidden by default');
  }
}

// ---------- 创建 Campaign（强制首批 1 台） ----------

export interface CreateOtaCampaignInput {
  readonly name: string;
  readonly packageId: string;
  /** 首批（灰度）设备；强制恰好 1 台。 */
  readonly deviceIds: readonly string[];
}

export async function createOtaCampaign(
  deps: OtaCampaignDeps,
  actor: ActorContext,
  input: CreateOtaCampaignInput,
): Promise<OtaCampaignView> {
  const now = deps.now?.() ?? new Date();
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0 || name.length > 128) {
    throw otaCampaignValidationFailed('name is required and must not exceed 128 characters');
  }
  if (typeof input.packageId !== 'string' || input.packageId.length === 0) {
    throw otaCampaignValidationFailed('packageId is required');
  }
  const deviceIds = [...new Set(input.deviceIds ?? [])];
  if (deviceIds.length !== FIRST_BATCH_SIZE) {
    throw otaCampaignValidationFailed('The first (canary) batch must contain exactly 1 device');
  }

  // 坏包/未校验包不可建 Campaign（BE-OTA-01：可发布 = VERIFIED）
  const pkg = (await firmwarePackages(deps.client).findFirst({
    where: { id: input.packageId },
  })) as unknown as FirmwarePackageRow | null;
  if (!pkg) throw otaCampaignNotFound();
  if (pkg.status !== 'VERIFIED') {
    throw otaCampaignValidationFailed('The firmware package is not VERIFIED');
  }
  await assertEligibleDevices(deps.client, pkg.model, deviceIds, now);

  const campaignId = randomUUID();
  const targetId = randomUUID();
  return audited<OtaCampaignView>(
    deps.client,
    campaignAuditEntry(
      actor,
      campaignId,
      'ota.campaign.create',
      `package=${input.packageId} model=${pkg.model}`,
      (v) => {
        const view = v as OtaCampaignView;
        return {
          campaignId: view.campaignId,
          status: view.status,
          targetModel: view.targetModel,
          packageId: view.packageId,
        };
      },
    ),
    async (tx) => {
      const campaign = (await campaigns(tx).create({
        data: {
          id: campaignId,
          name,
          packageId: input.packageId,
          targetModel: pkg.model,
          strategy: 'CANARY',
          status: 'RUNNING',
          createdBy: actor.actorId,
          createdAt: now,
          updatedAt: now,
        },
      })) as unknown as OtaCampaignRow;
      await targets(tx).create({
        data: {
          id: targetId,
          campaignId,
          deviceId: deviceIds[0],
          batchNo: 1,
          status: 'PENDING',
          createdAt: now,
          updatedAt: now,
        },
      });
      await targetHistory(tx).create({
        data: {
          id: randomUUID(),
          targetId,
          fromStatus: null,
          toStatus: 'PENDING',
          detail: { reason: 'campaign created (canary batch 1)' },
          createdAt: now,
        },
      });
      return toCampaignView(campaign);
    },
  );
}

// ---------- 扩大批次 ----------

export interface ExpandOtaBatchInput {
  readonly deviceIds: readonly string[];
}

export interface ExpandOtaBatchResult {
  readonly campaignId: string;
  readonly batchNo: number;
  readonly addedCount: number;
  readonly skippedExistingCount: number;
  readonly addedTargets: readonly OtaTargetView[];
}

export async function expandOtaCampaignBatch(
  deps: OtaCampaignDeps,
  actor: ActorContext,
  campaignId: string,
  input: ExpandOtaBatchInput,
): Promise<ExpandOtaBatchResult> {
  const now = deps.now?.() ?? new Date();
  const campaign = (await campaigns(deps.client).findFirst({
    where: { id: campaignId },
  })) as unknown as OtaCampaignRow | null;
  if (!campaign) throw otaCampaignNotFound();
  if (campaign.status !== 'RUNNING') {
    throw otaCampaignConflict(`The campaign is ${campaign.status}; only RUNNING campaigns can be expanded`);
  }
  const deviceIds = [...new Set(input.deviceIds ?? [])];
  if (deviceIds.length === 0 || deviceIds.length > MAX_BATCH_DEVICE_COUNT) {
    throw otaCampaignValidationFailed(`deviceIds must contain 1..${MAX_BATCH_DEVICE_COUNT} unique entries`);
  }

  // 默认禁止一次选择全部合格设备（单次选择或合并已有 target 后覆盖全量均拒绝）
  const eligible = await listEligibleDeviceIds(deps.client, campaign.targetModel, now);
  const existingTargets = (await targets(deps.client).findMany({
    where: { campaignId },
  })) as unknown as OtaTargetRow[];
  const existingDeviceIds = new Set(existingTargets.map((t) => t.deviceId));
  assertNotFullRollout(eligible, new Set(deviceIds));
  assertNotFullRollout(eligible, new Set([...existingDeviceIds, ...deviceIds]));

  await assertEligibleDevices(deps.client, campaign.targetModel, deviceIds, now);

  const toAdd = deviceIds.filter((id) => !existingDeviceIds.has(id));
  const skippedExistingCount = deviceIds.length - toAdd.length;
  const batchNo = existingTargets.reduce((max, t) => Math.max(max, t.batchNo), 0) + 1;

  return audited<ExpandOtaBatchResult>(
    deps.client,
    campaignAuditEntry(actor, campaignId, 'ota.campaign.expand', `batchNo=${batchNo} added=${toAdd.length}`, (r) => {
      const result = r as ExpandOtaBatchResult;
      return { campaignId, batchNo: result.batchNo, addedCount: result.addedCount };
    }),
    async (tx) => {
      const addedTargets: OtaTargetView[] = [];
      for (const deviceId of toAdd) {
        const targetId = randomUUID();
        const row = (await targets(tx).create({
          data: {
            id: targetId,
            campaignId,
            deviceId,
            batchNo,
            status: 'PENDING',
            createdAt: now,
            updatedAt: now,
          },
        })) as unknown as OtaTargetRow;
        await targetHistory(tx).create({
          data: {
            id: randomUUID(),
            targetId,
            fromStatus: null,
            toStatus: 'PENDING',
            detail: { reason: `batch ${batchNo} expansion` },
            createdAt: now,
          },
        });
        addedTargets.push(toTargetView(row));
      }
      return {
        campaignId,
        batchNo,
        addedCount: addedTargets.length,
        skippedExistingCount,
        addedTargets,
      };
    },
  );
}

// ---------- 暂停 / 恢复 ----------

async function transitionCampaign(
  deps: OtaCampaignDeps,
  actor: ActorContext,
  campaignId: string,
  from: OtaCampaignStatus,
  to: OtaCampaignStatus,
  action: string,
): Promise<OtaCampaignView> {
  const now = deps.now?.() ?? new Date();
  const campaign = (await campaigns(deps.client).findFirst({
    where: { id: campaignId },
  })) as unknown as OtaCampaignRow | null;
  if (!campaign) throw otaCampaignNotFound();
  if (campaign.status === to) return toCampaignView(campaign); // 幂等回放
  if (campaign.status !== from) {
    throw otaCampaignConflict(`The campaign is ${campaign.status}; only ${from} campaigns can transition to ${to}`);
  }
  return audited<OtaCampaignView>(
    deps.client,
    campaignAuditEntry(actor, campaignId, action, `${from} → ${to}`, (v) => {
      const view = v as OtaCampaignView;
      return { campaignId, status: view.status };
    }),
    async (tx) => {
      const claimed = await campaigns(tx).updateMany({
        where: { id: campaignId, status: from },
        data: { status: to, updatedAt: now },
      });
      if (claimed.count !== 1) {
        throw otaCampaignConflict('The campaign status changed concurrently');
      }
      if (to === 'PAUSED') {
        await targets(tx).updateMany({
          where: { campaignId, status: 'PENDING', dispatchLeaseToken: { not: null } },
          data: { dispatchClaimedAt: null, dispatchLeaseUntil: null, dispatchLeaseToken: null },
        });
        await downloadGrants(tx).updateMany({
          where: { target: { campaignId }, usedAt: null, revokedAt: null },
          data: { revokedAt: now },
        });
      }
      return { ...toCampaignView(campaign), status: to, updatedAt: now.toISOString() };
    },
  );
}

/** 暂停：RUNNING → PAUSED（暂停后不得产生新下发）。幂等：PAUSED 重复暂停回放。 */
export function pauseOtaCampaign(
  deps: OtaCampaignDeps,
  actor: ActorContext,
  campaignId: string,
): Promise<OtaCampaignView> {
  return transitionCampaign(deps, actor, campaignId, 'RUNNING', 'PAUSED', 'ota.campaign.pause');
}

/** 恢复：PAUSED → RUNNING。幂等：RUNNING 重复恢复回放。 */
export function resumeOtaCampaign(
  deps: OtaCampaignDeps,
  actor: ActorContext,
  campaignId: string,
): Promise<OtaCampaignView> {
  return transitionCampaign(deps, actor, campaignId, 'PAUSED', 'RUNNING', 'ota.campaign.resume');
}

// ---------- 取消（级联未完成 target → CANCELLED） ----------

export async function cancelOtaCampaign(
  deps: OtaCampaignDeps,
  actor: ActorContext,
  campaignId: string,
): Promise<OtaCampaignView> {
  const now = deps.now?.() ?? new Date();
  const campaign = (await campaigns(deps.client).findFirst({
    where: { id: campaignId },
  })) as unknown as OtaCampaignRow | null;
  if (!campaign) throw otaCampaignNotFound();
  if (campaign.status === 'CANCELLED') return toCampaignView(campaign); // 幂等回放
  if (campaign.status === 'COMPLETED') {
    throw otaCampaignConflict('The campaign is COMPLETED and cannot be cancelled');
  }
  return audited<OtaCampaignView>(
    deps.client,
    campaignAuditEntry(actor, campaignId, 'ota.campaign.cancel', `${campaign.status} → CANCELLED`, () => ({
      campaignId,
      status: 'CANCELLED',
    })),
    async (tx) => {
      const claimed = await campaigns(tx).updateMany({
        where: { id: campaignId, status: { in: ['DRAFT', 'RUNNING', 'PAUSED'] } },
        data: { status: 'CANCELLED', updatedAt: now },
      });
      if (claimed.count !== 1) {
        throw otaCampaignConflict('The campaign status changed concurrently');
      }
      // 级联：未完成 target → CANCELLED（取消后不得产生新下发；每台写状态历史）
      const unfinished = (await targets(tx).findMany({
        where: { campaignId, status: { in: [...UNFINISHED_TARGET_STATUSES] } },
      })) as unknown as OtaTargetRow[];
      const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as {
        create(args: { data: Record<string, unknown> }): Promise<unknown>;
      };
      for (const t of unfinished) {
        const updated = await targets(tx).updateMany({
          where: { id: t.id, status: t.status },
          data: {
            status: 'CANCELLED',
            dispatchClaimedAt: null,
            dispatchLeaseUntil: null,
            dispatchLeaseToken: null,
            updatedAt: now,
          },
        });
        if (updated.count !== 1) {
          throw otaCampaignConflict('A target status changed concurrently');
        }
        await targetHistory(tx).create({
          data: {
            id: randomUUID(),
            targetId: t.id,
            fromStatus: t.status,
            toStatus: 'CANCELLED',
            detail: { reason: 'campaign cancelled' },
            createdAt: now,
          },
        });
        // OTA_CANCELLED：已通知（NOTIFIED 及以后）的设备须收到取消通知（CT-04 Outbox 下行，
        // deviceAction=CANCEL_PENDING_OTA）；PENDING 未通知过设备，无需取消通知（BE-OTA-03）
        if (t.status !== 'PENDING') {
          await outbox.create({
            data: {
              eventType: 'OTA_CANCELLED',
              aggregateType: 'ota_target',
              aggregateId: t.id,
              idempotencyKey: `ota-target:${t.id}:cancelled`,
              payload: {
                topic: `bnx/device/${t.deviceId}/notification`,
                data: { type: 'OTA_CANCELLED', action: 'CANCEL_PENDING_OTA' },
                otaTargetId: t.id,
              },
            },
          });
        }
      }
      await downloadGrants(tx).updateMany({
        where: { target: { campaignId }, usedAt: null, revokedAt: null },
        data: { revokedAt: now },
      });
      return { ...toCampaignView(campaign), status: 'CANCELLED', updatedAt: now.toISOString() };
    },
  );
}

// ---------- 失败重试（FAILED → PENDING，仅 RUNNING） ----------

export interface RetryOtaCampaignInput {
  /** 可选：仅重试指定 FAILED target；缺省重试 Campaign 全部 FAILED。 */
  readonly targetIds?: readonly string[] | undefined;
}

export interface RetryOtaCampaignResult {
  readonly campaignId: string;
  readonly retriedCount: number;
  readonly retriedTargetIds: readonly string[];
}

export async function retryOtaCampaignFailures(
  deps: OtaCampaignDeps,
  actor: ActorContext,
  campaignId: string,
  input: RetryOtaCampaignInput = {},
): Promise<RetryOtaCampaignResult> {
  const now = deps.now?.() ?? new Date();
  const campaign = (await campaigns(deps.client).findFirst({
    where: { id: campaignId },
  })) as unknown as OtaCampaignRow | null;
  if (!campaign) throw otaCampaignNotFound();
  if (campaign.status !== 'RUNNING') {
    throw otaCampaignConflict(`The campaign is ${campaign.status}; only RUNNING campaigns can retry failures`);
  }
  const requestedIds = input.targetIds ? [...new Set(input.targetIds)] : undefined;
  if (requestedIds && (requestedIds.length === 0 || requestedIds.length > MAX_BATCH_DEVICE_COUNT)) {
    throw otaCampaignValidationFailed(`targetIds must contain 1..${MAX_BATCH_DEVICE_COUNT} unique entries`);
  }
  const failed = (await targets(deps.client).findMany({
    where: {
      campaignId,
      status: 'FAILED',
      ...(requestedIds ? { id: { in: requestedIds } } : {}),
    },
  })) as unknown as OtaTargetRow[];
  if (requestedIds && failed.length !== requestedIds.length) {
    throw otaCampaignValidationFailed('targetIds must reference FAILED targets of this campaign');
  }

  return audited<RetryOtaCampaignResult>(
    deps.client,
    campaignAuditEntry(actor, campaignId, 'ota.campaign.retry', `FAILED → PENDING ×${failed.length}`, (r) => {
      const result = r as RetryOtaCampaignResult;
      return { campaignId, retriedCount: result.retriedCount };
    }),
    async (tx) => {
      const retried: string[] = [];
      for (const t of failed) {
        const updated = await targets(tx).updateMany({
          where: { id: t.id, status: 'FAILED' },
          data: {
            status: 'PENDING',
            completedAt: null,
            dispatchClaimedAt: null,
            dispatchLeaseUntil: null,
            dispatchLeaseToken: null,
            updatedAt: now,
          },
        });
        if (updated.count !== 1) {
          throw otaCampaignConflict('A target status changed concurrently');
        }
        await targetHistory(tx).create({
          data: {
            id: randomUUID(),
            targetId: t.id,
            fromStatus: 'FAILED',
            toStatus: 'PENDING',
            detail: { reason: 'retry requested by administrator' },
            createdAt: now,
          },
        });
        retried.push(t.id);
      }
      return { campaignId, retriedCount: retried.length, retriedTargetIds: retried };
    },
  );
}

// ---------- 设备回报状态推进（供 BE-OTA-03 ACK 处理器复用） ----------

/**
 * 记录 target 状态变化（DEC-015 ACK 唯一通道，BE-OTA-03 调用）：
 * - 封闭状态集合 + 合法迁移校验；终态写 completedAt；
 * - 幂等回放：同状态重复上报返回当前视图、不重复写历史；
 * - 全部 target SUCCEEDED → Campaign 自动 COMPLETED（同事务 + 审计）。
 */
export async function recordTargetStatus(
  deps: OtaCampaignDeps,
  targetId: string,
  toStatus: string,
  detail?: Record<string, unknown>,
): Promise<OtaTargetView> {
  const now = deps.now?.() ?? new Date();
  if (!(OTA_TARGET_STATUSES as readonly string[]).includes(toStatus)) {
    throw otaCampaignValidationFailed(`Unknown target status: ${toStatus}`);
  }
  const target = (await targets(deps.client).findFirst({ where: { id: targetId } })) as unknown as OtaTargetRow | null;
  if (!target) throw otaCampaignNotFound();
  if (target.status === toStatus) return toTargetView(target); // ACK 幂等回放
  const allowed = TARGET_ALLOWED_TRANSITIONS[target.status] ?? [];
  if (!allowed.includes(toStatus as OtaTargetStatus)) {
    throw otaCampaignConflict(`Illegal target transition: ${target.status} → ${toStatus}`);
  }
  return audited<OtaTargetView>(
    deps.client,
    {
      objectType: 'ota_target',
      objectId: targetId,
      action: 'ota.target.status',
      reason: `${target.status} → ${toStatus}`,
      actorId: 'system:ota-ack',
      customerId: null,
      afterValue: (v: unknown) => {
        const view = v as OtaTargetView;
        return { targetId, status: view.status };
      },
    },
    async (tx) => {
      const claimed = await targets(tx).updateMany({
        where: { id: targetId, status: target.status },
        data: {
          status: toStatus,
          ...(TERMINAL_TARGET_STATUSES.includes(toStatus as OtaTargetStatus) ? { completedAt: now } : {}),
          updatedAt: now,
        },
      });
      if (claimed.count !== 1) {
        throw otaCampaignConflict('The target status changed concurrently');
      }
      await targetHistory(tx).create({
        data: {
          id: randomUUID(),
          targetId,
          fromStatus: target.status,
          toStatus,
          detail: detail ?? null,
          createdAt: now,
        },
      });
      // 全部 SUCCEEDED → Campaign 自动 COMPLETED（仅运行中 Campaign；同事务审计）
      if (toStatus === 'SUCCEEDED') {
        const remaining = await targets(tx).findMany({
          where: { campaignId: target.campaignId, status: { notIn: ['SUCCEEDED'] } },
        });
        if (remaining.length === 0) {
          const completed = await campaigns(tx).updateMany({
            where: { id: target.campaignId, status: { in: ['RUNNING', 'PAUSED'] } },
            data: { status: 'COMPLETED', updatedAt: now },
          });
          if (completed.count === 1) {
            await recordAudit(tx, {
              objectType: 'ota_campaign',
              objectId: target.campaignId,
              action: 'ota.campaign.complete',
              result: 'SUCCESS',
              reason: 'all targets SUCCEEDED',
              actorId: 'system:ota-ack',
              customerId: null,
            });
          }
        }
      }
      return {
        ...toTargetView(target),
        status: toStatus,
        completedAt: TERMINAL_TARGET_STATUSES.includes(toStatus as OtaTargetStatus) ? now.toISOString() : null,
        updatedAt: now.toISOString(),
      };
    },
  );
}

// ---------- 查询 ----------

export interface ListOtaCampaignsFilter {
  readonly status?: string | undefined;
  readonly targetModel?: string | undefined;
  readonly packageId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

export async function listOtaCampaigns(
  deps: OtaCampaignDeps,
  filter: ListOtaCampaignsFilter = {},
): Promise<Page<OtaCampaignView>> {
  if (filter.status !== undefined && !(OTA_CAMPAIGN_STATUSES as readonly string[]).includes(filter.status)) {
    throw otaCampaignValidationFailed(`status must be one of: ${OTA_CAMPAIGN_STATUSES.join(', ')}`);
  }
  const limit = normalizeLimit(filter.limit ?? null);
  const where: Record<string, unknown> = {};
  if (filter.status) where.status = filter.status;
  if (filter.targetModel) where.targetModel = filter.targetModel;
  if (filter.packageId) where.packageId = filter.packageId;
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = (await campaigns(deps.client).findMany({
    where,
    orderBy: { id: 'asc' },
    take: limit + 1,
  })) as unknown as OtaCampaignRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toCampaignView),
    nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null,
  };
}

export async function getOtaCampaign(deps: OtaCampaignDeps, campaignId: string): Promise<OtaCampaignDetailView> {
  const row = (await campaigns(deps.client).findFirst({
    where: { id: campaignId },
  })) as unknown as OtaCampaignRow | null;
  if (!row) throw otaCampaignNotFound();
  const rows = (await targets(deps.client).findMany({
    where: { campaignId },
  })) as unknown as OtaTargetRow[];
  const targetCounts = Object.fromEntries(
    OTA_TARGET_STATUSES.map((s) => [s, rows.filter((t) => t.status === s).length]),
  ) as Record<OtaTargetStatus, number>;
  return { ...toCampaignView(row), targetCounts: { total: rows.length, ...targetCounts } };
}

export interface ListOtaTargetsFilter {
  readonly status?: string | undefined;
  readonly batchNo?: string | number | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
}

export async function listOtaTargets(
  deps: OtaCampaignDeps,
  campaignId: string,
  filter: ListOtaTargetsFilter = {},
): Promise<Page<OtaTargetView>> {
  const campaign = (await campaigns(deps.client).findFirst({
    where: { id: campaignId },
  })) as unknown as OtaCampaignRow | null;
  if (!campaign) throw otaCampaignNotFound();
  if (filter.status !== undefined && !(OTA_TARGET_STATUSES as readonly string[]).includes(filter.status)) {
    throw otaCampaignValidationFailed(`status must be one of: ${OTA_TARGET_STATUSES.join(', ')}`);
  }
  const limit = normalizeLimit(filter.limit ?? null);
  const where: Record<string, unknown> = { campaignId };
  if (filter.status) where.status = filter.status;
  if (filter.batchNo !== undefined) {
    const batchNo = typeof filter.batchNo === 'string' ? Number(filter.batchNo) : filter.batchNo;
    if (!Number.isInteger(batchNo) || batchNo < 1) {
      throw otaCampaignValidationFailed('batchNo must be a positive integer');
    }
    where.batchNo = batchNo;
  }
  const after = decodeKeysetCursor(filter.cursor ?? null);
  if (after) where.id = { gt: after };
  const rows = (await targets(deps.client).findMany({
    where,
    orderBy: { id: 'asc' },
    take: limit + 1,
  })) as unknown as OtaTargetRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toTargetView),
    nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null,
  };
}
