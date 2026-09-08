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
    label: 'Heartbeat 间隔',
    unit: 'seconds',
    unitLabel: '秒',
    min: 10,
    max: 900,
    defaultValue: 60,
    integer: true,
  },
  {
    key: 'telemetryInterval',
    label: 'Telemetry 间隔',
    unit: 'seconds',
    unitLabel: '秒',
    min: 5,
    max: 3600,
    defaultValue: 30,
    integer: true,
  },
  {
    key: 'cameraRefreshInterval',
    label: '摄像头刷新间隔',
    unit: 'minutes',
    unitLabel: '分钟',
    min: 1,
    max: 1440,
    defaultValue: 1,
    integer: true,
  },
  {
    key: 'temperatureThreshold',
    label: '温度阈值',
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
      errors[field.key] = `${field.label}必填`;
      continue;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      errors[field.key] = `${field.label}须为数值`;
      continue;
    }
    if (field.integer && !Number.isInteger(value)) {
      errors[field.key] = `${field.label}须为整数（单位：${field.unitLabel}）`;
      continue;
    }
    if (value < field.min || value > field.max) {
      errors[field.key] = `${field.label}须在 ${field.min}~${field.max} ${field.unitLabel} 范围内`;
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
  DRAFT: '草稿',
  PUBLISHED: '已发布',
};

export const CONFIG_SYNC_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: '待投递',
  PUBLISHED: '已投递',
  FAILED: '投递失败',
};

// ---------- CT-06 锚点（device-manage 页配置元素由本页承载；固件/OTA 属 FE-13） ----------

export const CONFIG_COVERAGE: Readonly<Record<string, string>> = {
  'device-manage.button.viewConfig': 'config-detail',
  'device-manage.button.updateConfig': 'config-version-create',
  'device-manage.button.confirm': 'config-publish',
};
