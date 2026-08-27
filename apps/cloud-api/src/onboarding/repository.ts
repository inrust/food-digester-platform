/**
 * BE-ONB-01 Onboarding Request Repository。
 *
 * - 幂等依据：DB-01 部分唯一索引 onboarding_requests_one_pending_per_serial
 *   （同序列号仅一条 PENDING）与 onboarding_requests_token_id_key（一 Token 一申请）；
 * - 并发重复提交：create 命中唯一冲突（P2002）后回读既有 PENDING 记录，
 *   由调用方幂等返回原 request，不产生第二条记录；
 * - 只读/只增：本模块不提供更新/删除路径（审批写状态属 BE-ONB-02）。
 */
import type { DbClient } from '@fdp/database';

export interface OnboardingRequestRecord {
  readonly id: string;
  readonly tokenId: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly hardwareVersion: string;
  readonly manufacturer: string;
  readonly manufactureDate: Date;
  readonly status: string;
  readonly rejectReason: string | null;
  readonly createdAt: Date;
}

interface OnboardingRequestDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<OnboardingRequestRecord | null>;
  create(args: { data: Record<string, unknown> }): Promise<OnboardingRequestRecord>;
}

function requests(client: DbClient): OnboardingRequestDelegate {
  return (client as unknown as Record<string, unknown>).onboardingRequest as OnboardingRequestDelegate;
}

/** Prisma 唯一约束冲突（P2002）。 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** 查询某序列号当前 PENDING 申请（幂等重放判定点）。 */
export function findPendingOnboardingRequest(
  client: DbClient,
  serialNumber: string,
): Promise<OnboardingRequestRecord | null> {
  return requests(client).findFirst({ where: { serialNumber, status: 'PENDING' } });
}

/** 按 Token 精确查询申请（Status API：Token 一次一机，tokenId 唯一）。 */
export function findOnboardingRequestByTokenId(
  client: DbClient,
  tokenId: string,
): Promise<OnboardingRequestRecord | null> {
  return requests(client).findFirst({ where: { tokenId } });
}

export interface CreateOnboardingRequestData {
  readonly tokenId: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly hardwareVersion: string;
  readonly manufacturer: string;
  readonly manufactureDate: Date;
}

/** 创建 PENDING 申请；唯一冲突原样抛出（由 Service 转为幂等回读）。 */
export function createOnboardingRequest(
  client: DbClient,
  data: CreateOnboardingRequestData,
): Promise<OnboardingRequestRecord> {
  return requests(client).create({
    data: {
      tokenId: data.tokenId,
      serialNumber: data.serialNumber,
      model: data.model,
      hardwareVersion: data.hardwareVersion,
      manufacturer: data.manufacturer,
      manufactureDate: data.manufactureDate,
      status: 'PENDING',
    },
  });
}
