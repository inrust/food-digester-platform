import { translate } from '../../i18n/i18n.js';
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
  {
    key: 'powerConsumptionKw',
    get label() {
      return translate('ui.a9c86e827028');
    },
  },
  {
    key: 'humidityPct',
    get label() {
      return translate('ui.dee19da50fba');
    },
  },
  {
    key: 'siloTemperatureC',
    get label() {
      return translate('ui.773cff2fc430');
    },
  },
  {
    key: 'heatTemperatureC',
    get label() {
      return translate('ui.76247f82b376');
    },
  },
  {
    key: 'chamberWeightKg',
    get label() {
      return translate('ui.0a1f64270354');
    },
  },
  {
    key: 'currentAmp',
    get label() {
      return translate('ui.0d6f4c36b662');
    },
  },
  {
    key: 'o2Pct',
    get label() {
      return translate('ui.74f2ea55960d');
    },
  },
  {
    key: 'co2Ppm',
    get label() {
      return translate('ui.d5bfbbe81601');
    },
  },
  {
    key: 'ch4Ppm',
    get label() {
      return translate('ui.f154679c36c7');
    },
  },
  {
    key: 'n2oPpm',
    get label() {
      return translate('ui.f276493c8d91');
    },
  },
];
// ---------- 部件（传感器健康）状态 ----------
export const COMPONENT_LABELS = {
  get overall() {
    return translate('ui.f0e2bbbacc91');
  },
  get temperature() {
    return translate('ui.836b876c873e');
  },
  get humidity() {
    return translate('ui.80a985f6e8c3');
  },
  get weight() {
    return translate('ui.a8f128966e73');
  },
  get gas() {
    return translate('ui.89dc8900c7d6');
  },
} as const;
export const COMPONENT_HEALTH_LABELS: Readonly<Record<string, string>> = {
  get NORMAL() {
    return translate('page.f78d037abccd');
  },
  get WARNING() {
    return translate('ui.5521e368d87e');
  },
  get FAILED() {
    return translate('ui.5e3fe540b9de');
  },
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
  get Draft() {
    return translate('ui.0f436818c0b4');
  },
  get Issued() {
    return translate('ui.e54802e82b5d');
  },
  get Active() {
    return translate('ui.61f56cfb99e7');
  },
  get ExpiringSoon() {
    return translate('ui.810ab25a9cc8');
  },
  get Renewed() {
    return translate('ui.70e418046725');
  },
  get Expired() {
    return translate('ui.75e6c9fb6feb');
  },
  get Revoked() {
    return translate('ui.61063ba81b3c');
  },
  get None() {
    return translate('page.4a5b140af3a0');
  },
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
