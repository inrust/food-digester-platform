/**
 * DEC-011 Region/Subregion/Site 模型策略（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/domain/geo-model-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-011@0.2.0（status=pending，全部为定性规则，已可直接执行）。
 *
 * 消费方：DB-01（Schema 基线）、BE-CUS-02（Site 管理）、BE-DEV-01（设备查询）、FE-05、FE-06。
 */

export type GeoPolicyStatus = 'provisional' | 'frozen';

export type HierarchyNode = 'customer' | 'site' | 'device';
export type SiteGeoAttribute = 'region' | 'subregion';

export interface GeoModelPolicy {
  readonly policyVersion: string;
  readonly status: GeoPolicyStatus;
  readonly hierarchy: {
    readonly chain: readonly HierarchyNode[];
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly geoAttributes: {
    readonly siteAttributes: readonly SiteGeoAttribute[];
    /** 设备不得直接保存重复地域真值，锁定为 false。 */
    readonly deviceStoresGeoTruth: false;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * 暂定值（DEC-011 v0.2.0，pending）：
 * Region/Subregion 为 Site 可筛选属性；设备只关联 Site，不直接保存重复地域真值。
 */
export const GEO_MODEL_POLICY: GeoModelPolicy = {
  policyVersion: '0.1.0',
  status: 'provisional',
  hierarchy: {
    chain: ['customer', 'site', 'device'],
    consumers: ['DB-01', 'BE-CUS-02', 'BE-DEV-01'],
    note: '事实归属层级：Customer → Site → Device。设备仅通过 siteId 关联 Site；禁止设备直接关联 Customer 或地域实体。',
  },
  geoAttributes: {
    siteAttributes: ['region', 'subregion'],
    deviceStoresGeoTruth: false,
    consumers: ['DB-01', 'BE-CUS-02', 'BE-DEV-01', 'FE-05', 'FE-06'],
    note: 'Region/Subregion 是 Site 的可筛选属性（列表筛选、分组展示），不是独立实体，也不构建设备级真值。设备行禁止冗余存储 region/subregion；设备的地域信息一律经 Site 派生查询。',
  },
  pendingParameters: [],
  frozenUpgradePath:
    'DEC-011 冻结时：按 decision-change-template 变更 DEC-011 至 >=1.0.0，status 改 frozen；若层级变化（如 Region 实体化）需迁移 DB-01 Schema 与 BE-CUS-02/BE-DEV-01 查询契约。',
} as const;

/** 归属层级链：customer → site → device。 */
export function getGeoHierarchy(): readonly HierarchyNode[] {
  return GEO_MODEL_POLICY.hierarchy.chain;
}

/** Site 的地域可筛选属性集合。 */
export function getSiteGeoAttributes(): readonly SiteGeoAttribute[] {
  return GEO_MODEL_POLICY.geoAttributes.siteAttributes;
}

/** 是否为 Site 的合法地域筛选属性。未知属性返回 false（失败关闭）。 */
export function isSiteGeoAttribute(attr: string): attr is SiteGeoAttribute {
  return (GEO_MODEL_POLICY.geoAttributes.siteAttributes as readonly string[]).includes(attr);
}

/** 设备的归属关联目标：恒为 site（设备只关联 Site）。 */
export function getDeviceAssociationTarget(): 'site' {
  return 'site';
}

/** 设备是否允许直接保存地域真值：恒为 false（锁定规则）。 */
export function doesDeviceStoreGeoTruth(): boolean {
  return GEO_MODEL_POLICY.geoAttributes.deviceStoresGeoTruth;
}

/** 策略当前状态：provisional 表示 DEC-011 未冻结。 */
export function getGeoPolicyStatus(): GeoPolicyStatus {
  return GEO_MODEL_POLICY.status;
}
