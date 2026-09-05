/**
 * AUTH-02 限频保护（固定窗口）。
 *
 * - 键维度默认 Token 指纹，可覆盖为 IP 等（实施方案 8.2「限制每个 Token/IP 的调用频率」）；
 * - 存储抽象为 RateLimitStore：生产默认使用 PostgreSQL 原子 UPSERT，测试可使用进程内实现；
 * - 超限抛 AuthError('RATE_LIMITED') → 429（CT-05）。
 */
import { rateLimited } from '../errors.js';
import type { DbClient } from '@fdp/database';

export interface RateLimitRule {
  /** 单个窗口内允许的最大请求数（含本次）。 */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitStore {
  /** 记录一次命中，返回当前窗口累计计数（含本次）。 */
  hit(key: string, windowStartEpochSeconds: number, expiresAtEpochSeconds: number): Promise<number>;
  /** 清理早于指定窗口起点的计数。 */
  prune(beforeEpochSeconds: number): void | Promise<void>;
}

/** 进程内固定窗口实现（单实例语义；测试与 V1 默认）。 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, number>();

  hit(key: string, windowStartEpochSeconds: number, _expiresAtEpochSeconds: number): Promise<number> {
    const composite = `${windowStartEpochSeconds}:${key}`;
    const next = (this.counts.get(composite) ?? 0) + 1;
    this.counts.set(composite, next);
    return Promise.resolve(next);
  }

  prune(beforeEpochSeconds: number): void {
    for (const composite of this.counts.keys()) {
      const windowStart = Number(composite.slice(0, composite.indexOf(':')));
      if (windowStart < beforeEpochSeconds) this.counts.delete(composite);
    }
  }
}

interface RawSqlClient {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * 多实例共享存储：PostgreSQL ON CONFLICT 原子递增，同一窗口只存在一行。
 * expires_at 仅用于回收；授权判定只使用调用方计算出的 window_start。
 */
export class PostgresRateLimitStore implements RateLimitStore {
  constructor(private readonly client: DbClient) {}

  async hit(key: string, windowStartEpochSeconds: number, expiresAtEpochSeconds: number): Promise<number> {
    const windowStart = new Date(windowStartEpochSeconds * 1000);
    // 保留当前与前一窗口，随后可由请求路径或运维任务按 expires_at 清扫。
    const expiresAt = new Date(expiresAtEpochSeconds * 1000);
    const rows = await (this.client as unknown as RawSqlClient).$queryRawUnsafe<Array<{ count: number }>>(
      `INSERT INTO "auth_rate_limits" ("rate_key", "window_start", "count", "expires_at")
       VALUES ($1, $2, 1, $3)
       ON CONFLICT ("rate_key", "window_start") DO UPDATE
       SET "count" = "auth_rate_limits"."count" + 1,
           "expires_at" = GREATEST("auth_rate_limits"."expires_at", EXCLUDED."expires_at")
       RETURNING "count"`,
      key,
      windowStart,
      expiresAt,
    );
    const count = rows[0]?.count;
    if (!Number.isInteger(count)) throw new Error('rate-limit counter update returned no count');
    return count as number;
  }

  async prune(beforeEpochSeconds: number): Promise<void> {
    await (this.client as unknown as RawSqlClient).$executeRawUnsafe(
      'DELETE FROM "auth_rate_limits" WHERE "window_start" < $1',
      new Date(beforeEpochSeconds * 1000),
    );
  }
}

export interface RateLimiter {
  /** 超限抛 RATE_LIMITED（429）；未超限正常返回。 */
  assertWithinLimit(key: string): Promise<void>;
}

export function createRateLimiter(
  store: RateLimitStore,
  rule: RateLimitRule,
  now: () => Date = () => new Date(),
): RateLimiter {
  return {
    async assertWithinLimit(key: string): Promise<void> {
      const epochSeconds = Math.floor(now().getTime() / 1000);
      const windowStart = Math.floor(epochSeconds / rule.windowSeconds) * rule.windowSeconds;
      const count = await store.hit(key, windowStart, windowStart + 2 * rule.windowSeconds);
      await store.prune(windowStart - rule.windowSeconds);
      if (count > rule.limit) {
        throw rateLimited(`Rate limit exceeded: ${rule.limit} requests per ${rule.windowSeconds}s`);
      }
    },
  };
}
