/**
 * BE-SYNC-01 Unified Device Sync 聚合 Service（框架无关）。
 *
 * 定位：POST /api/v1/device/sync 是设备从 CMP 获取完整单一事实源快照的强制接口
 *（实施方案 8.5）。设备经 AUTH-03 verifyDeviceCertificate 认证（mTLS 白名单；
 * Retired 设备 403 不得进入快照）。本服务不产生通知/审计；仅持久化 Device User 版本进入
 * 快照以及后续 lastSyncTime 确认的最小状态，供管理端区分通知发布、快照交付与本地应用。
 *
 * 快照域（完整事实快照，不做增量下发）：
 * - Assignment：当前 ACTIVE 分配（customerId/customerName、siteId/siteName、Region/Subregion、
 *   授权窗口 [assignedAt, endedAt)）；未分配 → null；
 * - Device Metadata：别名/序列号/型号/固件；
 * - License：有效优先（EFFECTIVE_LICENSE_STATUSES 且在有效期内），否则最新一条；未许可 → null；
 *   含 Entitlements（enabled）与签名（Draft 无签名为 null）；
 * - Device Users：本 Customer ACTIVE 用户中 ACTIVE 分配到本设备者；含 DEC-004 验证材料
 *   （version+kdf+salt+hash，Sync 域是唯一授权下发通道，查询 API 不返回）；
 * - Configuration：resolveEffectiveConfiguration（设备定向优先，未来生效不下发）；无 → null；
 * - Operational Status：lifecycleStatus + operationalStatus + connectivity 派生 +
 *   syncIntervalSeconds（Active=300/Suspended=900 为设备契约；Maintenance 经 DEC-001
 *   行为矩阵注入，禁止复制冻结值）。
 *
 * 版本/ETag：etag = 稳定域（assignment/device/license/deviceUsers/configuration/生命周期与
 * 同步节奏）规范 JSON 的 SHA-256；volatile 域（snapshotAt/connectivity/lastHeartbeatAt）不参与，
 * 避免心跳噪声导致 etag 漂移。即使 etag 未变化也返回完整快照（不得省略设备无法安全缓存的
 * 必要域）；lastSyncTime 仅接收并回显，不做增量裁剪。
 *
 * 租户隔离：Assignment/Device Users 以证书绑定设备的 customerId 严格限定（Customer 数据
 * 不串线）；License/Configuration 按 deviceId 限定。
 */
import { createHash } from 'node:crypto';
import type { DbClient } from '@fdp/database';
import type { DeviceAuthContext } from '@fdp/auth';
import { EFFECTIVE_LICENSE_STATUSES } from '../admin/customer/repository.js';
import { DEFAULT_CONNECTIVITY_THRESHOLD_MS, deriveConnectivity } from '../admin/device/repository.js';
import { resolveEffectiveConfiguration } from '../admin/configuration/service.js';
import type { EffectiveConfiguration } from '../admin/configuration/service.js';
import { listDeviceUsersForSync } from '../admin/device-user/service.js';

interface DeviceUserSyncReceiptDelegate {
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  createMany(args: { data: readonly Record<string, unknown>[]; skipDuplicates: boolean }): Promise<{ count: number }>;
}

function syncReceipts(client: DbClient): DeviceUserSyncReceiptDelegate {
  return (client as unknown as Record<string, unknown>).deviceUserSyncReceipt as DeviceUserSyncReceiptDelegate;
}

/** 设备契约同步节奏（通信设计 8.5）：Active 每 5 分钟。 */
export const SYNC_INTERVAL_ACTIVE_SECONDS = 300 as const;
/** 设备契约同步节奏（通信设计 8.5）：Suspended 每 15 分钟。 */
export const SYNC_INTERVAL_SUSPENDED_SECONDS = 900 as const;

export type DeviceSyncErrorCode = 'VALIDATION_FAILED';

export const DEVICE_SYNC_ERROR_HTTP_STATUS: Readonly<Record<DeviceSyncErrorCode, number>> = {
  VALIDATION_FAILED: 400,
} as const;

export class DeviceSyncError extends Error {
  override readonly name = 'DeviceSyncError';
  readonly code: DeviceSyncErrorCode;

  constructor(code: DeviceSyncErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return DEVICE_SYNC_ERROR_HTTP_STATUS[this.code];
  }
}

export interface DeviceSyncDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
  /**
   * DEC-001：Maintenance 状态同步节奏（秒）。消费方禁止直接读矩阵 JSON 或复制冻结值，
   * 组合根必须经 contracts/lifecycle/maintenance-behavior.ts 的
   * getMaintenanceSyncIntervalSeconds() 注入。
   */
  readonly maintenanceSyncIntervalSeconds: number;
}

// ---------- 请求解析 ----------

