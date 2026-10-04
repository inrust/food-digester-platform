/**
 * @fdp/observability：结构化日志与脱敏。
 * SEC-01：字段名 + 值形态双层脱敏与 redacting Logger；不得输出敏感密钥材料。
 */
export const PACKAGE_NAME = '@fdp/observability';

export {
  createRedactingLogger,
  redactSensitive,
  redactString,
  redactTraceAttributes,
  REDACTED,
  SENSITIVE_KEY_PATTERN,
} from './redaction.js';
export type { Logger } from './redaction.js';

export * from './request-correlation.js';

export * from './data-path.js';
