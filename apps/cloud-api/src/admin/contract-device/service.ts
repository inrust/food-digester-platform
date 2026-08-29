/**
 * BE-CON-02 Contract 与 Device 关联 Service（事务服务，框架无关）。
 *
 * 事实源与规则：
 * - 设备与 Contract 必须属于同一 Customer（跨 Customer → 409）；Retired 设备不可关联；
 *   Contract 须为可关联状态（DRAFT/EFFECTIVE/EXPIRING_SOON；EXPIRED/TERMINATED → 409，领域层）；
 * - 默认禁止有效期重叠的多个有效 Contract：关联窗口必须落在合同窗口内（领域校验），
 *   同设备 ACTIVE 关联时间窗重叠 → 409（服务预检 + DB 排他约束 contract_devices_no_overlap 兜底）；
 * - 批量操作全成或全败：单事务（DOM-03 audited）内全部 create/update，任一失败回滚；
 * - 关联事务不得直接改变 Device lifecycle 或 License（DEC-007：解绑不联动撤销 License）；
 * - 关联历史：contract_devices 行（ACTIVE/ENDED + createdAt/endedAt）即历史，审计
 *   contract.devices.bind / contract.devices.unbind 各一次（批量一条审计携带 deviceIds）。
 */
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';
import { assertAssociationWindow, assertContractAssociatable, windowsOverlap } from '@fdp/domain';
import type { ContractStatus } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import { contractConflict, contractNotFound, contractValidationFailed } from '../contract/errors.js';
import { DEFAULT_CONNECTIVITY_THRESHOLD_MS, DEVICE_INCLUDE, deriveConnectivity } from '../device/repository.js';
import type { DeviceRow } from '../device/repository.js';
import { EFFECTIVE_LICENSE_STATUSES } from '../customer/repository.js';

export interface ContractDeviceDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export interface ContractDeviceAssociationView {
  readonly associationId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

/**
 * Contract 详情的设备视图（聚焦 DTO）：ID、别名、Region/Subregion/Site、四轴状态
 * （lifecycle/operational/connectivity/license）、固件 + 租期展示值（association）。
 */
export interface ContractDeviceSnapshot {
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly alias: string | null;
  readonly firmwareVersion: string | null;
  readonly site: { readonly name: string; readonly region: string | null; readonly subregion: string | null } | null;
  readonly lifecycleStatus: string;
  readonly operationalStatus: string | null;
  readonly connectivity: 'ONLINE' | 'OFFLINE';
  /** 授权轴：当前有效 License 状态（无则 null；DOM-02 有效状态集合）。 */
  readonly licenseStatus: string | null;
  readonly lastHeartbeatAt: string | null;
}

export interface ContractDeviceDetailView {
  readonly association: ContractDeviceAssociationView;
  readonly device: ContractDeviceSnapshot;
}

export interface AvailableDeviceView {
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly alias: string | null;
  readonly lifecycleStatus: string;
  readonly site: { readonly name: string; readonly region: string | null; readonly subregion: string | null } | null;
}

interface ContractRowLite {
  readonly id: string;
  readonly contractNumber: string;
  readonly name: string;
  readonly customerId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly status: string;
}

interface AssociationRow {
  readonly id: string;
  readonly contractId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  readonly status: string;
  readonly createdAt: Date;
  readonly endedAt: Date | null;
}

interface ContractDelegate {
  findFirst(args: Record<string, unknown>): Promise<ContractRowLite | null>;
}

interface AssociationDelegate {
  findMany(args: Record<string, unknown>): Promise<AssociationRow[]>;
  create(args: { data: Record<string, unknown> }): Promise<AssociationRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface DeviceDelegate {
  findMany(args: Record<string, unknown>): Promise<DeviceRow[]>;
}

function contracts(client: DbClient): ContractDelegate {
  return (client as unknown as Record<string, unknown>).contract as ContractDelegate;
}

function associations(client: DbClient): AssociationDelegate {
  return (client as unknown as Record<string, unknown>).contractDevice as AssociationDelegate;
}

function devices(client: DbClient): DeviceDelegate {
  return (client as unknown as Record<string, unknown>).device as DeviceDelegate;
}

/** DB 排他约束（contract_devices_no_overlap，23P01）兜底判定。 */
function isOverlapViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string } } | null;
  return (
    e?.code === 'P2010' && (e.meta?.code === '23P01' || JSON.stringify(err).includes('contract_devices_no_overlap'))
  );
}