const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * 解析 Sync 请求体（封闭 Schema：仅 lastSyncTime）。
 * body 缺省 → lastSyncTime=null（首次同步）；lastSyncTime 为 null 或 UTC ISO 8601（Z 结尾）。
 */
export function parseSyncRequest(body: unknown): { readonly lastSyncTime: string | null } {
  if (body === undefined || body === null) return { lastSyncTime: null };
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new DeviceSyncError('VALIDATION_FAILED', 'The request body must be an object');
  }
  const keys = Object.keys(body as Record<string, unknown>);
  const unknown = keys.filter((k) => k !== 'lastSyncTime');
  if (unknown.length > 0) {
    throw new DeviceSyncError('VALIDATION_FAILED', `Unknown fields: ${unknown.join(', ')}`);
  }
  const value = (body as Record<string, unknown>).lastSyncTime;
  if (value === undefined || value === null) return { lastSyncTime: null };
  if (typeof value !== 'string' || !UTC_TIMESTAMP_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new DeviceSyncError('VALIDATION_FAILED', 'lastSyncTime must be a UTC ISO 8601 timestamp or null');
  }
  return { lastSyncTime: new Date(value).toISOString() };
}

// ---------- 快照视图 ----------

export interface SyncAssignmentView {
  readonly assignmentId: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly siteId: string;
  readonly siteName: string;
  readonly region: string | null;
  readonly subregion: string | null;
  /** 授权窗口起点。 */
  readonly assignedAt: string;
  /** 授权窗口终点（ACTIVE 分配为 null）。 */
  readonly endedAt: string | null;
}

export interface SyncDeviceView {
  readonly deviceId: string;
  readonly alias: string | null;
  readonly serialNumber: string;
  readonly model: string;
  readonly firmwareVersion: string | null;
}

export interface SyncLicenseView {
  readonly licenseId: string;
  readonly status: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly entitlements: readonly string[];
  /** Issue/Renew 时计算的 HMAC 签名（Draft 为 null）。 */
  readonly signature: string | null;
  readonly version: number;
  /** 查询时点派生：当前是否有效（可支撑设备运行）。 */
  readonly effective: boolean;
}

const LICENSE_STATUS_WIRE_VALUES: Readonly<Record<string, SyncLicenseView['status']>> = {
  Draft: 'DRAFT',
  Issued: 'ISSUED',
  Active: 'ACTIVE',
  ExpiringSoon: 'EXPIRING_SOON',
  Renewed: 'RENEWED',
  Expired: 'EXPIRED',
  Revoked: 'REVOKED',
};

function licenseStatusToWire(status: string): string {
  const wire = LICENSE_STATUS_WIRE_VALUES[status];
  if (!wire)
    throw new DeviceSyncError('VALIDATION_FAILED', 'The license status is not supported by the device protocol');
  return wire;
}

function entitlementToWire(code: string): string {
  return code === 'OTA_UPDATE' ? 'OTA' : code;
}

export interface SyncDeviceUserView {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  /** DEC-004@1.0.0 设备本地专用 Argon2id PHC；仅本域下发。 */
  readonly passwordHash: string;
  readonly status: 'ACTIVE';
}

export interface SyncOperationalStatusView {
  readonly lifecycleStatus: string;
  readonly operationalStatus: string | null;
  readonly connectivity: 'ONLINE' | 'OFFLINE';
  readonly lastHeartbeatAt: string | null;
  /** 设备契约同步节奏（秒）；Maintenance 经 DEC-001 行为矩阵注入。 */
  readonly syncIntervalSeconds: number;
}

export interface DeviceSyncSnapshot {
  readonly deviceId: string;
  /** 服务端快照时点。 */
  readonly snapshotAt: string;
  /** 请求回显（首次同步为 null）。 */
  readonly lastSyncTime: string | null;
  /** 稳定域内容寻址版本（SHA-256 hex）；volatile 域不参与。 */
  readonly etag: string;
  readonly assignment: SyncAssignmentView | null;
  readonly device: SyncDeviceView;
  readonly license: SyncLicenseView | null;
  readonly deviceUsers: readonly SyncDeviceUserView[];
  readonly configuration: EffectiveConfiguration['payload'] | null;
  readonly operationalStatus: SyncOperationalStatusView;
}

// ---------- 行类型与数据访问 ----------

interface DeviceRow {
  readonly id: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly alias: string | null;
  readonly firmwareVersion: string | null;
  readonly customerId: string | null;
  readonly siteId: string | null;
  readonly lifecycleStatus: string;
}

interface AssignmentRow {
  readonly id: string;
  readonly customerId: string;
  readonly siteId: string;
  readonly assignedAt: Date;
  readonly endedAt: Date | null;
}

interface LicenseRow {
  readonly id: string;
  readonly status: string;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly signature: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly entitlements: readonly { readonly code: string; readonly enabled: boolean }[];
}

