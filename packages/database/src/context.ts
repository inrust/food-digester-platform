/**
 * DB-02 请求/审计上下文传递。
 * 基于 AsyncLocalStorage：进入请求时由中间件 runWithContext 注入，
 * 事务与 Repository 调用链内（含异步）均可读取，DOM-03 审计服务消费。
 * 注意：上下文中禁止放入 Token、私钥、passwordHash 等敏感材料。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isIP } from 'node:net';

export interface DbRequestContext {
  readonly requestId?: string;
  readonly actorId?: string;
  readonly actorRole?: string;
  /** Customer 范围由服务端身份上下文注入，不得取自客户端入参。 */
  readonly customerId?: string;
  /** 仅由可信传输适配层注入，不得取自业务请求体。 */
  readonly ip?: string;
  readonly userAgent?: string;
}

const storage = new AsyncLocalStorage<DbRequestContext>();

export function runWithContext<T>(ctx: DbRequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** 返回当前上下文；无上下文时返回空对象（不抛错，由调用方决定是否必须）。 */
export function getRequestContext(): DbRequestContext {
  return storage.getStore() ?? {};
}

/** 只接受单一合法 IPv4/IPv6；不在此信任或解析客户端提供的转发链。 */
export function normalizeAuditIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : undefined;
}

/** 去除控制字符、首尾空白并限制审计字段长度。 */
export function normalizeAuditUserAgent(value: string | undefined): string | undefined {
  const normalized = [...(value ?? '')]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .trim()
    .slice(0, 512);
  return normalized || undefined;
}
