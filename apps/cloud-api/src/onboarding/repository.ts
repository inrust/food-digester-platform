/**
 * BE-ONB-01 Onboarding Request Repository。
 *
 * - serial_number 全状态唯一；查询不按审批状态过滤。
 * - 旧申请超时且撤证完成后，可原子替换为一条新的待审申请。
 */
import type { DbClient, Prisma } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';
import { alreadySubmitted, OnboardingApiError } from './errors.js';

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

export function createOrReplaceTimedOutRequest(
  client: DbClient,
  data: Prisma.OnboardingRequestCreateInput,
): Promise<{ id: string }> {
  return withTransaction(client, async (tx) => {
    // 锁住旧申请，避免另一笔重提或状态轮询在清理期间写入关联记录。
    const [previous] = await tx.$queryRaw<{ id: string; status: string; revocationCompletedAt: Date | null }[]>`
      SELECT id, status, revocation_completed_at AS "revocationCompletedAt"
      FROM onboarding_requests
      WHERE serial_number = ${data.serialNumber}
      FOR UPDATE
    `;
    if (!previous) return tx.onboardingRequest.create({ data, select: { id: true } });
    // 撤证重试依赖旧申请。云端撤证确认前保留记录，让超时任务继续收敛。
    if (previous.status !== 'TIMED_OUT') throw alreadySubmitted();
    if (!previous.revocationCompletedAt) {
      throw new OnboardingApiError('CONFLICT', 'Certificate revocation is pending; try again later');
    }

    await tx.onboardingProofNonce.deleteMany({ where: { requestId: previous.id } });
    await tx.onboardingProvisioningJob.deleteMany({ where: { requestId: previous.id } });
    await tx.onboardingRequest.delete({ where: { id: previous.id } });
    const created = await tx.onboardingRequest.create({ data, select: { id: true } });
    await recordAudit(tx, {
      objectType: 'onboarding_request',
      objectId: previous.id,
      action: 'onboarding.request.resubmit',
      result: 'SUCCESS',
      afterValue: { requestId: created.id },
    });
    return created;
  });
}
