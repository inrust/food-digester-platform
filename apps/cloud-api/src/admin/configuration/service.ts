/**
 * BE-CFG-01 Configuration 版本管理领域服务。
 *
 * 事实源与规则：
 * - 载荷校验走领域层 validateConfigurationPayload（封闭 Schema + 冻结范围校验；
 *   派生字段 contract/region/subregion/site/alias 与 V1 排除字段 cloudDomain/ntpServer
 *   提交即 400）；
 * - 版本不可变：仅 create（DRAFT）与 publish（DRAFT→PUBLISHED 条件更新）两条写路径，
 *   payload 创建后无任何更新入口（历史版本不可覆盖），旧版本始终可审计读取；
 * - 按设备/型号发布：targetDeviceId / targetModel 二选一（服务校验 + DB CHECK 兜底）；
 * - 发布生成 CONFIG_CHANGED：每个目标设备一条 Outbox（topic bnx/device/{id}/notification，
 *   data {type, action:'SYNC'}，aggregateId = versionId；Retired 设备不通知）；
 * - 审计：configuration.create / configuration.create_version / configuration.publish 各一次；
 * - Sync 读取路径（BE-SYNC-01 消费）：resolveEffectiveConfiguration = 设备定向优先，
 *   否则型号定向；已发布且已到 effectiveAt 的最高版本（DOM selectEffectiveVersion）。
 *
 * 功能边界：不实现设备端应用配置；同步状态当前为通知投递状态（Outbox status），
 * 设备确认回执由 BE-SYNC-01 的 lastSyncTime 机制补齐。
 */
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';
import { assertPublishableVersion, selectEffectiveVersion, validateConfigurationPayload } from '@fdp/domain';
import type { ConfigurationPayload } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import { configurationConflict, configurationNotFound, configurationValidationFailed } from './errors.js';

export const CONFIG_CHANGED_NOTIFICATION = 'CONFIG_CHANGED' as const;

const notificationTopic = (deviceId: string): string => `bnx/device/${deviceId}/notification`;

export interface ConfigurationDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export interface ConfigurationVersionView {
  readonly versionId: string;
  readonly configurationId: string;
  readonly version: number;
  readonly payload: ConfigurationPayload;
  readonly status: string;
  readonly effectiveAt: string | null;
  readonly changeNote: string | null;
  readonly createdAt: string;
}

export interface ConfigurationSummaryView {
  readonly configurationId: string;
  readonly name: string;
  readonly targetModel: string | null;
  readonly targetDeviceId: string | null;
  readonly versionCount: number;
  readonly latestPublishedVersion: number | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** 派生只读上下文（从业务实体读取；配置页只读展示，不得随配置提交）。 */
export interface ConfigurationDerivedContext {
  readonly alias: string | null;
  readonly site: string | null;
  readonly region: string | null;
  readonly subregion: string | null;
  readonly contract: { readonly contractNumber: string; readonly name: string } | null;
}

export interface ConfigurationDetailView extends ConfigurationSummaryView {
  readonly versions: readonly ConfigurationVersionView[];
  /** 仅按设备发布时存在（型号配置无单一设备上下文）。 */
  readonly derivedContext: ConfigurationDerivedContext | null;
}

export interface PublishConfigurationResult {
  readonly version: ConfigurationVersionView;
  /** 收到 CONFIG_CHANGED 通知的目标设备。 */
  readonly notifiedDeviceIds: readonly string[];
}

export interface ConfigurationSyncStatusView {
  readonly configurationId: string;
  readonly version: number;
  readonly status: string;
  readonly effectiveAt: string | null;
  readonly targets: readonly { readonly deviceId: string; readonly notificationStatus: string }[];
}

/** Sync 下发快照（BE-SYNC-01 读取路径）。 */
export interface EffectiveConfiguration {
  readonly configurationId: string;
  readonly version: number;
  readonly payload: ConfigurationPayload;
  readonly effectiveAt: string;
}

interface VersionRow {
  readonly id: string;
  readonly configurationId: string;
  readonly version: number;
  readonly payload: unknown;
  readonly status: string;
  readonly effectiveAt: Date | null;
  readonly changeNote: string | null;
  readonly createdAt: Date;
}

interface ConfigurationRow {
  readonly id: string;
  readonly name: string;
  readonly targetModel: string | null;
  readonly targetDeviceId: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly versions?: readonly VersionRow[];
}

interface ConfigurationDelegate {
  findFirst(args: Record<string, unknown>): Promise<ConfigurationRow | null>;
  findMany(args: Record<string, unknown>): Promise<ConfigurationRow[]>;
  create(args: Record<string, unknown>): Promise<ConfigurationRow>;
}

interface VersionDelegate {
  findFirst(args: Record<string, unknown>): Promise<VersionRow | null>;
  findMany(args: Record<string, unknown>): Promise<VersionRow[]>;
  create(args: Record<string, unknown>): Promise<VersionRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  aggregate(args: Record<string, unknown>): Promise<{ _max: { version: number | null } }>;
}

interface OutboxDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findMany(args: Record<string, unknown>): Promise<{ payload: unknown; status: string }[]>;
}

