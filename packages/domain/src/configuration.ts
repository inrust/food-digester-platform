/**
 * BE-CFG-01 Configuration 版本领域规则（纯领域，无 IO）。
 *
 * 事实源与冻结策略：
 * - 配置内容：协议允许的图像宽高/上传间隔、旋转间隔 M/时长 N、电机过载电流、
 *   最低/最高加热温度、语言、heartbeatInterval/telemetryInterval/
 *   cameraRefreshInterval/temperatureThreshold（完整快照，版本不可变）。
 * - 允许范围：通信设计 PDF 尚无文本化范围表，CONFIGURATION_LIMITS 为暂定值
 *   （数据驱动常量，可整体替换；冻结需经决策登记流程）。
 * - 派生字段（contract/region/subregion/site/alias）从业务实体读取，只读展示，
 *   不得随配置提交；云平台域名/NTP 在 PDF 明确允许前不是下发字段，提交即拒绝。
 * - 版本生命周期：DRAFT → PUBLISHED 单向；历史版本不可覆盖（无更新路径）；
 *   设备有效版本 = 已发布且已到 effectiveAt 的最高版本（selectEffectiveVersion）。
 */

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

// ---------- 字段与范围（暂定值，可整体替换） ----------

export const CONFIGURATION_LANGUAGES = ['zh-CN', 'en-US'] as const;
export type ConfigurationLanguage = (typeof CONFIGURATION_LANGUAGES)[number];

/** 允许范围（min/max 闭区间；频率/间隔单位秒，旋转间隔 M 单位分钟，时长 N 单位秒，温度 ℃，电流 A）。 */
export const CONFIGURATION_LIMITS = {
  image: {
    width: { min: 160, max: 1920 },
    height: { min: 120, max: 1080 },
    uploadIntervalSeconds: { min: 60, max: 86400 },
  },
  rotation: {
    intervalMinutes: { min: 1, max: 1440 },
    durationSeconds: { min: 5, max: 3600 },
  },
  motor: { overloadCurrentAmps: { min: 0.1, max: 32 } },
  heating: {
    minTemperatureCelsius: { min: 0, max: 80 },
    maxTemperatureCelsius: { min: 0, max: 120 },
  },
  heartbeatInterval: { min: 30, max: 600 },
  telemetryInterval: { min: 60, max: 3600 },
  cameraRefreshInterval: { min: 5, max: 600 },
  temperatureThreshold: { min: 0, max: 150 },
} as const;

/** 派生只读字段：从业务实体读取，随配置提交即 400。 */
export const CONFIGURATION_DERIVED_KEYS = ['contract', 'region', 'subregion', 'site', 'alias'] as const;
/** 未冻结网络字段：PDF 未明确允许远程下发前，提交即 400。 */
export const CONFIGURATION_UNFROZEN_NETWORK_KEYS = ['cloudDomain', 'ntpServer'] as const;

// ---------- 载荷模型 ----------

export interface ConfigurationImagePayload {
  readonly width: number;
  readonly height: number;
  readonly uploadIntervalSeconds: number;
}

export interface ConfigurationRotationPayload {
  /** 旋转间隔 M（分钟）。 */
  readonly intervalMinutes: number;
  /** 旋转时长 N（秒），必须小于 M。 */
  readonly durationSeconds: number;
}

export interface ConfigurationPayload {
  readonly image: ConfigurationImagePayload;
  readonly rotation: ConfigurationRotationPayload;
  readonly motor: { readonly overloadCurrentAmps: number };
  readonly heating: {
    readonly minTemperatureCelsius: number;
    readonly maxTemperatureCelsius: number;
  };
  readonly language: ConfigurationLanguage;
  readonly heartbeatInterval: number;
  readonly telemetryInterval: number;
  readonly cameraRefreshInterval: number;
  readonly temperatureThreshold: number;
}

const TOP_LEVEL_KEYS = [
  'image',
  'rotation',
  'motor',
  'heating',
  'language',
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

function checkGroup(
  errors: string[],
  value: unknown,
  field: string,
  allowedKeys: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainObject(value)) {
    errors.push(`${field}: must be an object`);
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) errors.push(`${field}.${key}: unknown field`);
  }
  for (const key of allowedKeys) {
    if (!(key in value)) errors.push(`${field}.${key}: is required`);
  }
  return value;
}

