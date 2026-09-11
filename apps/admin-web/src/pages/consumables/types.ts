/**
 * FE-18 耗材数据类型：镜像 admin-consumable-api.json（BE-CNS-01）与
 * admin-consumable-request-api.json（BE-CNS-02）。
 */

/** DEC-008 封闭集合（未知名称失败关闭，不进入展示）。 */
export type ConsumableType = 'CARBON_FILTER' | 'BIO_ADDITIVE';

export interface ConsumableValueView {
  /** 设备上报剩余百分比；未上报为 null（云端不臆测，绝不默认 50%）。 */
  readonly remainingPercent: number | null;
  /** 展示值：'<n>%' 或 'unknown'。 */
  readonly remainingDisplay: string;
  /** observedAt 超阈值或未上报 → true（读取时点派生）。 */
  readonly stale: boolean;
  readonly observedAt: string | null;
  readonly sourceMessageId: string | null;
}

export interface ConsumableSiteView {
  readonly siteId: string;
  readonly name: string;
  readonly region: string | null;
  readonly subregion: string | null;
}

/** 设备联系人授权摘要；未授权角色（Auditor/CustomerViewer）为 null。 */
export interface ConsumableContactView {
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
}

export interface ConsumableStatusView {
  readonly deviceId: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly alias: string | null;
  readonly lifecycleStatus: string;
  readonly site: ConsumableSiteView | null;
  readonly connectivity: 'ONLINE' | 'OFFLINE';
  readonly consumables: {
    readonly CARBON_FILTER: ConsumableValueView | null;
    readonly BIO_ADDITIVE: ConsumableValueView | null;
  };
  readonly contact: ConsumableContactView | null;
}

// ---------- 更换申请（BE-CNS-02） ----------

export type ConsumableRequestStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'CANCELLED';

export interface ConsumableRequestView {
  readonly requestId: string;
  readonly customerId: string;
  readonly deviceId: string;
  readonly consumableType: ConsumableType;
  readonly status: ConsumableRequestStatus;
  /** 协议冻结前仅管理端创建（ADMIN）。 */
  readonly source: 'ADMIN';
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly processedBy: string | null;
  readonly processNote: string | null;
  readonly completedAt: string | null;
  /** 乐观锁版本（状态迁移 If-Match 回传）。 */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 创建结果（开放申请重复创建幂等返回现有记录时 replayed=true）。 */
export interface ConsumableRequestCreateResult {
  readonly request: ConsumableRequestView;
  readonly replayed: boolean;
}