interface LatestStateRow {
  readonly operationalStatus: string | null;
  readonly lastHeartbeatAt: Date | null;
}

interface NameRow {
  readonly id: string;
  readonly name: string;
}

interface SiteRow extends NameRow {
  readonly region: string | null;
  readonly subregion: string | null;
}

function devices(client: DbClient): {
  findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
} {
  return (client as unknown as Record<string, unknown>).device as never;
}

function deviceAssignments(client: DbClient): {
  findFirst(args: { where: Record<string, unknown> }): Promise<AssignmentRow | null>;
} {
  return (client as unknown as Record<string, unknown>).deviceAssignment as never;
}

function licenses(client: DbClient): {
  findMany(args: Record<string, unknown>): Promise<LicenseRow[]>;
} {
  return (client as unknown as Record<string, unknown>).license as never;
}

function latestStates(client: DbClient): {
  findFirst(args: { where: Record<string, unknown> }): Promise<LatestStateRow | null>;
} {
  return (client as unknown as Record<string, unknown>).deviceLatestState as never;
}

function customers(client: DbClient): {
  findFirst(args: { where: Record<string, unknown> }): Promise<NameRow | null>;
} {
  return (client as unknown as Record<string, unknown>).customer as never;
}

function sites(client: DbClient): {
  findFirst(args: { where: Record<string, unknown> }): Promise<SiteRow | null>;
} {
  return (client as unknown as Record<string, unknown>).site as never;
}

// ---------- 域装配 ----------

const OPERATIONAL_FALLBACK_STATUSES = ['Active', 'Maintenance', 'Suspended', 'Retired'] as const;

/** 有效优先（状态在 EFFECTIVE 集合且在有效期内），否则最新一条（createdAt 倒序首行）。 */
function pickSyncLicense(rows: readonly LicenseRow[], now: Date): LicenseRow | null {
  if (rows.length === 0) return null;
  const effective = rows.find(
    (l) =>
      (EFFECTIVE_LICENSE_STATUSES as readonly string[]).includes(l.status) &&
      l.validFrom.getTime() <= now.getTime() &&
      now.getTime() < l.validTo.getTime(),
  );
  return effective ?? rows[0] ?? null;
}

function toLicenseView(row: LicenseRow, now: Date): SyncLicenseView {
  const inWindow = row.validFrom.getTime() <= now.getTime() && now.getTime() < row.validTo.getTime();
  return {
    licenseId: row.id,
    status: licenseStatusToWire(row.status),
    validFrom: row.validFrom.toISOString().slice(0, 10),
    validTo: row.validTo.toISOString().slice(0, 10),
    entitlements: row.entitlements.filter((e) => e.enabled).map((e) => entitlementToWire(e.code)),
    signature: row.signature,
    version: row.version,
    effective: (EFFECTIVE_LICENSE_STATUSES as readonly string[]).includes(row.status) && inWindow,
  };
}

/** 设备契约同步节奏：Suspended=900；Maintenance 经 DEC-001 注入；其余沿用 Active=300（暂定）。 */
export function deriveSyncIntervalSeconds(
  deps: Pick<DeviceSyncDeps, 'maintenanceSyncIntervalSeconds'>,
  lifecycleStatus: string,
  operationalStatus: string | null,
): number {
  if (operationalStatus === 'Maintenance') return deps.maintenanceSyncIntervalSeconds;
  if (lifecycleStatus === 'Suspended') return SYNC_INTERVAL_SUSPENDED_SECONDS;
  return SYNC_INTERVAL_ACTIVE_SECONDS;
}

