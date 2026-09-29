/**
 * BE-ONB-01 Onboarding Request 请求体校验。
 *
 * 契约事实源：contracts/rest/device-onboarding-api.json（字段集合一致性由
 * test/onboarding-contract-parity.test.ts 强制）。
 * 任何字段缺失/非法抛 VALIDATION_FAILED（400），message 对客户端安全。
 */

import { validationFailed } from './errors.js';

export interface OnboardingRequestBody {
  readonly serialNumber: string;
  readonly model: string;
  readonly hardwareVersion: string;
  readonly manufacturer: string;
  /** UTC 日期（YYYY-MM-DD），不得晚于当前日期。 */
  readonly manufactureDate: Date;
}

const SERIAL_NUMBER_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ONBOARDING_REQUEST_FIELDS = new Set([
  'serialNumber',
  'model',
  'hardwareVersion',
  'manufacturer',
  'manufactureDate',
]);

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationFailed(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw validationFailed(`${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function parseManufactureDate(value: unknown, now: Date): Date {
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) {
    throw validationFailed('manufactureDate must be a date string in YYYY-MM-DD format');
  }
  // 以 UTC 零点解析，避免时区漂移（数据库列为 date 类型，统一 UTC）
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw validationFailed('manufactureDate is not a valid calendar date');
  }
  const today = now.toISOString().slice(0, 10);
  if (value > today) {
    throw validationFailed('manufactureDate must not be in the future');
  }
  return date;
}

/** 校验并解析请求体；非法输入抛 VALIDATION_FAILED（400）。 */
export function parseOnboardingRequestBody(raw: unknown, now: Date = new Date()): OnboardingRequestBody {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw validationFailed('The request body must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).filter((field) => !ONBOARDING_REQUEST_FIELDS.has(field));
  if (unknown.length > 0) {
    throw validationFailed(`Unknown request field: ${unknown.sort().join(', ')}`);
  }

  const serialNumber = requireString(body.serialNumber, 'serialNumber', 64);
  if (!SERIAL_NUMBER_PATTERN.test(serialNumber)) {
    throw validationFailed('serialNumber has an invalid format');
  }
  return {
    serialNumber,
    model: requireString(body.model, 'model', 64),
    hardwareVersion: requireString(body.hardwareVersion, 'hardwareVersion', 32),
    manufacturer: requireString(body.manufacturer, 'manufacturer', 128),
    manufactureDate: parseManufactureDate(body.manufactureDate, now),
  };
}
