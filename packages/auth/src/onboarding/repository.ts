/**
 * AUTH-02 Onboarding Token Repository。
 *
 * - 签发：校验设备库存序列号存在（Token 与库存绑定），落库仅散列；
 * - 撤销/核销：条件更新保证幂等与一次性语义；
 * - 查询：仅按散列查找，任何路径不返回明文。
 */
import type { DbClient } from '@fdp/database';
import { validationFailed } from '../errors.js';
import { generateOnboardingToken, hashOnboardingToken } from './token.js';

export interface OnboardingTokenRecord {
  readonly id: string;
  readonly serialNumber: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

interface OnboardingTokenDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<OnboardingTokenRecord | null>;
  create(args: { data: Record<string, unknown> }): Promise<OnboardingTokenRecord>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function tokens(client: DbClient): OnboardingTokenDelegate {
  return (client as unknown as Record<string, unknown>).onboardingToken as OnboardingTokenDelegate;
}

export interface IssuedOnboardingToken {
  /** 明文 Token：仅本返回值携带，禁止落库/日志。 */
  readonly token: string;
  readonly record: OnboardingTokenRecord;
}

/**
 * 签发 Token：一次一机，序列号必须存在于设备库存（devices 表）。
 * 库存不存在 → VALIDATION_FAILED（400）。
 */
export async function issueOnboardingToken(
  client: DbClient,
  input: { serialNumber: string; expiresAt: Date },
): Promise<IssuedOnboardingToken> {
  if (!input.serialNumber) throw validationFailed('serialNumber is required');
  const devices = (client as unknown as Record<string, unknown>).device as {
    findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
  };
  const inventory = await devices.findFirst({ where: { serialNumber: input.serialNumber } });
  if (!inventory) {
    throw validationFailed('The serial number does not exist in the device inventory');
  }

  const token = generateOnboardingToken();
  const record = await tokens(client).create({
    data: {
      tokenHash: hashOnboardingToken(token),
      serialNumber: input.serialNumber,
      expiresAt: input.expiresAt,
    },
  });
  return { token, record };
}

export async function findOnboardingTokenByHash(
  client: DbClient,
  tokenHash: string,
): Promise<OnboardingTokenRecord | null> {
  return tokens(client).findFirst({ where: { tokenHash } });
}

/** 撤销：幂等；返回是否本次生效（已撤销/不存在 → false）。 */
export async function revokeOnboardingToken(client: DbClient, tokenId: string, now: Date): Promise<boolean> {
  const { count } = await tokens(client).updateMany({
    where: { id: tokenId, revokedAt: null },
    data: { revokedAt: now },
  });
  return count === 1;
}

/**
 * 核销（一次一机的"一次"）：证书包领取完成后由 BE-ONB-03/04 调用。
 * 条件更新 usedAt/revokedAt 均为空；已核销或已撤销 → false（并发安全）。
 */
export async function markOnboardingTokenUsed(client: DbClient, tokenId: string, now: Date): Promise<boolean> {
  const { count } = await tokens(client).updateMany({
    where: { id: tokenId, usedAt: null, revokedAt: null },
    data: { usedAt: now },
  });
  return count === 1;
}
