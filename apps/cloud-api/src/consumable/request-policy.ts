import { consumableValidationFailed } from './errors.js';

const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function parseConsumableRequestTime(value: unknown): Date | null {
  if (typeof value !== 'string' || !UTC_TIME.test(value)) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return parsed;
}

export function parseOptionalConsumableNote(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 500) {
    throw consumableValidationFailed(`${field} must be a string of 1~500 characters`);
  }
  return value.trim();
}
