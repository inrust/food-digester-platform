import { translate } from '../../i18n/i18n.js';
/**
 * FE-15 审计日志纯逻辑：结果文案与前端兜底脱敏。
 *
 * 脱敏纪律（DOM-03）：服务端写入时 sanitizeAuditPayload + 读取时再次脱敏，敏感字段恒为
 * [REDACTED]；前端渲染前后值前再执行一次兜底脱敏（纵深防御），字段名模式与
 * packages/observability SENSITIVE_KEY_PATTERN parity 锁定，禁止单边漂移。
 *
 * 只读纪律：本页无编辑/删除入口；API 装配仅 GET。
 */
export const AUDIT_RESULT_OPTIONS = ['SUCCESS', 'FAILURE'] as const;
export const AUDIT_RESULT_LABELS: Readonly<Record<string, string>> = {
  get SUCCESS() {
    return translate('page.51991a5d111a');
  },
  get FAILURE() {
    return translate('ui.3e3c8068bb0e');
  },
};
export const REDACTED = '[REDACTED]' as const;
/** 命中即整体遮蔽的字段名（镜像 packages/observability SENSITIVE_KEY_PATTERN，parity 锁定）。 */
export const SENSITIVE_KEY_PATTERN =
  /private[_-]?key|password|passcode|secret|token|verifier|credential|api[_-]?key|access[_-]?key/i;
/**
 * 前端兜底脱敏：递归遍历，字段名命中 → 整体替换为 [REDACTED]。
 * （值形态脱敏——PEM/Bearer/Onboarding Token——由服务端保证，前端不重复实现。）
 */
export function sanitizeForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForDisplay);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeForDisplay(v);
    }
    return out;
  }
  return value;
}
/** 前后值渲染文本（兜底脱敏后 JSON 序列化；null/undefined → “无”）。 */
export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined) return translate('ui.72077749f794');
  return JSON.stringify(sanitizeForDisplay(value), null, 2);
}
