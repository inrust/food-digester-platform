/**
 * AUTH-02 Onboarding 认证中间件（框架无关装饰器）。
 *
 * 适用于 POST /api/v1/device/onboarding/request 与 GET .../status（BE-ONB-01 接线）：
 * 1. 限频（默认按 Token 指纹，先于 DB 查询，抑制暴力枚举）；
 * 2. Token 校验（verifyOnboardingToken：撤销/过期/核销/序列号绑定）；
 * 3. 通过后把 OnboardingAuthContext 交给业务 Handler。
 *
 * 重放保护：Token 一次一机 + usedAt 核销（证书包领取后由 BE-ONB-03/04 调用
 * markOnboardingTokenUsed）；请求级幂等（重复提交返回原 requestId）由 BE-ONB-01
 * 借助 onboarding_requests 部分唯一索引实现。
 */
import type { DbClient } from '@fdp/database';
import { tokenFingerprint } from './token.js';
import { verifyOnboardingToken } from './verifier.js';
import type { OnboardingAuthContext } from './verifier.js';
import type { RateLimiter } from './rate-limit.js';

export interface OnboardingGuardOptions<TReq> {
  readonly client: DbClient;
  /** 从请求提取明文 Token（如 Authorization: Bearer 或自定义头）。 */
  readonly tokenOf: (req: TReq) => string | undefined;
  /** 从请求提取序列号（路径/请求体）；缺失 → 400。 */
  readonly serialNumberOf: (req: TReq) => string | undefined;
  /** 允许仅凭已验证 Token 的库存绑定定位序列号（仅 Status API）。 */
  readonly allowImplicitSerialNumber?: boolean;
  /** 限频器；不提供则不限频（调用方显式选择）。 */
  readonly rateLimiter?: RateLimiter;
  /** 限频键，默认 `token:{fingerprint}`；可覆盖为 `ip:{sourceIp}` 等。 */
  readonly rateLimitKeyOf?: (req: TReq, fingerprint: string) => string;
  /** 生产可同时执行 Token 与 IP 等多维共享限频；每一维都必须通过。 */
  readonly rateLimits?: readonly {
    readonly limiter: RateLimiter;
    readonly keyOf: (req: TReq, fingerprint: string) => string;
  }[];
  /** 注入时钟（测试用）。 */
  readonly now?: () => Date;
}

export function withOnboardingAuth<TReq, TRes>(
  options: OnboardingGuardOptions<TReq>,
  handler: (req: TReq, auth: OnboardingAuthContext) => TRes | Promise<TRes>,
): (req: TReq) => Promise<TRes> {
  return async (req) => {
    const presentedToken = options.tokenOf(req);
    // 指纹可从未校验的原文安全计算（散列单向），用于限频与日志
    const fingerprint = presentedToken ? tokenFingerprint(presentedToken) : 'anonymous';
    if (options.rateLimits) {
      for (const rule of options.rateLimits) {
        await rule.limiter.assertWithinLimit(rule.keyOf(req, fingerprint));
      }
    } else if (options.rateLimiter) {
      const key = options.rateLimitKeyOf?.(req, fingerprint) ?? `token:${fingerprint}`;
      await options.rateLimiter.assertWithinLimit(key);
    }
    const now = options.now?.();
    const auth = await verifyOnboardingToken(options.client, presentedToken, options.serialNumberOf(req), {
      ...(now ? { now } : {}),
      ...(options.allowImplicitSerialNumber ? { allowImplicitSerialNumber: true } : {}),
    });
    return handler(req, auth);
  };
}
