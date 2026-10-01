/**
 * SEC-01 日志脱敏中间件。
 *
 * 双层防线：
 * 1. 字段名脱敏（与 DOM-03 SENSITIVE_KEY_PATTERN 对齐，不区分大小写）；
 * 2. 值形态脱敏（DOM-03 未决风险的双保险）：PEM 私钥块、Onboarding Token 明文、
 *    Bearer 凭证，无论出现在哪个字段名/消息文本中一律遮蔽。
 *
 * 公钥证书（BEGIN CERTIFICATE）非敏感材料，不误遮蔽。
 */
export const REDACTED = '[REDACTED]' as const;

/** 命中即整体遮蔽的字段名（与 DOM-03 对齐）。 */
export const SENSITIVE_KEY_PATTERN =
  /private[_-]?key|password|passcode|secret|token|verifier|credential|api[_-]?key|access[_-]?key|authorization|cookie|session|jwt/i;

/** 值形态检测：命中片段替换为 [REDACTED]。 */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  // PEM 私钥块（含 EC/RSA/ENCRYPTED 变体）
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // Bare JWT and signed URLs must not bypass redaction through unknown fields.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /https?:\/\/[^\s"'<>]*(?:X-Amz-(?:Signature|Credential|Security-Token)|[?&]token)=[^\s"'<>]+/gi,
  // Onboarding Token 明文形态（AUTH-02）
  /\bfdp_onb_[A-Za-z0-9_-]{43}\b/g,
  // Authorization Bearer 凭证
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
];

/** 字符串值脱敏：命中敏感形态替换为 [REDACTED]。 */
export function redactString(value: string): string {
  let out = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** 递归脱敏：字段名命中整体遮蔽；字符串值做形态脱敏；Error 脱敏 message。 */
export function redactSensitive(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) {
    const clone = new Error(redactString(value.message));
    clone.name = value.name;
    return clone;
  }
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSensitive(v);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 日志脱敏中间件：包装任意 Logger，所有参数先经 redactSensitive。 */
export function createRedactingLogger(base: Logger): Logger {
  const wrap =
    (fn: (...args: unknown[]) => void) =>
    (...args: unknown[]): void =>
      fn(...args.map(redactSensitive));
  return {
    debug: wrap(base.debug.bind(base)),
    info: wrap(base.info.bind(base)),
    warn: wrap(base.warn.bind(base)),
    error: wrap(base.error.bind(base)),
  };
}

/** Trace/span 属性必须先经过该入口，避免秘密值绕过日志中间件进入遥测后端。 */
export function redactTraceAttributes(attributes: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return redactSensitive(attributes) as Record<string, unknown>;
}