/**
 * 校验配置载荷（封闭 Schema：全字段必填、无未知字段）：
 * - 派生字段（contract/region/subregion/site/alias）→ 拒绝（只读，从业务实体读取）；
 * - 未冻结网络字段（cloudDomain/ntpServer）→ 拒绝（PDF 未明确允许前不下发）；
 * - 范围校验：频率、尺寸、阈值逐项范围；
 * - 交叉校验：minTemperature < maxTemperature；旋转时长 N < 间隔 M。
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
    } else if ((CONFIGURATION_UNFROZEN_NETWORK_KEYS as readonly string[]).includes(key)) {
      errors.push(`${key}: is not frozen for remote configuration`);
    } else if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      errors.push(`${key}: unknown field`);
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in input)) errors.push(`${key}: is required`);
  }

  const image = checkGroup(errors, input.image, 'image', ['width', 'height', 'uploadIntervalSeconds']);
  const width = image ? checkInt(errors, image.width, 'image.width', CONFIGURATION_LIMITS.image.width) : null;
  const height = image ? checkInt(errors, image.height, 'image.height', CONFIGURATION_LIMITS.image.height) : null;
  const uploadIntervalSeconds = image
    ? checkInt(
        errors,
        image.uploadIntervalSeconds,
        'image.uploadIntervalSeconds',
        CONFIGURATION_LIMITS.image.uploadIntervalSeconds,
      )
    : null;

  const rotation = checkGroup(errors, input.rotation, 'rotation', ['intervalMinutes', 'durationSeconds']);
  const intervalMinutes = rotation
    ? checkInt(
        errors,
        rotation.intervalMinutes,
        'rotation.intervalMinutes',
        CONFIGURATION_LIMITS.rotation.intervalMinutes,
      )
    : null;
  const durationSeconds = rotation
    ? checkInt(
        errors,
        rotation.durationSeconds,
        'rotation.durationSeconds',
        CONFIGURATION_LIMITS.rotation.durationSeconds,
      )
    : null;
  // 交叉校验：时长 N 必须小于间隔 M
  if (intervalMinutes !== null && durationSeconds !== null && durationSeconds >= intervalMinutes * 60) {
    errors.push('rotation.durationSeconds: must be less than rotation.intervalMinutes');
  }

  const motor = checkGroup(errors, input.motor, 'motor', ['overloadCurrentAmps']);
  const overloadCurrentAmps = motor
    ? checkNumber(
        errors,
        motor.overloadCurrentAmps,
        'motor.overloadCurrentAmps',
        CONFIGURATION_LIMITS.motor.overloadCurrentAmps,
      )
    : null;

  const heating = checkGroup(errors, input.heating, 'heating', ['minTemperatureCelsius', 'maxTemperatureCelsius']);
  const minTemperatureCelsius = heating
    ? checkNumber(
        errors,
        heating.minTemperatureCelsius,
        'heating.minTemperatureCelsius',
        CONFIGURATION_LIMITS.heating.minTemperatureCelsius,
      )
    : null;
  const maxTemperatureCelsius = heating
    ? checkNumber(
        errors,
        heating.maxTemperatureCelsius,
        'heating.maxTemperatureCelsius',
        CONFIGURATION_LIMITS.heating.maxTemperatureCelsius,
      )
    : null;
  // 交叉校验：最低加热温度必须低于最高加热温度
  if (
    minTemperatureCelsius !== null &&
    maxTemperatureCelsius !== null &&
    minTemperatureCelsius >= maxTemperatureCelsius
  ) {
    errors.push('heating.minTemperatureCelsius: must be less than heating.maxTemperatureCelsius');
  }

  let language: ConfigurationLanguage | null = null;
  if ('language' in input) {
    if (typeof input.language === 'string' && (CONFIGURATION_LANGUAGES as readonly string[]).includes(input.language)) {
      language = input.language as ConfigurationLanguage;
    } else {
      errors.push(`language: must be one of ${CONFIGURATION_LANGUAGES.join(', ')}`);
    }
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
    image: { width: width as number, height: height as number, uploadIntervalSeconds: uploadIntervalSeconds as number },
    rotation: { intervalMinutes: intervalMinutes as number, durationSeconds: durationSeconds as number },
    motor: { overloadCurrentAmps: overloadCurrentAmps as number },
    heating: {
      minTemperatureCelsius: minTemperatureCelsius as number,
      maxTemperatureCelsius: maxTemperatureCelsius as number,
    },
    language: language as ConfigurationLanguage,
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
