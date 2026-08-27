/**
 * AUTH-02 Onboarding Token 生成与散列。
 *
 * - 明文 Token：`fdp_onb_` + 32 字节随机（base64url），仅签发时返回一次；
 * - 存储：仅保存 SHA-256 散列（实施方案 8.2「只保存 Hash」）；
 * - 日志/审计只允许记录指纹（散列前 16 hex），明文绝不出现在持久层与日志。
 */
import { createHash, randomBytes } from 'node:crypto';

export const ONBOARDING_TOKEN_PREFIX = 'fdp_onb_' as const;

const TOKEN_PATTERN = /^fdp_onb_[A-Za-z0-9_-]{43}$/;

/** 生成明文 Token（仅返回值携带明文，调用方负责一次性下发）。 */
export function generateOnboardingToken(): string {
  return `${ONBOARDING_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function isWellFormedOnboardingToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** SHA-256 散列（hex），数据库唯一存储形态。 */
export function hashOnboardingToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 日志/审计指纹：散列前 16 hex，可定位不可还原。 */
export function tokenFingerprint(token: string): string {
  return fingerprintOfHash(hashOnboardingToken(token));
}

export function fingerprintOfHash(tokenHash: string): string {
  return tokenHash.slice(0, 16);
}
