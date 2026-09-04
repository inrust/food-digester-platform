/**
 * BE-CFG-01 Configuration 版本领域规则（纯领域，无 IO）。
 *
 * 事实源与冻结策略：
 * - 配置内容：DEC-018@1.0.0 冻结的 heartbeatInterval/telemetryInterval/
 *   cameraRefreshInterval/temperatureThreshold 四字段（完整快照，版本不可变）。
 * - 单位与范围：Heartbeat/Telemetry 为秒，Camera Refresh 为分钟，温度为 ℃；
 *   CONFIGURATION_LIMITS 是已冻结契约值。
 * - 派生字段（contract/region/subregion/site/alias）从业务实体读取，只读展示，
 *   不得随配置提交；云平台域名/NTP 已被 DEC-018 排除在 V1 外，提交即拒绝。
 * - 版本生命周期：DRAFT → PUBLISHED 单向；历史版本不可覆盖（无更新路径）；
 *   设备有效版本 = 已发布且已到 effectiveAt 的最高版本（selectEffectiveVersion）。
 */
import { CONFIGURATION_V1_POLICY } from '@fdp/contracts/configuration/configuration-v1-policy.js';

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
  constructor(
    readonly code: 'VALIDATION_FAILED' | 'CONFLICT',
    message: string,
    /** 字段级错误（field: message），对外安全。 */
    readonly fieldErrors: readonly string[] = [],
  ) {
    super(message);
  }
}

// ---------- DEC-018@1.0.0 冻结字段与范围 ----------

/** min/max 为闭区间；Heartbeat/Telemetry 单位秒，Camera Refresh 单位分钟，温度单位 ℃。 */
export const CONFIGURATION_LIMITS = {
  heartbeatInterval: {
    min: CONFIGURATION_V1_POLICY.fields.heartbeatInterval.minimum,
    max: CONFIGURATION_V1_POLICY.fields.heartbeatInterval.maximum,
    default: CONFIGURATION_V1_POLICY.fields.heartbeatInterval.default,
    unit: CONFIGURATION_V1_POLICY.fields.heartbeatInterval.unit,
  },
  telemetryInterval: {
    min: CONFIGURATION_V1_POLICY.fields.telemetryInterval.minimum,
    max: CONFIGURATION_V1_POLICY.fields.telemetryInterval.maximum,
    default: CONFIGURATION_V1_POLICY.fields.telemetryInterval.default,
    unit: CONFIGURATION_V1_POLICY.fields.telemetryInterval.unit,
  },
  cameraRefreshInterval: {
    min: CONFIGURATION_V1_POLICY.fields.cameraRefreshInterval.minimum,
    max: CONFIGURATION_V1_POLICY.fields.cameraRefreshInterval.maximum,
    default: CONFIGURATION_V1_POLICY.fields.cameraRefreshInterval.default,
    unit: CONFIGURATION_V1_POLICY.fields.cameraRefreshInterval.unit,
  },
  temperatureThreshold: {
    min: CONFIGURATION_V1_POLICY.fields.temperatureThreshold.minimum,
    max: CONFIGURATION_V1_POLICY.fields.temperatureThreshold.maximum,
    default: CONFIGURATION_V1_POLICY.fields.temperatureThreshold.default,
    unit: CONFIGURATION_V1_POLICY.fields.temperatureThreshold.unit,
  },
} as const;

/** 派生只读字段：从业务实体读取，随配置提交即 400。 */
export const CONFIGURATION_DERIVED_KEYS = ['contract', 'region', 'subregion', 'site', 'alias'] as const;
/** DEC-018 明确排除的网络字段：不属于 V1，提交即 400。 */
export const CONFIGURATION_EXCLUDED_NETWORK_KEYS = ['cloudDomain', 'ntpServer'] as const;

// ---------- 载荷模型 ----------

export interface ConfigurationPayload {
  readonly heartbeatInterval: number;
  readonly telemetryInterval: number;
  /** 单位：分钟。 */
  readonly cameraRefreshInterval: number;
  readonly temperatureThreshold: number;
}

const TOP_LEVEL_KEYS = [
  'heartbeatInterval',
  'telemetryInterval',
  'cameraRefreshInterval',
  'temperatureThreshold',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkInt(
  errors: string[],
  value: unknown,
  field: string,
  range: { readonly min: number; readonly max: number },
): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push(`${field}: must be an integer`);
    return null;
  }
  if (value < range.min || value > range.max) {
    errors.push(`${field}: must be between ${range.min} and ${range.max}`);
    return null;
  }
  return value;
}

