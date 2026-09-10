/**
 * BE-DEV-01 Device 台账查询 Repository（只读）。
 *
 * 数据来源（原型设备群表格字段映射）：
 * - 序列号/型号/硬件版本/厂商/生产日期/别名/固件/生命周期：devices 台账行；
 * - Customer/Site/Region/Subregion：customer/site 关系（Region/Subregion 只取 Site，DEC-011）；
 * - Operational 状态/最新 Heartbeat：device_latest_state；连接状态由 lastHeartbeatAt 与
 *   明确阈值派生（ONLINE/OFFLINE），不写回任何状态字段；
 * - 证书摘要：device_certificates 当前证书（ACTIVE 优先，否则最新）的 certificateId +
 *   fingerprint（摘要）；绝不返回 certificatePem/packageCiphertext/私钥；
 * - License/Entitlement：licenses + license_entitlements（有效状态优先，否则最新）；
 * - Contract 摘要：contract_devices(ACTIVE) → contracts，按页 id 集合批量查询。
 *
 * N+1 控制：列表 = 1 次 device.findMany（关系 include）+ 1 次 contractDevice.findMany（IN 页内 id）。
 */
import { LIFECYCLE_STATUSES, LICENSE_STATUSES, OPERATIONAL_STATUSES } from '@fdp/domain';
import type { DbClient } from '@fdp/database';
import { decodeKeysetCursor, encodeKeysetCursor, normalizeLimit } from '@fdp/database';
import type { Page } from '@fdp/database';
import { EFFECTIVE_LICENSE_STATUSES } from '../customer/repository.js';
import { deviceValidationFailed } from './errors.js';

/** DEC-024@1.0.0：lastHeartbeatAt 距 now 不超过 10 分钟（包含边界）视为 ONLINE。 */
export const DEFAULT_CONNECTIVITY_THRESHOLD_MS = 10 * 60 * 1000;

export const CONNECTIVITY_STATUSES = ['ONLINE', 'OFFLINE'] as const;
/** 授权筛选：DOM-02 状态 + None（无任何 License 行）。 */
export const LICENSE_FILTER_VALUES = [...LICENSE_STATUSES, 'None'] as const;

// ---------- 行类型（含 include 关系） ----------

export interface DeviceRow {
  readonly id: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly hardwareVersion: string;
  readonly manufacturer: string;
  readonly manufactureDate: Date;
  readonly alias: string | null;
  readonly customerId: string | null;
  readonly siteId: string | null;
  readonly lifecycleStatus: string;
  readonly firmwareVersion: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly customer: { readonly id: string; readonly name: string } | null;
  readonly site: {
    readonly id: string;
    readonly name: string;
    readonly region: string | null;
    readonly subregion: string | null;
  } | null;
  readonly latestState: {
    readonly lastHeartbeatAt: Date | null;
    readonly operationalStatus: string | null;
  } | null;
  readonly certificates: readonly {
    readonly id: string;
    readonly fingerprint: string;
    readonly status: string;
    readonly createdAt: Date;
  }[];
  readonly licenses: readonly {
    readonly id: string;
    readonly status: string;
    readonly validFrom: Date;
    readonly validTo: Date;
    readonly createdAt: Date;
    readonly entitlements: readonly { readonly code: string; readonly enabled: boolean }[];
  }[];
}

interface ContractDeviceRow {
  readonly deviceId: string;
  readonly contract: {
    readonly id: string;
    readonly contractNumber: string;
    readonly name: string;
    readonly status: string;
    readonly endAt: Date;
  };
}

interface DeviceDelegate {
  findFirst(args: Record<string, unknown>): Promise<DeviceRow | null>;
  findMany(args: Record<string, unknown>): Promise<DeviceRow[]>;
}

interface ContractDeviceDelegate {
  findMany(args: Record<string, unknown>): Promise<ContractDeviceRow[]>;
}

function devices(client: DbClient): DeviceDelegate {
  return (client as unknown as Record<string, unknown>).device as DeviceDelegate;
}

function contractDevices(client: DbClient): ContractDeviceDelegate {
  return (client as unknown as Record<string, unknown>).contractDevice as ContractDeviceDelegate;
}