function configurations(client: DbClient): ConfigurationDelegate {
  return (client as unknown as Record<string, unknown>).deviceConfiguration as ConfigurationDelegate;
}

function versions(client: DbClient): VersionDelegate {
  return (client as unknown as Record<string, unknown>).configurationVersion as VersionDelegate;
}

function outbox(client: DbClient): OutboxDelegate {
  return (client as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

function toVersionView(row: VersionRow): ConfigurationVersionView {
  return {
    versionId: row.id,
    configurationId: row.configurationId,
    version: row.version,
    payload: row.payload as ConfigurationPayload,
    status: row.status,
    effectiveAt: row.effectiveAt?.toISOString() ?? null,
    changeNote: row.changeNote,
    createdAt: row.createdAt.toISOString(),
  };
}

function toSummaryView(row: ConfigurationRow): ConfigurationSummaryView {
  const vs = row.versions ?? [];
  const published = vs.filter((v) => v.status === 'PUBLISHED').map((v) => v.version);
  return {
    configurationId: row.id,
    name: row.name,
    targetModel: row.targetModel,
    targetDeviceId: row.targetDeviceId,
    versionCount: vs.length,
    latestPublishedVersion: published.length > 0 ? Math.max(...published) : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadConfiguration(client: DbClient, configurationId: string): Promise<ConfigurationRow> {
  const row = await configurations(client).findFirst({
    where: { id: configurationId },
    include: { versions: { orderBy: { version: 'asc' } } },
  });
  if (!row) throw configurationNotFound();
  return row;
}

interface DeviceRow {
  readonly id: string;
  readonly model: string;
  readonly alias: string | null;
  readonly customerId: string | null;
  readonly siteId: string | null;
  readonly lifecycleStatus: string;
}

function devices(client: DbClient) {
  return (client as unknown as Record<string, unknown>).device as {
    findFirst(args: Record<string, unknown>): Promise<DeviceRow | null>;
    findMany(args: Record<string, unknown>): Promise<DeviceRow[]>;
  };
}

/** 派生只读上下文：Alias/Site/Region/Subregion 取设备与站点；Contract 取客户当前有效合同。 */
async function loadDerivedContext(client: DbClient, deviceId: string, at: Date): Promise<ConfigurationDerivedContext> {
  const device = await devices(client).findFirst({ where: { id: deviceId } });
  if (!device) throw configurationNotFound();
  let site: { name: string; region: string | null; subregion: string | null } | null = null;
  if (device.siteId) {
    site = await (
      (client as unknown as Record<string, unknown>).site as {
        findFirst(args: Record<string, unknown>): Promise<typeof site>;
      }
    ).findFirst({ where: { id: device.siteId } });
  }
  let contract: { contractNumber: string; name: string } | null = null;
  if (device.customerId) {
    contract = await (
      (client as unknown as Record<string, unknown>).contract as {
        findFirst(args: Record<string, unknown>): Promise<typeof contract>;
      }
    ).findFirst({
      where: { customerId: device.customerId, startAt: { lte: at }, endAt: { gt: at } },
      orderBy: { startAt: 'desc' },
    });
  }
  return {
    alias: device.alias,
    site: site?.name ?? null,
    region: site?.region ?? null,
    subregion: site?.subregion ?? null,
    contract: contract ? { contractNumber: contract.contractNumber, name: contract.name } : null,
  };
}

// ---------- 写路径 ----------

export interface CreateConfigurationInput {
  readonly name: string;
  readonly targetModel?: string | undefined;
  readonly targetDeviceId?: string | undefined;
  readonly reason?: string | undefined;
}

/** 创建配置（config:publish）：targetModel / targetDeviceId 二选一（DB CHECK 兜底）。 */
export async function createConfiguration(
  deps: ConfigurationDeps,
  actor: ActorContext,
  input: CreateConfigurationInput,
): Promise<ConfigurationSummaryView> {
  const targetModel = input.targetModel?.trim() || undefined;
  const targetDeviceId = input.targetDeviceId?.trim() || undefined;
  if ((targetModel === undefined) === (targetDeviceId === undefined)) {
    throw configurationValidationFailed('Exactly one of targetModel and targetDeviceId is required');
  }
  if (targetDeviceId !== undefined) {
    const device = await devices(deps.client).findFirst({ where: { id: targetDeviceId } });
    if (!device) throw configurationNotFound();
    if (device.lifecycleStatus === 'Retired') {
      throw configurationConflict('The target device is retired');
    }
  }
  try {
    return await audited<ConfigurationSummaryView>(
      deps.client,
      {
        objectType: 'configuration',
        objectId: targetDeviceId ?? `model:${targetModel}`,
        action: 'configuration.create',
        reason: input.reason ?? null,
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        afterValue: (result: unknown) => {
          const r = result as ConfigurationSummaryView;
          return { configurationId: r.configurationId, name: r.name };
        },
      },
      async (tx) => {
        const row = await configurations(tx).create({
          data: {
            name: input.name.trim(),
            targetModel: targetModel ?? null,
            targetDeviceId: targetDeviceId ?? null,
            createdBy: actor.actorId,
          },
          include: { versions: true },
        });
        return toSummaryView(row);
      },
    );
  } catch (err) {
    // 并发/回填撞二选一 CHECK（P23514）→ 400；唯一约束 → 409
    const code = (err as { code?: string } | null)?.code;
    if (code === 'P2002') throw configurationConflict('The configuration conflicts with an existing one');
    throw err;
  }
}

export interface CreateVersionInput {
  readonly payload: unknown;
  readonly changeNote?: string | undefined;
  readonly reason?: string | undefined;
}

/** 创建不可变版本（config:publish）：领域校验载荷；版本号 = 当前最大 + 1（并发 P2002 → 409）。 */
export async function createConfigurationVersion(
  deps: ConfigurationDeps,
  actor: ActorContext,
  configurationId: string,
  input: CreateVersionInput,
): Promise<ConfigurationVersionView> {
  await loadConfiguration(deps.client, configurationId);
  const payload = validateConfigurationPayload(input.payload);
  try {
    return await audited<ConfigurationVersionView>(
      deps.client,
      {
        objectType: 'configuration',
        objectId: configurationId,
        action: 'configuration.create_version',
        reason: input.reason ?? input.changeNote ?? null,
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        afterValue: (result: unknown) => {
          const r = result as ConfigurationVersionView;
          return { versionId: r.versionId, version: r.version, status: 'DRAFT' };
        },
      },
      async (tx) => {
        const max = await versions(tx).aggregate({ where: { configurationId }, _max: { version: true } });
        const row = await versions(tx).create({
          data: {
            configurationId,
            version: (max._max.version ?? 0) + 1,
            payload: payload as unknown as Record<string, unknown>,
            status: 'DRAFT',
            changeNote: input.changeNote ?? null,
          },
        });
        return toVersionView(row);
      },
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw configurationConflict('The version was created concurrently; refresh and retry');
    }
    throw err;
  }
}

export interface PublishVersionInput {
  readonly effectiveAt?: Date | undefined;
  readonly reason?: string | undefined;
}

async function loadVersion(client: DbClient, configurationId: string, version: number): Promise<VersionRow> {
  const row = await versions(client).findFirst({ where: { configurationId, version } });
  if (!row) throw configurationNotFound();
  return row;
}

/**
 * 发布版本（config:publish）：DRAFT→PUBLISHED 条件更新（重复发布/并发 → 409，历史版本不可覆盖）；
 * 每个目标设备一条 CONFIG_CHANGED Outbox（Retired 不通知）。
 */
export async function publishConfigurationVersion(
  deps: ConfigurationDeps,
  actor: ActorContext,
  configurationId: string,
  version: number,
  input: PublishVersionInput,
): Promise<PublishConfigurationResult> {
  const now = deps.now?.() ?? new Date();
  const config = await loadConfiguration(deps.client, configurationId);
  const versionRow = await loadVersion(deps.client, configurationId, version);
  assertPublishableVersion(versionRow.status);
  const effectiveAt = input.effectiveAt ?? now;

  // 目标设备（发布时点解析；Retired 不通知）
  const targetDevices = (
    config.targetDeviceId !== null
      ? await devices(deps.client).findMany({ where: { id: config.targetDeviceId } })
      : await devices(deps.client).findMany({ where: { model: config.targetModel } })
  ).filter((d) => d.lifecycleStatus !== 'Retired');

  const published = await audited<ConfigurationVersionView>(
    deps.client,
    {
      objectType: 'configuration',
      objectId: versionRow.id,
      action: 'configuration.publish',
      reason: input.reason ?? null,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      beforeValue: { version, status: 'DRAFT' },
      afterValue: { version, status: 'PUBLISHED', effectiveAt: effectiveAt.toISOString() },
    },
    async (tx) => {
      const { count } = await versions(tx).updateMany({
        where: { id: versionRow.id, status: 'DRAFT' },
        data: { status: 'PUBLISHED', effectiveAt },
      });
      if (count !== 1) {
        throw configurationConflict('The version is already published and immutable');
      }
      for (const device of targetDevices) {
        await outbox(tx).create({
          data: {
            eventType: CONFIG_CHANGED_NOTIFICATION,
            aggregateType: 'configuration',
            aggregateId: versionRow.id,
            payload: {
              topic: notificationTopic(device.id),
              data: { type: CONFIG_CHANGED_NOTIFICATION, action: 'SYNC' },
              configurationId,
              version,
            },
          },
        });
      }
      const fresh = await versions(tx).findFirst({ where: { id: versionRow.id } });
      if (!fresh) throw configurationNotFound();
      return toVersionView(fresh);
    },
  );
  return { version: published, notifiedDeviceIds: targetDevices.map((d) => d.id) };
}

// ---------- 读路径 ----------

/** 列表（config:read；可按 targetModel/targetDeviceId 过滤）。 */
export async function listConfigurations(
  deps: ConfigurationDeps,
  filter: { readonly targetModel?: string | undefined; readonly targetDeviceId?: string | undefined } = {},
): Promise<ConfigurationSummaryView[]> {
  const rows = await configurations(deps.client).findMany({
    where: {
      ...(filter.targetModel !== undefined ? { targetModel: filter.targetModel } : {}),
      ...(filter.targetDeviceId !== undefined ? { targetDeviceId: filter.targetDeviceId } : {}),
    },
    include: { versions: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return rows.map(toSummaryView);
}

/** 详情（config:read）：含全部版本与派生只读上下文。 */
export async function getConfigurationDetail(
  deps: ConfigurationDeps,
  configurationId: string,
): Promise<ConfigurationDetailView> {
  const row = await loadConfiguration(deps.client, configurationId);
  const derivedContext =
    row.targetDeviceId !== null
      ? await loadDerivedContext(deps.client, row.targetDeviceId, deps.now?.() ?? new Date())
      : null;
  return {
    ...toSummaryView(row),
    versions: (row.versions ?? []).map(toVersionView),
    derivedContext,
  };
}

/** 版本详情（config:read；旧版本仍可审计读取）。 */
export async function getConfigurationVersion(
  deps: ConfigurationDeps,
  configurationId: string,
  version: number,
): Promise<ConfigurationVersionView> {
  return toVersionView(await loadVersion(deps.client, configurationId, version));
}

/** 发布同步状态（config:read）：通知投递状态 = CONFIG_CHANGED Outbox 状态（设备回执由 BE-SYNC-01 补齐）。 */
export async function getConfigurationVersionStatus(
  deps: ConfigurationDeps,
  configurationId: string,
  version: number,
): Promise<ConfigurationSyncStatusView> {
  const versionRow = await loadVersion(deps.client, configurationId, version);
  const events = await outbox(deps.client).findMany({
    where: { aggregateType: 'configuration', aggregateId: versionRow.id, eventType: CONFIG_CHANGED_NOTIFICATION },
  });
  const targets = events.map((e) => {
    const payload = e.payload as { topic?: string };
    const deviceId = typeof payload.topic === 'string' ? payload.topic.split('/')[2] : undefined;
    return { deviceId: deviceId ?? 'unknown', notificationStatus: e.status };
  });
  return {
    configurationId,
    version,
    status: versionRow.status,
    effectiveAt: versionRow.effectiveAt?.toISOString() ?? null,
    targets,
  };
}

/**
 * Sync 读取路径（BE-SYNC-01 消费）：设备有效配置 = 设备定向优先，否则型号定向；
 * 已发布且已到 effectiveAt 的最高版本（selectEffectiveVersion）；跨配置并列时取最近生效者。
 */
export async function resolveEffectiveConfiguration(
  deps: ConfigurationDeps,
  deviceId: string,
  at?: Date,
): Promise<EffectiveConfiguration | null> {
  const now = at ?? deps.now?.() ?? new Date();
  const device = await devices(deps.client).findFirst({ where: { id: deviceId } });
  if (!device) throw configurationNotFound();

  const deviceConfigs = await configurations(deps.client).findMany({
    where: { targetDeviceId: deviceId },
    include: { versions: true },
  });
  const pick = (rows: readonly ConfigurationRow[]): { row: ConfigurationRow; version: VersionRow } | null => {
    let best: { row: ConfigurationRow; version: VersionRow } | null = null;
    for (const row of rows) {
      const v = selectEffectiveVersion(row.versions ?? [], now);
      if (!v) continue;
      if (
        best === null ||
        (v.effectiveAt as Date).getTime() > (best.version.effectiveAt as Date).getTime() ||
        ((v.effectiveAt as Date).getTime() === (best.version.effectiveAt as Date).getTime() &&
          v.createdAt.getTime() > best.version.createdAt.getTime())
      ) {
        best = { row, version: v as VersionRow };
      }
    }
    return best;
  };

  let best = pick(deviceConfigs);
  if (best === null) {
    const modelConfigs = await configurations(deps.client).findMany({
      where: { targetModel: device.model },
      include: { versions: true },
    });
    best = pick(modelConfigs);
  }
  if (best === null) return null;
  return {
    configurationId: best.row.id,
    version: best.version.version,
    payload: best.version.payload as ConfigurationPayload,
    effectiveAt: (best.version.effectiveAt as Date).toISOString(),
  };
}
