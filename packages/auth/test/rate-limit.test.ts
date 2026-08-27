/**
 * AUTH-02 限频保护单元测试（注入时钟，无 IO）。
 */
import { assert, describe, test } from 'vitest';
import { createRateLimiter, InMemoryRateLimitStore } from '../src/index.js';
import { expectAuthError } from './helpers.js';

describe('固定窗口限频', () => {
  const baseEpoch = 1_780_000_000;
  let nowEpoch = baseEpoch;
  const now = () => new Date(nowEpoch * 1000);

  test('窗口内限量内放行，超限 → 429 RATE_LIMITED', async () => {
    const limiter = createRateLimiter(new InMemoryRateLimitStore(), { limit: 3, windowSeconds: 60 }, now);
    await limiter.assertWithinLimit('token:abc');
    await limiter.assertWithinLimit('token:abc');
    await limiter.assertWithinLimit('token:abc');
    await expectAuthError(limiter.assertWithinLimit('token:abc'), 'RATE_LIMITED');
  });

  test('窗口推进后计数重置', async () => {
    nowEpoch = baseEpoch;
    const limiter = createRateLimiter(new InMemoryRateLimitStore(), { limit: 1, windowSeconds: 30 }, now);
    await limiter.assertWithinLimit('ip:1.2.3.4');
    await expectAuthError(limiter.assertWithinLimit('ip:1.2.3.4'), 'RATE_LIMITED');
    nowEpoch += 30; // 下一窗口
    await limiter.assertWithinLimit('ip:1.2.3.4');
  });

  test('不同键互不干扰；prune 清理过期窗口', async () => {
    nowEpoch = baseEpoch;
    const store = new InMemoryRateLimitStore();
    const limiter = createRateLimiter(store, { limit: 1, windowSeconds: 30 }, now);
    await limiter.assertWithinLimit('token:a');
    await limiter.assertWithinLimit('token:b');
    await expectAuthError(limiter.assertWithinLimit('token:a'), 'RATE_LIMITED');

    nowEpoch += 120; // 跨越多个窗口
    await limiter.assertWithinLimit('token:c'); // 触发 prune
    // 旧窗口键已清理，仅保留当前窗口
    const internals = store as unknown as { counts: Map<string, number> };
    assert.equal(internals.counts.size, 1);
  });
});
