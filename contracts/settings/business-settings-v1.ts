import { COMMAND_CATALOG, NOTIFICATION_CATALOG } from '../mqtt/catalogs.js';
import { DOWNLINK_TOPIC_TYPES, UPLINK_TOPIC_TYPES } from '../mqtt/topics.js';

export const BUSINESS_SETTINGS_SCHEMA_VERSION = '1.0.0' as const;

export const BUSINESS_SETTING_KEYS = [
  'alarm.thresholds',
  'command.confirmation',
  'dictionary.displayNames',
  'notification.business',
] as const;

export type BusinessSettingKey = (typeof BUSINESS_SETTING_KEYS)[number];

export const NOTIFIABLE_EVENT_TYPES = ['CRITICAL_ALERT_RAISED', 'ALARM_STATE_CHANGED'] as const;
export const BUSINESS_NOTIFICATION_CHANNELS = ['EMAIL', 'WEBHOOK'] as const;

export interface BusinessSettingValidationIssue {
  readonly path: string;
  readonly code:
    | 'TYPE_OBJECT'
    | 'UNKNOWN_FIELD'
    | 'KEY_LENGTH'
    | 'THRESHOLD_REQUIRED'
    | 'NON_NEGATIVE_NUMBER'
    | 'THRESHOLD_ORDER'
    | 'INTEGER_RANGE'
    | 'UNKNOWN_ENUM'
    | 'STRING_LENGTH'
    | 'NON_EMPTY_STRING_ARRAY'
    | 'DUPLICATE';
  readonly message: string;
}

const FIXED_CODES: Readonly<Record<string, ReadonlySet<string>>> = {
  command: new Set(Object.keys(COMMAND_CATALOG)),
  topicType: new Set([...UPLINK_TOPIC_TYPES, ...DOWNLINK_TOPIC_TYPES]),
  notificationType: new Set(Object.keys(NOTIFICATION_CATALOG)),
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const issue = (
  path: string,
  code: BusinessSettingValidationIssue['code'],
  message: string,
): BusinessSettingValidationIssue => ({ path, code, message });

function extraFields(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  return Object.keys(value)
    .filter((field) => !allowed.includes(field))
    .map((field) => issue(`${path}/${field}`, 'UNKNOWN_FIELD', 'field is not allowed'));
}

function validateAlarmThresholds(value: unknown): BusinessSettingValidationIssue[] {
  if (!object(value)) return [issue('/value', 'TYPE_OBJECT', 'must be an object')];
  const issues: BusinessSettingValidationIssue[] = [];
  for (const [code, entry] of Object.entries(value)) {
    const path = `/value/${code}`;
    if (code.length === 0 || code.length > 64)
      issues.push(issue(path, 'KEY_LENGTH', 'key must contain 1..64 characters'));
    if (!object(entry)) {
      issues.push(issue(path, 'TYPE_OBJECT', 'must be an object'));
      continue;
    }
    issues.push(...extraFields(entry, ['warning', 'major', 'critical'], path));
    const levels = ['warning', 'major', 'critical'] as const;
    const present = levels.filter((level) => entry[level] !== undefined);
    if (present.length === 0) issues.push(issue(path, 'THRESHOLD_REQUIRED', 'must define at least one threshold'));
    for (const level of present) {
      const number = entry[level];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
        issues.push(issue(`${path}/${level}`, 'NON_NEGATIVE_NUMBER', 'must be a non-negative number'));
      }
    }
    const ordered = present.map((level) => entry[level]).filter((item): item is number => typeof item === 'number');
    if (ordered.some((number, index) => index > 0 && number < ordered[index - 1]!)) {
      issues.push(issue(path, 'THRESHOLD_ORDER', 'must satisfy warning <= major <= critical'));
    }
  }
  return issues;
}

function validateCommandConfirmation(value: unknown): BusinessSettingValidationIssue[] {
  if (!object(value)) return [issue('/value', 'TYPE_OBJECT', 'must be an object')];
  const issues = extraFields(value, ['ttlSec', 'maxFutureSec'], '/value');
  const ranges = [
    ['ttlSec', 30, 3600],
    ['maxFutureSec', 0, 600],
  ] as const;
  for (const [field, min, max] of ranges) {
    const number = value[field];
    if (!Number.isInteger(number) || (number as number) < min || (number as number) > max) {
      issues.push(issue(`/value/${field}`, 'INTEGER_RANGE', `must be an integer in ${min}..${max}`));
    }
  }
  return issues;
}

function validateDictionary(value: unknown): BusinessSettingValidationIssue[] {
  if (!object(value)) return [issue('/value', 'TYPE_OBJECT', 'must be an object')];
  const issues = extraFields(value, Object.keys(FIXED_CODES), '/value');
  for (const [namespace, entries] of Object.entries(value)) {
    const path = `/value/${namespace}`;
    if (!object(entries)) {
      issues.push(issue(path, 'TYPE_OBJECT', 'must be an object'));
      continue;
    }
    const allowed = FIXED_CODES[namespace];
    if (!allowed) continue;
    for (const [code, displayName] of Object.entries(entries)) {
      if (!allowed.has(code)) issues.push(issue(`${path}/${code}`, 'UNKNOWN_ENUM', 'is not a fixed protocol code'));
      if (typeof displayName !== 'string' || displayName.trim().length === 0 || displayName.length > 64) {
        issues.push(issue(`${path}/${code}`, 'STRING_LENGTH', 'must be a 1..64 character string'));
      }
    }
  }
  return issues;
}

function validateNotification(value: unknown): BusinessSettingValidationIssue[] {
  if (!object(value)) return [issue('/value', 'TYPE_OBJECT', 'must be an object')];
  const issues = extraFields(value, ['eventTypes', 'channels'], '/value');
  for (const [field, allowed] of [
    ['eventTypes', NOTIFIABLE_EVENT_TYPES],
    ['channels', BUSINESS_NOTIFICATION_CHANNELS],
  ] as const) {
    const path = `/value/${field}`;
    const list = value[field];
    if (!Array.isArray(list) || list.length === 0 || list.some((item) => typeof item !== 'string')) {
      issues.push(issue(path, 'NON_EMPTY_STRING_ARRAY', 'must be a non-empty string array'));
      continue;
    }
    for (const item of list) {
      if (!(allowed as readonly string[]).includes(item))
        issues.push(issue(path, 'UNKNOWN_ENUM', `contains unknown value ${item}`));
    }
    if (new Set(list).size !== list.length) issues.push(issue(path, 'DUPLICATE', 'must not contain duplicates'));
  }
  return issues;
}

export function validateBusinessSettingValue(
  key: BusinessSettingKey,
  value: unknown,
): readonly BusinessSettingValidationIssue[] {
  if (key === 'alarm.thresholds') return validateAlarmThresholds(value);
  if (key === 'command.confirmation') return validateCommandConfirmation(value);
  if (key === 'dictionary.displayNames') return validateDictionary(value);
  return validateNotification(value);
}
