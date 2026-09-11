/**
 * FE-17 Contract 数据类型：镜像 admin-contract-api.json（BE-CON-01）与
 * admin-contract-device-api.json（BE-CON-02）。
 */

export type ContractStatus = 'DRAFT' | 'EFFECTIVE' | 'EXPIRING_SOON' | 'EXPIRED' | 'TERMINATED';

/** Contract 视图（contact 最小权限：仅 SuperAdmin/Operator 可见，Auditor 为 null）。 */
export interface ContractView {
  readonly contractId: string;
  readonly contractNumber: string;
  readonly name: string;
  readonly customerId: string;
  readonly contact: string | null;
  readonly startAt: string;
  readonly endAt: string;
  /** 落库状态（显式动作 + evaluate 写入）。 */
  readonly status: ContractStatus;
  /** 查询时点派生状态（不写回；列表筛选依据）。 */
  readonly derivedStatus: ContractStatus;
  /** 乐观锁版本（写操作 If-Match 回传）。 */
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------- 关联设备（BE-CON-02） ----------

export interface ContractDeviceSiteView {
  readonly name: string;
  readonly region: string | null;
  readonly subregion: string | null;
}

export type AssociationStatus = 'ACTIVE' | 'ENDED';

export interface ContractDeviceAssociationView {
  readonly associationId: string;
  readonly deviceId: string;
  readonly customerId: string;
  readonly validFrom: string;
  /** 租期展示值（解绑后闭合）。 */
  readonly validTo: string | null;
  readonly status: AssociationStatus;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export interface ContractDeviceSnapshotView {
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly alias: string | null;
  readonly firmwareVersion: string | null;
  readonly site: ContractDeviceSiteView | null;
  readonly lifecycleStatus: string;
  readonly operationalStatus: string | null;
  readonly connectivity: 'ONLINE' | 'OFFLINE';
  readonly licenseStatus: string | null;
  readonly lastHeartbeatAt: string | null;
}

export interface ContractDeviceDetailView {
  readonly association: ContractDeviceAssociationView;
  readonly device: ContractDeviceSnapshotView;
}

/** 可关联设备（同 Customer、非 Retired、当前无 ACTIVE 关联——eligible 列表之外不可选）。 */
export interface AvailableDeviceView {
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly alias: string | null;
  readonly lifecycleStatus: string;
  readonly site: ContractDeviceSiteView | null;
}

export interface ContractListState {
  readonly rows: readonly ContractView[] | null;
  readonly loading?: boolean;
  readonly error?: unknown;
}