function toAssociationView(row: AssociationRow): ContractDeviceAssociationView {
  return {
    associationId: row.id,
    deviceId: row.deviceId,
    customerId: row.customerId,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo?.toISOString() ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

async function loadContract(client: DbClient, contractId: string): Promise<ContractRowLite> {
  const row = await contracts(client).findFirst({ where: { id: contractId } });
  if (!row) throw contractNotFound();
  return row;
}

/** 聚焦快照：四轴状态（连接由心跳阈值派生，不写回；授权取有效 License 状态）。 */
function toDeviceSnapshot(row: DeviceRow, now: Date): ContractDeviceSnapshot {
  const license =
    row.licenses.find((l) => (EFFECTIVE_LICENSE_STATUSES as readonly string[]).includes(l.status)) ?? null;
  return {
    deviceId: row.id,
    serialNumber: row.serialNumber,
    model: row.model,
    alias: row.alias,
    firmwareVersion: row.firmwareVersion,
    site: row.site ? { name: row.site.name, region: row.site.region, subregion: row.site.subregion } : null,
    lifecycleStatus: row.lifecycleStatus,
    operationalStatus: row.latestState?.operationalStatus ?? null,
    connectivity: deriveConnectivity(row.latestState?.lastHeartbeatAt ?? null, now, DEFAULT_CONNECTIVITY_THRESHOLD_MS),
    licenseStatus: license?.status ?? null,
    lastHeartbeatAt: row.latestState?.lastHeartbeatAt?.toISOString() ?? null,
  };
}

/** 设备集合预检：全部存在（404）、同一 Customer（409）、非 Retired（409）。 */
async function loadAndCheckDevices(
  client: DbClient,
  contract: ContractRowLite,
  deviceIds: readonly string[],
): Promise<DeviceRow[]> {
  const rows = await devices(client).findMany({ where: { id: { in: [...deviceIds] } }, include: DEVICE_INCLUDE });
  if (rows.length !== deviceIds.length) throw contractNotFound();
  for (const row of rows) {
    if (row.customerId !== contract.customerId) {
      throw contractConflict(`The device ${row.id} does not belong to the contract customer`);
    }
    if (row.lifecycleStatus === 'Retired') {
      throw contractConflict(`The device ${row.id} is retired`);
    }
  }
  return rows;
}

// ---------- 读路径 ----------

/** Contract 详情的已关联设备（contract:read）：设备聚焦快照（四轴/固件/Region/Site）+ 租期展示值。 */
export async function listContractDevices(
  deps: ContractDeviceDeps,
  contractId: string,
): Promise<ContractDeviceDetailView[]> {
  const now = deps.now?.() ?? new Date();
  await loadContract(deps.client, contractId);
  const rows = await associations(deps.client).findMany({
    where: { contractId, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return [];
  const deviceRows = await devices(deps.client).findMany({
    where: { id: { in: rows.map((r) => r.deviceId) } },
    include: DEVICE_INCLUDE,
  });
  const byId = new Map(deviceRows.map((r) => [r.id, r]));
  return rows
    .filter((r) => byId.has(r.deviceId))
    .map((r) => ({
      association: toAssociationView(r),
      device: toDeviceSnapshot(byId.get(r.deviceId) as DeviceRow, now),
    }));
}

/** 可关联设备（contract:read）：同 Customer、非 Retired、当前无 ACTIVE 关联。 */
export async function listAvailableDevices(
  deps: ContractDeviceDeps,
  contractId: string,
): Promise<AvailableDeviceView[]> {
  const contract = await loadContract(deps.client, contractId);
  const active = await associations(deps.client).findMany({ where: { status: 'ACTIVE' } });
  const boundIds = new Set(active.map((r) => r.deviceId));
  const rows = await devices(deps.client).findMany({
    where: { customerId: contract.customerId, lifecycleStatus: { not: 'Retired' } },
    include: DEVICE_INCLUDE,
    orderBy: { id: 'asc' },
  });
  return rows
    .filter((r) => !boundIds.has(r.id))
    .map((r) => ({
      deviceId: r.id,
      serialNumber: r.serialNumber,
      model: r.model,
      alias: r.alias,
      lifecycleStatus: r.lifecycleStatus,
      site: r.site ? { name: r.site.name, region: r.site.region, subregion: r.site.subregion } : null,
    }));
}

/** 关联历史（contract:read）：全部 ACTIVE/ENDED 行，创建倒序。 */
export async function listContractAssociations(
  deps: ContractDeviceDeps,
  contractId: string,
): Promise<ContractDeviceAssociationView[]> {
  await loadContract(deps.client, contractId);
  const rows = await associations(deps.client).findMany({
    where: { contractId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 200,
  });
  return rows.map(toAssociationView);
}

// ---------- 写路径（批量全成或全败） ----------

export interface BindDevicesInput {
  readonly deviceIds: readonly string[];
  /** 关联窗口（缺省 = 合同窗口）。 */
  readonly validFrom?: Date | undefined;
  readonly validTo?: Date | undefined;
  readonly reason: string;
}

export interface BindDevicesResult {
  readonly contractId: string;
  readonly bound: readonly string[];
  readonly associations: readonly ContractDeviceAssociationView[];
}

/** 批量关联（contract:write）：同事务全成或全败；重叠租期/跨 Customer/重复关联 → 409。 */
export async function bindContractDevices(
  deps: ContractDeviceDeps,
  actor: ActorContext,
  contractId: string,
  input: BindDevicesInput,
): Promise<BindDevicesResult> {
  const deviceIds = [...new Set(input.deviceIds)];
  if (deviceIds.length === 0) throw contractValidationFailed('deviceIds must be a non-empty array');
  const contract = await loadContract(deps.client, contractId);
  assertContractAssociatable(contract.status as ContractStatus);
  const validFrom = input.validFrom ?? contract.startAt;
  const validTo = input.validTo ?? contract.endAt;
  assertAssociationWindow(contract, validFrom, validTo);
  await loadAndCheckDevices(deps.client, contract, deviceIds);

  // 预检：同设备 ACTIVE 关联时间窗重叠（重复关联/重叠租期）→ 409；DB 排他约束兜底
  const existing = await associations(deps.client).findMany({
    where: { deviceId: { in: deviceIds }, status: 'ACTIVE' },
  });
  for (const row of existing) {
    const existingTo = row.validTo ?? new Date('9999-12-31T00:00:00Z');
    if (windowsOverlap(validFrom, validTo, row.validFrom, existingTo)) {
      throw contractConflict(`The device ${row.deviceId} already has an overlapping active contract association`);
    }
  }

  try {
    return await audited<BindDevicesResult>(
      deps.client,
      {
        objectType: 'contract',
        objectId: contractId,
        action: 'contract.devices.bind',
        reason: input.reason,
        actorId: actor.actorId,
        actorRole: actor.roles[0],
        customerId: contract.customerId,
        afterValue: { deviceIds, validFrom: validFrom.toISOString(), validTo: validTo.toISOString() },
      },
      async (tx) => {
        const created: ContractDeviceAssociationView[] = [];
        for (const deviceId of deviceIds) {
          const row = await associations(tx).create({
            data: {
              contractId,
              deviceId,
              customerId: contract.customerId,
              validFrom,
              validTo,
              status: 'ACTIVE',
            },
          });
          created.push(toAssociationView(row));
        }
        return { contractId, bound: deviceIds, associations: created };
      },
    );
  } catch (err) {
    if (isOverlapViolation(err)) {
      throw contractConflict('The association window overlaps an existing active association');
    }
    throw err;
  }
}

export interface UnbindDevicesInput {
  readonly deviceIds: readonly string[];
  readonly reason: string;
}

export interface UnbindDevicesResult {
  readonly contractId: string;
  readonly unbound: readonly string[];
}

/**
 * 批量解绑（contract:write）：同事务全成或全败；任一设备无本合同 ACTIVE 关联 → 409。
 * DEC-007：不联动撤销 License，不改变 Device lifecycle。
 */
export async function unbindContractDevices(
  deps: ContractDeviceDeps,
  actor: ActorContext,
  contractId: string,
  input: UnbindDevicesInput,
): Promise<UnbindDevicesResult> {
  const now = deps.now?.() ?? new Date();
  const deviceIds = [...new Set(input.deviceIds)];
  if (deviceIds.length === 0) throw contractValidationFailed('deviceIds must be a non-empty array');
  const contract = await loadContract(deps.client, contractId);

  const active = await associations(deps.client).findMany({
    where: { contractId, deviceId: { in: deviceIds }, status: 'ACTIVE' },
  });
  const activeIds = new Set(active.map((r) => r.deviceId));
  const missing = deviceIds.filter((id) => !activeIds.has(id));
  if (missing.length > 0) {
    throw contractConflict(`The device(s) ${missing.join(', ')} have no active association on this contract`);
  }

  return audited<UnbindDevicesResult>(
    deps.client,
    {
      objectType: 'contract',
      objectId: contractId,
      action: 'contract.devices.unbind',
      reason: input.reason,
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: contract.customerId,
      beforeValue: { deviceIds },
      afterValue: { unbound: deviceIds },
    },
    async (tx) => {
      // 闭合窗口：validTo = max(now, validFrom)（未来生效的关联解绑后为空区间，不再占排他约束）
      for (const row of active) {
        const closeAt = row.validFrom.getTime() > now.getTime() ? row.validFrom : now;
        const { count } = await associations(tx).updateMany({
          where: { id: row.id, status: 'ACTIVE' },
          data: { status: 'ENDED', endedAt: now, validTo: closeAt },
        });
        if (count !== 1) {
          throw contractConflict('The association was changed concurrently; refresh and retry');
        }
      }
      return { contractId, unbound: deviceIds };
    },
  );
}
