/**
 * DEC-013@1.0.0 MQTT Payload 规范化与 audit.hash 算法。
 *
 * - 正式 Heartbeat 使用扁平结构；旧嵌套结构、motorCurrentAmp 与 DISCHARING 仅在兼容窗口内接收。
 * - audit.hash = SHA-256(RFC 8785 canonicalize({meta,data}))，UTF-8 输入、64 位小写十六进制输出。
 */
import { createHash } from 'node:crypto';

export const DEC013_EFFECTIVE_AT = '2026-09-04T09:46:26Z' as const;
export const DEC013_LEGACY_COMPATIBILITY_ENDS_AT = '2026-12-03T09:46:26Z' as const;
export const DEC013_LEGACY_COMPATIBILITY_DAYS = 90 as const;

export type NormalizableTopicType = 'heartbeat' | 'telemetry' | string;
export type PayloadNormalizationErrorCode =
  'LEGACY_FORMAT_EXPIRED' | 'LEGACY_FIELD_CONFLICT' | 'LEGACY_FIELD_INVALID' | 'INVALID_CANONICAL_JSON';

export class PayloadNormalizationError extends Error {
  override readonly name = 'PayloadNormalizationError';
  constructor(
    readonly code: PayloadNormalizationErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJsonObject(payload: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(payload);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function copyLegacyField(
  data: Record<string, unknown>,
  source: Record<string, unknown>,
  legacyKey: string,
  canonicalKey: string,
  legacyPath: string,
): void {
  if (!(legacyKey in source)) return;
  const legacyValue = source[legacyKey];
  if (canonicalKey in data && !sameJsonValue(data[canonicalKey], legacyValue)) {
    throw new PayloadNormalizationError(
      'LEGACY_FIELD_CONFLICT',
      legacyPath,
      `${legacyPath} conflicts with data.${canonicalKey}`,
    );
  }
  data[canonicalKey] = legacyValue;
}

const LEGACY_HEARTBEAT_GROUPS = {
  network: { type: 'networkType', status: 'networkStatus', signal: 'signalStrength' },
  system: { cpuUsage: 'cpuUsagePct', memoryUsage: 'memoryUsagePct', storageUsage: 'storageUsagePct' },
  machine: { running: 'machineRunning', currentMode: 'machineMode' },
  sensorStatus: {
    overall: 'sensorOverallStatus',
    temperature: 'temperatureSensor',
    humidity: 'humiditySensor',
    weight: 'weightSensor',
    gas: 'gasSensor',
  },
} as const;

function hasLegacyPayload(topicType: string, data: Record<string, unknown>): boolean {
  if (topicType === 'heartbeat') {
    if (data.machineMode === 'DISCHARING') return true;
    if (Object.keys(LEGACY_HEARTBEAT_GROUPS).some((key) => key in data)) return true;
  }
  return topicType === 'telemetry' && 'motorCurrentAmp' in data;
}

function normalizeLegacyHeartbeat(data: Record<string, unknown>): void {
  for (const [groupKey, mapping] of Object.entries(LEGACY_HEARTBEAT_GROUPS)) {
    if (!(groupKey in data)) continue;
    const group = data[groupKey];
    if (!isRecord(group)) {
      throw new PayloadNormalizationError('LEGACY_FIELD_INVALID', `data.${groupKey}`, 'legacy group must be object');
    }
    const knownKeys = new Set(Object.keys(mapping));
    const unknownKey = Object.keys(group).find((key) => !knownKeys.has(key));
    if (unknownKey) {
      throw new PayloadNormalizationError(
        'LEGACY_FIELD_INVALID',
        `data.${groupKey}.${unknownKey}`,
        'unknown legacy heartbeat field',
      );
    }
    for (const [legacyKey, canonicalKey] of Object.entries(mapping)) {
      copyLegacyField(data, group, legacyKey, canonicalKey, `data.${groupKey}.${legacyKey}`);
    }
    delete data[groupKey];
  }
  if (data.machineMode === 'DISCHARING') data.machineMode = 'DISCHARGING';
}

function normalizeLegacyTelemetry(data: Record<string, unknown>): void {
  if (!('motorCurrentAmp' in data)) return;
  copyLegacyField(data, data, 'motorCurrentAmp', 'currentAmp', 'data.motorCurrentAmp');
  delete data.motorCurrentAmp;
}

/** 返回新对象，不修改原始 Payload。兼容窗口以 broker 接收时间判定，截止时刻起失败关闭。 */
export function normalizeMqttPayload(
  topicType: NormalizableTopicType,
  payload: Record<string, unknown>,
  receivedAt: string | number | Date,
): Record<string, unknown> {
  const copy = cloneJsonObject(payload);
  const data = copy.data;
  if (!isRecord(data)) return copy;
  const legacy = hasLegacyPayload(topicType, data);
  if (!legacy) return copy;

  const receivedAtMs = new Date(receivedAt).getTime();
  if (!Number.isFinite(receivedAtMs)) {
    throw new PayloadNormalizationError('LEGACY_FIELD_INVALID', '(root)', 'receivedAt must be a valid instant');
  }
  if (receivedAtMs >= Date.parse(DEC013_LEGACY_COMPATIBILITY_ENDS_AT)) {
    throw new PayloadNormalizationError(
      'LEGACY_FORMAT_EXPIRED',
      'data',
      `DEC-013 legacy compatibility expired at ${DEC013_LEGACY_COMPATIBILITY_ENDS_AT}`,
    );
  }

  if (topicType === 'heartbeat') normalizeLegacyHeartbeat(data);
  if (topicType === 'telemetry') normalizeLegacyTelemetry(data);
  return copy;
}

function assertValidUnicode(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new PayloadNormalizationError('INVALID_CANONICAL_JSON', path, 'lone high surrogate is not valid JSON');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new PayloadNormalizationError('INVALID_CANONICAL_JSON', path, 'lone low surrogate is not valid JSON');
    }
  }
}

/** RFC 8785 JSON Canonicalization Scheme；只接受 I-JSON 可表达值。 */
export function canonicalizeJson(value: unknown, path = '(root)'): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    assertValidUnicode(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PayloadNormalizationError('INVALID_CANONICAL_JSON', path, 'non-finite number is not valid I-JSON');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalizeJson(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => {
        assertValidUnicode(key, path);
        const child = value[key];
        if (child === undefined) {
          throw new PayloadNormalizationError(
            'INVALID_CANONICAL_JSON',
            `${path}.${key}`,
            'undefined is not valid JSON',
          );
        }
        return `${JSON.stringify(key)}:${canonicalizeJson(child, `${path}.${key}`)}`;
      })
      .join(',')}}`;
  }
  throw new PayloadNormalizationError('INVALID_CANONICAL_JSON', path, `unsupported JSON value: ${typeof value}`);
}

export function auditHashSubject(payload: Record<string, unknown>): { meta: unknown; data: unknown } {
  return { meta: payload.meta, data: payload.data };
}

export function computeAuditHash(payload: Record<string, unknown>): string {
  const canonical = canonicalizeJson(auditHashSubject(payload));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function verifyAuditHash(payload: Record<string, unknown>): boolean {
  const audit = payload.audit;
  if (!isRecord(audit) || typeof audit.hash !== 'string') return false;
  return audit.hash === computeAuditHash(payload);
}