/** 稳定域 ETag（内容寻址）：volatile 域（snapshotAt/connectivity/lastHeartbeatAt）不参与。 */
export function computeSnapshotEtag(
  snapshot: Omit<DeviceSyncSnapshot, 'etag' | 'snapshotAt' | 'lastSyncTime'>,
): string {
  const stable = {
    assignment: snapshot.assignment,
    configuration: snapshot.configuration,
    device: snapshot.device,
    deviceUsers: snapshot.deviceUsers,
    license: snapshot.license,
    operationalStatus: {
      lifecycleStatus: snapshot.operationalStatus.lifecycleStatus,
      operationalStatus: snapshot.operationalStatus.operationalStatus,
      syncIntervalSeconds: snapshot.operationalStatus.syncIntervalSeconds,
    },
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

/**
 * 聚合完整事实快照（纯读取）。auth 由 AUTH-03 verifyDeviceCertificate 注入（设备身份
 * 与 customerId 租户边界以证书绑定设备为准）。
 */
export async function buildDeviceSyncSnapshot(
  deps: DeviceSyncDeps,
  auth: DeviceAuthContext,
  input: { readonly lastSyncTime: string | null },
): Promise<DeviceSyncSnapshot> {
  const now = deps.now?.() ?? new Date();
  const device = await devices(deps.client).findFirst({ where: { id: auth.deviceId } });
  // AUTH-03 已校验设备存在；此处防御不存在（证书与设备同事务外被删）
  if (!device) throw new DeviceSyncError('VALIDATION_FAILED', 'The device was not found');

  const [assignment, licenseRows, latestState] = await Promise.all([
    deviceAssignments(deps.client).findFirst({ where: { deviceId: device.id, status: 'ACTIVE' } }),
    licenses(deps.client).findMany({
      where: { deviceId: device.id },
      include: { entitlements: true },
      orderBy: { createdAt: 'desc' },
    }),
    latestStates(deps.client).findFirst({ where: { deviceId: device.id } }),
  ]);

  // Assignment 域：customerId 以设备台账为准（与证书上下文一致），名称/Region 按当前归属读取
  let assignmentView: SyncAssignmentView | null = null;
  if (assignment && device.customerId && device.siteId) {
    const [customer, site] = await Promise.all([
      customers(deps.client).findFirst({ where: { id: assignment.customerId } }),
      sites(deps.client).findFirst({ where: { id: assignment.siteId } }),
    ]);
    if (customer && site) {
      assignmentView = {
        assignmentId: assignment.id,
        customerId: assignment.customerId,
        customerName: customer.name,
        siteId: assignment.siteId,
        siteName: site.name,
        region: site.region,
        subregion: site.subregion,
        assignedAt: assignment.assignedAt.toISOString(),
        endedAt: assignment.endedAt?.toISOString() ?? null,
      };
    }
  }

  // Device Users 域：仅本 Customer + ACTIVE 分配到本设备（租户不串线；未分配 Customer → 空）
  const syncUsers = device.customerId ? await listDeviceUsersForSync(deps, device.customerId) : [];
  const deviceUsers: SyncDeviceUserView[] = syncUsers
    .map((u) => {
      const grant = u.assignments.find((a) => a.deviceId === device.id);
      return grant
        ? {
            userId: u.userId,
            username: u.username,
            displayName: u.displayName,
            passwordHash: u.passwordHash,
            status: u.status,
          }
        : null;
    })
    .filter((u): u is SyncDeviceUserView => u !== null);
  const deliveredUsers = syncUsers.filter((u) => u.assignments.some((assignment) => assignment.deviceId === device.id));

  const license = pickSyncLicense(licenseRows, now);
  const configuration = await resolveEffectiveConfiguration(deps, device.id, now);

  const operationalStatus =
    latestState?.operationalStatus ??
    (OPERATIONAL_FALLBACK_STATUSES.includes(device.lifecycleStatus as (typeof OPERATIONAL_FALLBACK_STATUSES)[number])
      ? device.lifecycleStatus
      : null);

  const operational: SyncOperationalStatusView = {
    lifecycleStatus: device.lifecycleStatus,
    operationalStatus,
    connectivity: deriveConnectivity(latestState?.lastHeartbeatAt ?? null, now, DEFAULT_CONNECTIVITY_THRESHOLD_MS),
    lastHeartbeatAt: latestState?.lastHeartbeatAt?.toISOString() ?? null,
    syncIntervalSeconds: deriveSyncIntervalSeconds(deps, device.lifecycleStatus, operationalStatus),
  };

  const core = {
    deviceId: device.id,
    assignment: assignmentView,
    device: {
      deviceId: device.id,
      alias: device.alias,
      serialNumber: device.serialNumber,
      model: device.model,
      firmwareVersion: device.firmwareVersion,
    },
    license: license ? toLicenseView(license, now) : null,
    deviceUsers,
    configuration: configuration?.payload ?? null,
    operationalStatus: operational,
  };

  // lastSyncTime 是设备声明的上次成功同步时点。只确认此前已提供且不晚于该时点的快照；
  // 对未来时间做 now 上限保护，也不由此推断设备已经应用内容。
  if (input.lastSyncTime) {
    const reported = new Date(input.lastSyncTime);
    const acknowledgedThrough = reported.getTime() <= now.getTime() ? reported : now;
    await syncReceipts(deps.client).updateMany({
      where: { deviceId: device.id, servedAt: { lte: acknowledgedThrough }, acknowledgedAt: null },
      data: { acknowledgedAt: now, deviceReportedLastSyncAt: reported },
    });
  }
  if (deliveredUsers.length > 0) {
    await syncReceipts(deps.client).createMany({
      data: deliveredUsers.map((user) => ({
        deviceId: device.id,
        deviceUserId: user.userId,
        entityVersion: user.version,
        servedAt: now,
      })),
      skipDuplicates: true,
    });
  }

  return {
    ...core,
    snapshotAt: now.toISOString(),
    lastSyncTime: input.lastSyncTime,
    etag: computeSnapshotEtag(core),
  };
}
