/**
 * DOM-03 业务审计写入库（append-only）。
 *
 * - recordAudit：写一条 audit_logs；actor/requestId 等默认取自 DB-02 AsyncLocalStorage
 *   上下文（显式传参优先），前后值经 sanitizeAuditPayload 脱敏；
 * - audited：管理写操作拦截器——业务写入与 SUCCESS 审计同事务；业务失败时事务回滚，
 *   随后以独立写入记录 FAILURE（绝不伪造成功），并原样抛出业务错误；
 * - append-only：业务 Repository 对审计/历史表的更新删除由 APPEND_ONLY_MODELS 拦截
 *   （repository.ts），本库只提供 create 路径。
 *
 * 边界：不采集 AWS CloudTrail，不做日志归档运维。
 */
import { getRequestContext } from './context.js';
import { DbError } from './errors.js';
import { withTransaction, type DbClient } from './transaction.js';
import type { PrismaClient } from './generated/client.js';

// ---------- 脱敏器 ----------

/** 命中即整体遮蔽的字段名（不区分大小写）：私钥、Token、passwordHash、验证值、密钥材料。 */
export const SENSITIVE_KEY_PATTERN =
  /private[_-]?key|password|passcode|secret|token|verifier|credential|api[_-]?key|access[_-]?key/i;

/** 即使字段名未知，也不得把私钥材料写入审计 JSON。 */
export const SENSITIVE_VALUE_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/i;

export const REDACTED = '[REDACTED]' as const;

/** 递归脱敏：对象/数组逐层处理，命中敏感字段名替换为 [REDACTED]；其余原样返回。 */
export function sanitizeAuditPayload(value: unknown): unknown {
  if (typeof value === 'string' && SENSITIVE_VALUE_PATTERN.test(value)) return REDACTED;
  if (Array.isArray(value)) return value.map(sanitizeAuditPayload);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeAuditPayload(v);
    }
    return out;
  }
  return value;
}

// ---------- 审计写入 ----------

export interface AuditEntry {
  readonly objectType: string;
  readonly objectId: string;
  readonly action: string;
  readonly result: 'SUCCESS' | 'FAILURE';
  readonly actorId?: string;
  readonly actorRole?: string;
  readonly customerId?: string | null;
  readonly reason?: string | null;
  readonly beforeValue?: unknown;
  readonly afterValue?: unknown;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly requestId?: string;
}

function isRootClient(client: DbClient): client is PrismaClient {
  return typeof (client as PrismaClient).$connect === 'function';
}

/** 写一条审计记录。可在事务内（tx）或根 client 上调用。 */
export async function recordAudit(client: DbClient, entry: AuditEntry): Promise<void> {
  const ctx = getRequestContext();
  await client.auditLog.create({
    data: {
      actorId: entry.actorId ?? ctx.actorId ?? null,
      actorRole: entry.actorRole ?? ctx.actorRole ?? null,
      customerId: entry.customerId ?? ctx.customerId ?? null,
      objectType: entry.objectType,
      objectId: entry.objectId,
      action: entry.action,
      reason: entry.reason ?? null,
      beforeValue: sanitizeAuditPayload(entry.beforeValue ?? null) as object,
      afterValue: sanitizeAuditPayload(entry.afterValue ?? null) as object,
      ip: entry.ip ?? ctx.ip ?? null,
      userAgent: entry.userAgent ?? ctx.userAgent ?? null,
      result: entry.result,
      requestId: entry.requestId ?? ctx.requestId ?? null,
    },
  });
}

// ---------- 管理写操作拦截器 ----------

export interface AuditedOperation {
  readonly objectType: string;
  readonly objectId: string;
  readonly action: string;
  readonly reason?: string | null;
  readonly beforeValue?: unknown;
  /** 成功时的 afterValue：常量或基于业务结果的函数。 */
  readonly afterValue?: unknown | ((result: unknown) => unknown);
  readonly customerId?: string | null;
  /** 显式 actor（优先于 AsyncLocalStorage 上下文）。 */
  readonly actorId?: string;
  readonly actorRole?: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

/**
 * 拦截器：业务写 + SUCCESS 审计在同一事务提交；任何业务异常回滚业务与成功审计，
 * 然后独立写入 FAILURE 审计（含失败原因不伪造成功），最后原样抛出业务错误。
 * 必须传入根 PrismaClient（事务内嵌套调用会让失败审计随外层回滚，属误用）。
 */
export async function audited<T>(client: DbClient, op: AuditedOperation, fn: (tx: DbClient) => Promise<T>): Promise<T> {
  if (!isRootClient(client)) {
    throw new DbError('audited() 必须使用根 PrismaClient，禁止在事务内嵌套');
  }
  try {
    return await withTransaction(client, async (tx) => {
      const result = await fn(tx);
      const afterValue = typeof op.afterValue === 'function' ? op.afterValue(result) : op.afterValue;
      await recordAudit(tx, { ...op, afterValue, result: 'SUCCESS' });
      return result;
    });
  } catch (err) {
    try {
      await recordAudit(client, { ...op, afterValue: undefined, result: 'FAILURE' });
    } catch (auditErr) {
      // 审计写入失败不掩盖业务错误；结构化日志由 observability 任务接入
      console.error('audit FAILURE 记录写入失败', (auditErr as Error).message);
    }
    throw err;
  }
}
