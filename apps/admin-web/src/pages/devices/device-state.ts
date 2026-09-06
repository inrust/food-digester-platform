/**
 * FE-06 设备页纯逻辑：10 类传感器展示目录、部件状态文案、筛选选项、CT-06 字段覆盖表。
 *
 * 事实源：
 * - 10 类传感器读数：原型 index19.html sensor-grid（功耗/湿度/筒仓温度/热泵温度/厨余重量/马达电流/氧气/二氧化碳/甲烷/一氧化二氮）
 *   × admin-device-console-api.json MetricsBlock 键集（契约测试锁定键名与单位）；
 * - 部件状态：ComponentStatus 五键（overall/temperature/humidity/weight/gas，传感器健康，非执行器状态——原型
 *   “设备当前运作状态”（搅拌器/热泵/舱门）无 API 来源，不展示）；
 * - 筛选枚举：admin-device-api.json listDevices 参数枚举（契约测试锁定）。
 */

// ---------- 10 类传感器读数（固定顺序） ----------

export interface MetricDisplay {
  readonly key: string;
  readonly label: string;
}

export const SENSOR_METRICS: readonly MetricDisplay[] = [
  { key: 'powerConsumptionKw', label: '功耗' },
  { key: 'humidityPct', label: '湿度' },
  { key: 'siloTemperatureC', label: '筒仓温度' },
  { key: 'heatTemperatureC', label: '热泵温度' },
  { key: 'chamberWeightKg', label: '厨余重量' },
  { key: 'currentAmp', label: '马达电流' },
  { key: 'o2Pct', label: '氧气' },
  { key: 'co2Ppm', label: '二氧化碳' },
  { key: 'ch4Ppm', label: '甲烷' },
  { key: 'n2oPpm', label: '一氧化二氮' },
];

// ---------- 部件（传感器健康）状态 ----------

export const COMPONENT_LABELS = {
  overall: '整体',
  temperature: '温度传感器',
  humidity: '湿度传感器',
  weight: '重量传感器',
  gas: '气体传感器',
} as const;

export const COMPONENT_HEALTH_LABELS: Readonly<Record<string, string>> = {
  NORMAL: '正常',
  WARNING: '警告',
  FAILED: '故障',
};

// ---------- 列表筛选枚举（与 listDevices 参数 enum 一致，契约测试锁定） ----------

export const LIFECYCLE_FILTER_OPTIONS = [
  'PendingOnboarding',
  'Rejected',
  'OnboardingApproved',
  'Onboarded',
  'Assigned',
  'Licensed',
  'Active',
  'Suspended',
  'Retired',
] as const;

export const OPERATIONAL_FILTER_OPTIONS = ['Active', 'Maintenance', 'Suspended', 'Retired'] as const;

export const CONNECTIVITY_FILTER_OPTIONS = ['ONLINE', 'OFFLINE'] as const;

export const LICENSE_FILTER_OPTIONS = [
  'Draft',
  'Issued',
  'Active',
  'ExpiringSoon',
  'Renewed',
  'Expired',
  'Revoked',
  'None',
] as const;

/** licenseStatus 筛选项 None 的展示名（区别于 license 轴的 NoLicense）。 */
export const LICENSE_FILTER_LABELS: Readonly<Record<string, string>> = {
  Draft: '草稿',
  Issued: '已签发',
  Active: '授权有效',
  ExpiringSoon: '即将到期',
  Renewed: '已续期',
  Expired: '已到期',
  Revoked: '已撤销',
  None: '无授权',
};

// ---------- CT-06 字段覆盖表（elementId → 实现锚点 testid/说明；parity 测试核对 100% 覆盖） ----------

export const DEVICE_GROUP_COVERAGE: Readonly<Record<string, string>> = {
  'device-group.button.search': 'device-search',
  'device-group.button.reset': 'device-reset',
  'device-group.column.seq': 'col-seq',
  'device-group.column.region': 'col-region',
  'device-group.column.subregion': 'col-subregion',
  'device-group.column.deviceId': 'col-device-id',
  'device-group.column.alias': 'col-alias',
  'device-group.column.contractName': 'col-contract-name',
  'device-group.column.leaseTerm': 'col-lease-term',
  'device-group.column.firmware': 'col-firmware',
  'device-group.field.fourAxisStatus': 'col-four-axis',
  'device-group.column.actions': 'col-actions',
  'device-group.req.column.deviceId': 'onboarding-panel',
  'device-group.req.column.requestDate': 'onboarding-panel',
  'device-group.req.button.detail': 'onboarding-panel',
  'device-group.req.button.accept': 'onboarding-panel',
  'device-group.req.button.reject': 'onboarding-panel',
};

export const DEVICE_VIEW_COVERAGE: Readonly<Record<string, string>> = {
  'device-view.filter.region': 'scope-filter',
  'device-view.filter.subregion': 'scope-filter',
  'device-view.filter.device': 'scope-filter',
  'device-view.button.apply': 'view-apply',
  'device-view.field.componentStates': 'console-components',
  'device-view.field.sensorReadings': 'console-sensors',
  'device-view.field.consumables': 'console-consumables',
  'device-view.field.recentAlarms': 'console-alarms',
  'device-view.field.esg7d': 'console-esg7d',
  'device-view.field.mediaPreview': 'console-media',
};
