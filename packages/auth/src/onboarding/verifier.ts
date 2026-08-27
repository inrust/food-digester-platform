/**
 * AUTH-02 Onboarding Token 校验（设备接口认证核心）。
 *
 * 校验链（任一失败即 401 UNAUTHENTICATED，不区分原因防探测）：
 * 格式 → 散列查找 → 已撤销 → 已核销 → 已过期 → 序列号绑定。
 * 序列号缺失/非法为请求校验错误（400 VALIDATION_FAILED）。
 */
import type { DbClient } from '@fdp/database';
import { unauthenticated, validationFailed } from '../errors.js';
import { findOnboardingTokenByHash } from './repository.js';
import { fingerprintOfHash, hashOnboardingToken, isWellFormedOnboardingToken } from './token.js';

/** 校验通过后的可信上下文；日志只允许使用 tokenFingerprint。 */
export interface OnboardingAuthContext {
  readonly tokenId: string;
  readonly serialNumber: string;
  readonly tokenFingerprint: string;
}

export interface VerifyOnboardingTokenOptions {
  /** 注入时钟（测试用），默认当前时间。 */
  readonly now?: Date;
}

export async function verifyOnboardingToken(
  client: DbClient,
  presentedToken: string | null | undefined,
  serialNumber: string | null | undefined,
  options: VerifyOnboardingTokenOptions = {},
): Promise<OnboardingAuthContext> {
  // 先验凭证再验参数：未认证请求不做业务参数校验（防探测）
  if (!presentedToken || !isWellFormedOnboardingToken(presentedToken)) throw unauthenticated();
  if (!serialNumber) throw validationFailed('serialNumber is required');

  const tokenHash = hashOnboardingToken(presentedToken);
  const record = await findOnboardingTokenByHash(client, tokenHash);
  if (!record) throw unauthenticated();

  const now = options.now ?? new Date();
  if (record.revokedAt !== null) throw unauthenticated();
  if (record.usedAt !== null) throw unauthenticated();
  if (record.expiresAt.getTime() <= now.getTime()) throw unauthenticated();
  // Token 与设备库存序列号绑定：跨序列号使用一律拒绝
  if (record.serialNumber !== serialNumber) throw unauthenticated();

  return {
    tokenId: record.id,
    serialNumber: record.serialNumber,
    tokenFingerprint: fingerprintOfHash(tokenHash),
  };
}
