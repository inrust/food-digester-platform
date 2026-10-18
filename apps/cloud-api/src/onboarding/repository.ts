/**
 * BE-ONB-01 Onboarding Request Repository。
 *
 * - serial_number 全状态唯一；查询不按审批状态过滤。
 * - 并发重复提交：create 命中唯一冲突（P2002）后返回已提交提示，不产生第二条记录。
 * - 只读/只增：本模块不提供更新/删除路径（审批写状态属 BE-ONB-02）。
 */
import type { DbClient } from '@fdp/database';

export interface OnboardingRequestRecord {
  readonly id: string;
  readonly csrPem: string;
  readonly publicKeyFingerprint: string;
  readonly serialNumber: string;
  readonly submittedBy: string;
  readonly model: string;
  readonly hardwareVersion: string;
  readonly manufacturer: string;
  readonly manufactureDate: Date;
  readonly status: string;
  readonly rejectReason: string | null;
  readonly onboardingDeadlineAt: Date | null;
  readonly timedOutAt: Date | null;
  readonly revocationCompletedAt: Date | null;
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

/** 查询某序列号是否曾提交申请，包括已批准、拒绝和超时。 */
export function findOnboardingRequestBySerial(
  client: DbClient,
  serialNumber: string,
): Promise<OnboardingRequestRecord | null> {
  return requests(client).findFirst({ where: { serialNumber } });
}
