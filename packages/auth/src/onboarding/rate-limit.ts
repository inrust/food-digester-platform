/**
 * AUTH-02 限频保护（固定窗口）。
 *
 * - 键维度默认 Token 指纹，可覆盖为 IP 等（实施方案 8.2「限制每个 Token/IP 的调用频率」）；
 * - 存储抽象为 RateLimitStore：V1 提供进程内实现；Lambda 多实例下的
 *   全局一致限频可后续替换为 DynamoDB/ElastiCache 实现（接口不变）；
 * - 超限抛 AuthError('RATE_LIMITED') → 429（CT-05）。
 */
import { rateLimited } from '../errors.js';

export interface RateLimitRule {
  /** 单个窗口内允许的最大请求数（含本次）。 */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitStore {
  /** 记录一次命中，返回当前窗口累计计数（含本次）。 */
  hit(key: string, windowStartEpochSeconds: number): Promise<number>;
  /** 清理早于指定窗口起点的计数。 */
  prune(beforeEpochSeconds: number): void;
}

/** 进程内固定窗口实现（单实例语义；测试与 V1 默认）。 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, number>();

  hit(key: string, windowStartEpochSeconds: number): Promise<number> {
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
      const count = await store.hit(key, windowStart);
      store.prune(windowStart - rule.windowSeconds);
      if (count > rule.limit) {
        throw rateLimited(`Rate limit exceeded: ${rule.limit} requests per ${rule.windowSeconds}s`);
      }
    },
  };
}