function checkNumber(
  errors: string[],
  value: unknown,
  field: string,
  range: { readonly min: number; readonly max: number },
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${field}: must be a number`);
    return null;
  }
  if (value < range.min || value > range.max) {
    errors.push(`${field}: must be between ${range.min} and ${range.max}`);
    return null;
  }
  return value;
}

/**
 * 校验配置载荷（封闭 Schema：全字段必填、无未知字段）：
 * - 派生字段（contract/region/subregion/site/alias）→ 拒绝（只读，从业务实体读取）；
 * - 排除的网络字段（cloudDomain/ntpServer）→ 拒绝（DEC-018：不属于 V1）；
 * - 范围校验：四个冻结字段逐项校验；候选扩展一律拒绝。
 * 校验失败抛 ConfigurationError('VALIDATION_FAILED')，fieldErrors 汇总全部字段错误。
 */
export function validateConfigurationPayload(input: unknown): ConfigurationPayload {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    throw new ConfigurationError('VALIDATION_FAILED', 'The configuration payload must be an object', [
      'payload: must be an object',
    ]);
  }
  for (const key of Object.keys(input)) {
    if ((CONFIGURATION_DERIVED_KEYS as readonly string[]).includes(key)) {
      errors.push(`${key}: is derived from business entities and read-only`);
    } else if ((CONFIGURATION_EXCLUDED_NETWORK_KEYS as readonly string[]).includes(key)) {
      errors.push(`${key}: is excluded from Configuration V1`);
    } else if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      errors.push(`${key}: unknown field`);
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in input)) errors.push(`${key}: is required`);
  }

  const heartbeatInterval =
    'heartbeatInterval' in input
      ? checkInt(errors, input.heartbeatInterval, 'heartbeatInterval', CONFIGURATION_LIMITS.heartbeatInterval)
      : null;
  const telemetryInterval =
    'telemetryInterval' in input
      ? checkInt(errors, input.telemetryInterval, 'telemetryInterval', CONFIGURATION_LIMITS.telemetryInterval)
      : null;
  const cameraRefreshInterval =
    'cameraRefreshInterval' in input
      ? checkInt(
          errors,
          input.cameraRefreshInterval,
          'cameraRefreshInterval',
          CONFIGURATION_LIMITS.cameraRefreshInterval,
        )
      : null;
  const temperatureThreshold =
    'temperatureThreshold' in input
      ? checkNumber(
          errors,
          input.temperatureThreshold,
          'temperatureThreshold',
          CONFIGURATION_LIMITS.temperatureThreshold,
        )
      : null;

  if (errors.length > 0) {
    throw new ConfigurationError('VALIDATION_FAILED', 'The configuration payload failed validation', errors);
  }

  return {
    heartbeatInterval: heartbeatInterval as number,
    telemetryInterval: telemetryInterval as number,
    cameraRefreshInterval: cameraRefreshInterval as number,
    temperatureThreshold: temperatureThreshold as number,
  };
}

// ---------- 版本生命周期 ----------

export const CONFIGURATION_VERSION_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
export type ConfigurationVersionStatus = (typeof CONFIGURATION_VERSION_STATUSES)[number];

/** 发布前置校验：仅 DRAFT 可发布（历史版本不可覆盖，PUBLISHED 无任何出边）。 */
export function assertPublishableVersion(status: string): asserts status is 'DRAFT' {
  if (status !== 'DRAFT') {
    throw new ConfigurationError('CONFLICT', 'The version is already published and immutable');
  }
}

export interface ConfigurationVersionSnapshot {
  readonly version: number;
  readonly status: string;
  readonly effectiveAt: Date | null;
}

/** 设备有效版本：已发布且 effectiveAt <= at 的最高版本；无则 null（Sync 读取规则）。 */
export function selectEffectiveVersion<T extends ConfigurationVersionSnapshot>(
  versions: readonly T[],
  at: Date,
): T | null {
  let best: T | null = null;
  for (const v of versions) {
    if (v.status !== 'PUBLISHED' || v.effectiveAt === null || v.effectiveAt.getTime() > at.getTime()) continue;
    if (best === null || v.version > best.version) best = v;
  }
  return best;
}