/** 设备台账关系 include（BE-CON-02 等复用）。 */
export const DEVICE_INCLUDE = {
  customer: { select: { id: true, name: true } },
  site: { select: { id: true, name: true, region: true, subregion: true } },
  latestState: { select: { lastHeartbeatAt: true, operationalStatus: true } },
  certificates: {
    select: { id: true, fingerprint: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  },
  licenses: {
    select: {
      id: true,
      status: true,
      validFrom: true,
      validTo: true,
      createdAt: true,
      entitlements: { select: { code: true, enabled: true } },
    },
    orderBy: { createdAt: 'desc' },
  },
} as const;

// ---------- DTO ----------

export interface DeviceDto {
  readonly id: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly hardwareVersion: string;
  readonly manufacturer: string;
  readonly manufactureDate: string;
  readonly alias: string | null;
  readonly firmwareVersion: string | null;
  readonly customer: { readonly id: string; readonly name: string } | null;
  readonly site: {
    readonly id: string;
    readonly name: string;
    readonly region: string | null;
    readonly subregion: string | null;
  } | null;
  readonly lifecycleStatus: string;
  readonly operationalStatus: string | null;
  readonly connectivity: 'ONLINE' | 'OFFLINE';
  readonly lastHeartbeatAt: string | null;
  readonly certificate: {
    readonly certificateId: string;
    readonly fingerprint: string;
    readonly status: string;
  } | null;
  readonly license: {
    readonly licenseId: string;
    readonly status: string;
    readonly validFrom: string;
    readonly validTo: string;
    readonly entitlements: readonly string[];
  } | null;
  readonly contract: {
    readonly contractId: string;
    readonly contractNumber: string;
    readonly name: string;
    readonly status: string;
    readonly endAt: string;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 连接状态派生：lastHeartbeatAt 距 now 不超过阈值 → ONLINE，否则 OFFLINE（纯函数，不写回）。 */
export function deriveConnectivity(lastHeartbeatAt: Date | null, now: Date, thresholdMs: number): 'ONLINE' | 'OFFLINE' {
  if (!lastHeartbeatAt) return 'OFFLINE';
  return now.getTime() - lastHeartbeatAt.getTime() <= thresholdMs ? 'ONLINE' : 'OFFLINE';
}

function pickCurrentCertificate(row: DeviceRow): DeviceRow['certificates'][number] | null {
  if (row.certificates.length === 0) return null;
  return row.certificates.find((c) => c.status === 'ACTIVE') ?? row.certificates[0] ?? null;
}

/** 有效 License 状态取自 admin/customer 模块（DOM-02 isLicenseEffective 的状态集合；台账展示按状态判定）。 */
function pickCurrentLicense(row: DeviceRow): DeviceRow['licenses'][number] | null {
  if (row.licenses.length === 0) return null;
  return (
    row.licenses.find((l) => (EFFECTIVE_LICENSE_STATUSES as readonly string[]).includes(l.status)) ??
    row.licenses[0] ??
    null
  );
}

export function toDeviceDto(
  row: DeviceRow,
  contract: ContractDeviceRow['contract'] | null,
  now: Date,
  thresholdMs: number,
): DeviceDto {
  const certificate = pickCurrentCertificate(row);
  const license = pickCurrentLicense(row);
  return {
    id: row.id,
    serialNumber: row.serialNumber,
    model: row.model,
    hardwareVersion: row.hardwareVersion,
    manufacturer: row.manufacturer,
    manufactureDate: row.manufactureDate.toISOString().slice(0, 10),
    alias: row.alias,
    firmwareVersion: row.firmwareVersion,
    customer: row.customer,
    site: row.site,
    lifecycleStatus: row.lifecycleStatus,
    operationalStatus: row.latestState?.operationalStatus ?? null,
    connectivity: deriveConnectivity(row.latestState?.lastHeartbeatAt ?? null, now, thresholdMs),
    lastHeartbeatAt: row.latestState?.lastHeartbeatAt?.toISOString() ?? null,
    certificate: certificate
      ? { certificateId: certificate.id, fingerprint: certificate.fingerprint, status: certificate.status }
      : null,
    license: license
      ? {
          licenseId: license.id,
          status: license.status,
          validFrom: license.validFrom.toISOString().slice(0, 10),
          validTo: license.validTo.toISOString().slice(0, 10),
          entitlements: license.entitlements.filter((e) => e.enabled).map((e) => e.code),
        }
      : null,
    contract: contract
      ? {
          contractId: contract.id,
          contractNumber: contract.contractNumber,
          name: contract.name,
          status: contract.status,
          endAt: contract.endAt.toISOString(),
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------- 查询 ----------

async function loadActiveContracts(
  client: DbClient,
  deviceIds: readonly string[],
): Promise<Map<string, ContractDeviceRow['contract']>> {
  const map = new Map<string, ContractDeviceRow['contract']>();
  if (deviceIds.length === 0) return map;
  const rows = await contractDevices(client).findMany({
    where: { deviceId: { in: [...deviceIds] }, status: 'ACTIVE' },
    include: { contract: { select: { id: true, contractNumber: true, name: true, status: true, endAt: true } } },
  });
  for (const row of rows) if (!map.has(row.deviceId)) map.set(row.deviceId, row.contract);
  return map;
}

export interface DeviceWithContract {
  readonly row: DeviceRow;
  readonly contract: ContractDeviceRow['contract'] | null;
}

export async function findDeviceById(client: DbClient, id: string): Promise<DeviceWithContract | null> {
  const row = await devices(client).findFirst({ where: { id }, include: DEVICE_INCLUDE });
  if (!row) return null;
  const contracts = await loadActiveContracts(client, [row.id]);
  return { row, contract: contracts.get(row.id) ?? null };
}

export interface DeviceListOptions {
  readonly customerId?: string | undefined;
  readonly siteId?: string | undefined;
  readonly region?: string | undefined;
  readonly subregion?: string | undefined;
  readonly lifecycleStatus?: string | undefined;
  readonly operationalStatus?: string | undefined;
  readonly connectivity?: string | undefined;
  readonly licenseStatus?: string | undefined;
  readonly model?: string | undefined;
  readonly keyword?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | number | undefined;
  readonly now: Date;
  readonly connectivityThresholdMs: number;
}

function assertEnum(value: string | undefined, allowed: readonly string[], field: string): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw deviceValidationFailed(`${field} must be one of: ${allowed.join(', ')}`);
  }
}

/** 构建组合筛选 where（四轴 + Customer/Site/Region/Subregion/型号/关键字，以 AND 组合互不覆盖）。 */
export function buildDeviceListWhere(options: DeviceListOptions): Record<string, unknown> {
  assertEnum(options.lifecycleStatus, LIFECYCLE_STATUSES, 'lifecycleStatus');
  assertEnum(options.operationalStatus, OPERATIONAL_STATUSES, 'operationalStatus');
  assertEnum(options.connectivity, CONNECTIVITY_STATUSES, 'connectivity');
  assertEnum(options.licenseStatus, LICENSE_FILTER_VALUES, 'licenseStatus');

  const where: Record<string, unknown> = {};
  if (options.customerId) where.customerId = options.customerId;
  if (options.siteId) where.siteId = options.siteId;
  if (options.model) where.model = options.model;
  if (options.lifecycleStatus) where.lifecycleStatus = options.lifecycleStatus;

  const and: Record<string, unknown>[] = [];
  if (options.region) and.push({ site: { region: options.region } });
  if (options.subregion) and.push({ site: { subregion: options.subregion } });
  if (options.operationalStatus) and.push({ latestState: { operationalStatus: options.operationalStatus } });
  if (options.connectivity) {
    const thresholdTime = new Date(options.now.getTime() - options.connectivityThresholdMs);
    if (options.connectivity === 'ONLINE') {
      and.push({ latestState: { lastHeartbeatAt: { gte: thresholdTime } } });
    } else {
      // OFFLINE：心跳超时 / 无心跳 / 无 latestState 行
      and.push({
        OR: [
          { latestState: { lastHeartbeatAt: { lt: thresholdTime } } },
          { latestState: { lastHeartbeatAt: null } },
          { latestState: { is: null } },
        ],
      });
    }
  }
  if (options.licenseStatus === 'None') {
    and.push({ licenses: { none: {} } });
  } else if (options.licenseStatus) {
    and.push({ licenses: { some: { status: options.licenseStatus } } });
  }
  if (options.keyword) {
    const contains = { contains: options.keyword, mode: 'insensitive' };
    and.push({ OR: [{ serialNumber: contains }, { alias: contains }, { id: contains }] });
  }
  if (and.length > 0) where.AND = and;
  return where;
}

/** 键集游标分页（id ASC，DB-02 游标语义）+ 组合筛选；Contract 摘要按页批量装配。 */
export async function listDevices(client: DbClient, options: DeviceListOptions): Promise<Page<DeviceWithContract>> {
  const limit = normalizeLimit(options.limit ?? null);
  const after = decodeKeysetCursor(options.cursor ?? null);
  const where = buildDeviceListWhere(options);
  if (after) where.id = { gt: after };
  const rows = await devices(client).findMany({
    where,
    include: DEVICE_INCLUDE,
    orderBy: { id: 'asc' },
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const contracts = await loadActiveContracts(
    client,
    page.map((r) => r.id),
  );
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({ row, contract: contracts.get(row.id) ?? null })),
    nextCursor: rows.length > limit && last ? encodeKeysetCursor(last.id) : null,
  };
}
