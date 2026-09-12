import { translate } from '../../i18n/i18n.js';
/**
 * FE-09 Configuration 纯逻辑：DEC-018@1.0.0 V1 四字段策略（单位/范围/默认值）、
 * 表单预校验（后端仍为唯一可信校验）、状态文案、CT-06 锚点。
 *
 * CONFIG_V1_FIELDS 的数值与 contracts/configuration/configuration-v1-policy.json
 * （status=frozen）逐一对应，由 contract-parity 测试双向锁定——策略冻结，禁止手工漂移。
 * 候选扩展字段（image/rotation/motor/heating/language/cloudDomain/ntpServer）
 * 不进入表单与 DOM（验收：候选扩展字段不存在）。
 */
import type { ConfigurationPayloadView } from './types.js';
export type ConfigFieldKey = keyof ConfigurationPayloadView;
export interface ConfigFieldSpec {
  readonly key: ConfigFieldKey;
  readonly label: string;
  /** DEC-018 单位编码（与 policy.unit 一致）。 */
  readonly unit: 'seconds' | 'minutes' | 'celsius';
  readonly unitLabel: string;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
  /** integer 字段拒绝小数；number 字段允许。 */
  readonly integer: boolean;
}
/** DEC-018@1.0.0 冻结的 V1 四字段（顺序即表单渲染顺序）。 */
export const CONFIG_V1_FIELDS: readonly ConfigFieldSpec[] = [
  {
    key: 'heartbeatInterval',
    get label() {
      return translate('ui.5043867e1e0c');
    },
    unit: 'seconds',
    get unitLabel() {
      return translate('ui.eb6aaba1a1ca');
    },
    min: 10,
    max: 900,
    defaultValue: 60,
    integer: true,
  },
  {
    key: 'telemetryInterval',
    get label() {
      return translate('ui.f940765095f9');
    },
    unit: 'seconds',
    get unitLabel() {
      return translate('ui.eb6aaba1a1ca');
    },
    min: 5,
    max: 3600,
    defaultValue: 30,
    integer: true,
  },
  {
    key: 'cameraRefreshInterval',
    get label() {
      return translate('ui.ec59080df5c5');
    },
    unit: 'minutes',
    get unitLabel() {
      return translate('ui.28bf227b9bf7');
    },
    min: 1,
    max: 1440,
    defaultValue: 1,
    integer: true,
  },
  {
    key: 'temperatureThreshold',
    get label() {
      return translate('ui.6248ea42bfdc');
    },
    unit: 'celsius',
    unitLabel: '°C',
    min: 0,
    max: 120,
    defaultValue: 80,
    integer: false,
  },
];
/** 新建版本表单默认值（DEC-018 default）。 */
export function defaultConfigPayload(): ConfigurationPayloadView {
  return {
    heartbeatInterval: 60,
    telemetryInterval: 30,
    cameraRefreshInterval: 1,
    temperatureThreshold: 80,
  };
}
export interface ConfigValidationResult {
  readonly errors: Partial<Record<ConfigFieldKey, string>>;
  /** 全部合法时的数值快照；存在错误时为 null。 */
  readonly payload: ConfigurationPayloadView | null;
}
/**
 * 前端预校验（后端仍为唯一可信校验）：必填、数值、整数约束、范围。
 * 输入为表单原始字符串。
 */
export function validateConfigPayload(raw: Record<ConfigFieldKey, string>): ConfigValidationResult {
  const errors: Partial<Record<ConfigFieldKey, string>> = {};
  const parsed = {} as Record<ConfigFieldKey, number>;
  for (const field of CONFIG_V1_FIELDS) {
    const text = raw[field.key].trim();
    if (text === '') {
      errors[field.key] = field.label + translate('ui.32945d3e36d3');
      continue;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      errors[field.key] = field.label + translate('ui.88dc444d8b0b');
      continue;
    }
    if (field.integer && !Number.isInteger(value)) {
      errors[field.key] = field.label + translate('ui.a944347cc07e') + field.unitLabel + '\uFF09';
      continue;
    }
    if (value < field.min || value > field.max) {
      errors[field.key] =
        field.label +
        (translate('ui.7f6e24602b5c') + ' ') +
        field.min +
        '~' +
        field.max +
        ' ' +
        field.unitLabel +
        (' ' + translate('ui.1956f1287418'));
      continue;
    }
    parsed[field.key] = value;
  }
  return {
    errors,
    payload: Object.keys(errors).length === 0 ? { ...parsed } : null,
  };
}
export const CONFIG_VERSION_STATUS_LABELS: Readonly<Record<string, string>> = {
  get DRAFT() {
    return translate('ui.0f436818c0b4');
  },
  get PUBLISHED() {
    return translate('ui.176a2eb4eb17');
  },
};
export const CONFIG_SYNC_STATUS_LABELS: Readonly<Record<string, string>> = {
  get PENDING() {
    return translate('ui.f3467c698268');
  },
  get PUBLISHED() {
    return translate('ui.a6d18436d479');
  },
  get FAILED() {
    return translate('ui.513b043d9348');
  },
};
// ---------- CT-06 锚点（device-manage 页配置元素由本页承载；固件/OTA 属 FE-13） ----------
export const CONFIG_COVERAGE: Readonly<Record<string, string>> = {
  'device-manage.button.viewConfig': 'config-detail',
  'device-manage.button.updateConfig': 'config-version-create',
  'device-manage.button.confirm': 'config-publish',
};
