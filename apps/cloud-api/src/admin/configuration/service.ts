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
 * 现有 Sync lastSyncTime 不承载配置版本应用回执。
 */
import type { DbClient, Page, PageArgs } from '@fdp/database';
import { audited, decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
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

export interface ConfigurationDeliveryEvidence {
  readonly deliveryId: string;
  readonly servedAt: string;
  readonly receivedAt: string | null;
  readonly appliedAt: string | null;
}

export interface ConfigurationSyncStatusView {
  readonly configurationId: string;
  readonly version: number;
  readonly status: string;
  readonly effectiveAt: string | null;
  readonly targets: readonly {
    readonly deviceId: string;
    readonly notificationStatus: string;
    readonly delivery?: ConfigurationDeliveryEvidence;
  }[];
}

/** Sync 下发快照（BE-SYNC-01 读取路径）。 */
export interface EffectiveConfiguration {
  readonly versionId: string;
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
  readonly serialNumber: string;
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

/** Derive read-only context from the device's current site and active contract association. */
export async function readConfigurationContext(
  client: DbClient,
  device: Pick<DeviceRow, 'id' | 'alias' | 'customerId' | 'siteId'>,
  at: Date,
): Promise<ConfigurationDerivedContext> {
  const { id, customerId, siteId, alias } = device;
  const [site, link] = await Promise.all([
    siteId && customerId
      ? client.site.findFirst({
          where: { id: siteId, customerId, deletedAt: null },
          select: { name: true, region: true, subregion: true },
        })
      : null,
    customerId
      ? client.contractDevice.findFirst({
          where: {
            deviceId: id,
            customerId,
            status: 'ACTIVE',
            validFrom: { lte: at },
            OR: [{ validTo: null }, { validTo: { gt: at } }],
            contract: {
              customerId,
              status: { in: ['EFFECTIVE', 'EXPIRING_SOON'] },
              startAt: { lte: at },
              endAt: { gt: at },
            },
          },
          orderBy: [{ validFrom: 'desc' }, { id: 'asc' }],
          select: { contract: { select: { contractNumber: true, name: true } } },
        })
      : null,
  ]);
  return {
    alias,
    site: site?.name ?? null,
    region: site?.region ?? null,
    subregion: site?.subregion ?? null,
    contract: link ? { contractNumber: link.contract.contractNumber, name: link.contract.name } : null,
  };
}

async function loadDerivedContext(client: DbClient, deviceId: string, at: Date): Promise<ConfigurationDerivedContext> {
  const device = await devices(client).findFirst({ where: { id: deviceId } });
  if (!device) throw configurationNotFound();
  return readConfigurationContext(client, device, at);
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

  return audited<PublishConfigurationResult>(
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
      if (config.targetDeviceId !== null) {
        await tx.$queryRaw`SELECT id FROM devices WHERE id = ${config.targetDeviceId} FOR SHARE`;
      }
      const targetDevices = (
        await devices(tx).findMany({
          where: config.targetDeviceId !== null ? { id: config.targetDeviceId } : { model: config.targetModel },
        })
      ).filter((device) => device.lifecycleStatus !== 'Retired');
      if (config.targetDeviceId !== null && targetDevices.length !== 1) {
        throw configurationConflict('The configuration target is no longer eligible');
      }
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
      return { version: toVersionView(fresh), notifiedDeviceIds: targetDevices.map((device) => device.id) };
    },
  );
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

/** Group receipt snapshots by immutable version and device, with the latest served evidence first. */
async function loadConfigurationDeliveries(
  client: DbClient,
  versionIds: readonly string[],
  deviceIds?: readonly string[],
): Promise<ReadonlyMap<string, Map<string, ConfigurationDeliveryEvidence>>> {
  const byVersion = new Map<string, Map<string, ConfigurationDeliveryEvidence>>();
  if (versionIds.length === 0 || deviceIds?.length === 0) return byVersion;
  const rows = await client.configurationDelivery.findMany({
    where: {
      configurationVersionId: { in: [...versionIds] },
      ...(deviceIds ? { deviceId: { in: [...deviceIds] } } : {}),
    },
    orderBy: [{ servedAt: 'desc' }, { id: 'asc' }],
  });
  for (const row of rows) {
    let byDevice = byVersion.get(row.configurationVersionId);
    if (!byDevice) {
      byDevice = new Map();
      byVersion.set(row.configurationVersionId, byDevice);
    }
    if (byDevice.has(row.deviceId)) continue;
    byDevice.set(row.deviceId, {
      deliveryId: row.id,
      servedAt: row.servedAt.toISOString(),
      receivedAt: row.receivedAt?.toISOString() ?? null,
      appliedAt: row.appliedAt?.toISOString() ?? null,
    });
  }
  return byVersion;
}

/** Outbox notifications and authenticated delivery evidence are independent. */
export async function getConfigurationVersionStatus(
  deps: ConfigurationDeps,
  configurationId: string,
  version: number,
): Promise<ConfigurationSyncStatusView> {
  const versionRow = await loadVersion(deps.client, configurationId, version);
  const [events, deliveryByVersion] = await Promise.all([
    outbox(deps.client).findMany({
      where: { aggregateType: 'configuration', aggregateId: versionRow.id, eventType: CONFIG_CHANGED_NOTIFICATION },
    }),
    loadConfigurationDeliveries(deps.client, [versionRow.id]),
  ]);
  const deliveries = deliveryByVersion.get(versionRow.id);
  const notifications = new Map(
    events.map((event) => {
      const payload = event.payload as { topic?: string };
      const id = typeof payload.topic === 'string' ? payload.topic.split('/')[2] : undefined;
      return [id ?? 'unknown', event.status] as const;
    }),
  );
  const targets = [...new Set([...notifications.keys(), ...(deliveries?.keys() ?? [])])].map((deviceId) => {
    const delivery = deliveries?.get(deviceId);
    return {
      deviceId,
      notificationStatus: notifications.get(deviceId) ?? 'NOT_QUEUED',
      ...(delivery ? { delivery } : {}),
    };
  });
  return {
    configurationId,
    version,
    status: versionRow.status,
    effectiveAt: versionRow.effectiveAt?.toISOString() ?? null,
    targets,
  };
}

interface EffectiveSelection {
  readonly row: ConfigurationRow;
  readonly version: VersionRow;
  readonly effectiveAt: Date;
}

type ConfigurationTargetDevice = Pick<DeviceRow, 'id' | 'model'>;

/** Shared by Sync and the admin device page. Select within plan before comparing effective times across plans. */
async function loadEffectiveSelections(
  client: DbClient,
  targets: readonly ConfigurationTargetDevice[],
  at: Date,
): Promise<(device: ConfigurationTargetDevice) => EffectiveSelection | null> {
  if (targets.length === 0) return () => null;
  const candidates = await configurations(client).findMany({
    where: {
      OR: [
        { targetDeviceId: { in: targets.map(({ id }) => id) } },
        { targetModel: { in: [...new Set(targets.map(({ model }) => model))] } },
      ],
    },
    include: {
      versions: {
        where: { status: 'PUBLISHED', effectiveAt: { lte: at } },
        orderBy: { version: 'desc' },
        take: 1,
      },
    },
  });
  const byDevice = new Map<string, EffectiveSelection>();
  const byModel = new Map<string, EffectiveSelection>();
  for (const row of candidates) {
    const version = selectEffectiveVersion(row.versions ?? [], at);
    const target = row.targetDeviceId ?? row.targetModel;
    if (version === null || version.effectiveAt === null || target === null) continue;
    const effectiveAt = version.effectiveAt;
    const index = row.targetDeviceId !== null ? byDevice : byModel;
    const previous = index.get(target);
    if (previous !== undefined) {
      const order =
        effectiveAt.getTime() - previous.effectiveAt.getTime() ||
        version.createdAt.getTime() - previous.version.createdAt.getTime();
      if (order < 0 || (order === 0 && row.id <= previous.row.id)) continue;
    }
    index.set(target, { row, version, effectiveAt });
  }
  return (device) => byDevice.get(device.id) ?? byModel.get(device.model) ?? null;
}

export async function resolveEffectiveConfiguration(
  deps: ConfigurationDeps,
  deviceId: string,
  at?: Date,
): Promise<EffectiveConfiguration | null> {
  const now = at ?? deps.now?.() ?? new Date();
  const device = await devices(deps.client).findFirst({ where: { id: deviceId } });
  if (!device) throw configurationNotFound();
  const resolve = await loadEffectiveSelections(deps.client, [device], now);
  const selected = resolve(device);
  if (selected === null) return null;
  return {
    versionId: selected.version.id,
    configurationId: selected.row.id,
    version: selected.version.version,
    payload: selected.version.payload as ConfigurationPayload,
    effectiveAt: selected.effectiveAt.toISOString(),
  };
}

export interface ConfigurationEffectiveDeviceView {
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly alias: string | null;
  readonly model: string;
  readonly cloudEffectiveConfiguration: {
    readonly configurationId: string;
    readonly name: string;
    readonly version: number;
    readonly effectiveAt: string;
    readonly source: 'DEVICE' | 'MODEL';
  } | null;
  readonly configurationDelivery?: ConfigurationDeliveryEvidence;
  readonly deviceAppliedConfiguration: {
    readonly configurationId: string;
    readonly version: number;
    readonly appliedAt: string;
  } | null;
}

export async function listEffectiveConfigurationDevices(
  deps: ConfigurationDeps,
  configurationId: string,
  pagination: PageArgs,
  at: Date,
): Promise<Page<ConfigurationEffectiveDeviceView>> {
  const limit = normalizeLimit(pagination.limit);
  const after = decodeKeysetCursor(pagination.cursor);
  const target = await configurations(deps.client).findFirst({ where: { id: configurationId } });
  if (!target) throw configurationNotFound();
  if (target.targetDeviceId === null && target.targetModel === null) return { items: [], nextCursor: null };
  const rows = await devices(deps.client).findMany({
    where: {
      AND: [
        target.targetDeviceId !== null ? { id: target.targetDeviceId } : { model: target.targetModel },
        { lifecycleStatus: { not: 'Retired' } },
        ...(after !== null ? [{ id: { gt: after } }] : []),
      ],
    },
    orderBy: { id: 'asc' },
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const resolve = await loadEffectiveSelections(deps.client, page, at);
  const selections = page.map((device) => ({ device, selected: resolve(device) }));
  const deliveries = await loadConfigurationDeliveries(
    deps.client,
    [...new Set(selections.flatMap(({ selected }) => (selected ? [selected.version.id] : [])))],
    page.map((device) => device.id),
  );
  const items = selections.map(({ device, selected }): ConfigurationEffectiveDeviceView => {
    const delivery = selected === null ? undefined : deliveries.get(selected.version.id)?.get(device.id);
    return {
      deviceId: device.id,
      serialNumber: device.serialNumber,
      alias: device.alias,
      model: device.model,
      cloudEffectiveConfiguration:
        selected === null
          ? null
          : {
              configurationId: selected.row.id,
              name: selected.row.name,
              version: selected.version.version,
              effectiveAt: selected.effectiveAt.toISOString(),
              source: selected.row.targetDeviceId !== null ? 'DEVICE' : 'MODEL',
            },
      ...(delivery ? { configurationDelivery: delivery } : {}),
      deviceAppliedConfiguration:
        selected && delivery?.appliedAt
          ? { configurationId: selected.row.id, version: selected.version.version, appliedAt: delivery.appliedAt }
          : null,
    };
  });
  const last = page.at(-1);
  return { items, nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null };
}
