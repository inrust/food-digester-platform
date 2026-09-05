/**
 * BE-ONB-02 管理员 Onboarding 审批 Service（业务核心，框架无关）。
 *
 * 审批链：
 * 1. reject 强制填写原因（VALIDATION_FAILED 400，前置校验不进事务）；
 * 2. 事务内（DOM-03 audited：业务写入 + SUCCESS 审计同 commit，失败独立记 FAILURE）：
 *    申请存在 → 设备库存资料与申请一致（审批校验设备资料）→ 设备处于 PendingOnboarding →
 *    条件更新 (status='PENDING', version=If-Match) 防重复/并发审批 →
 *    DOM-01 生命周期迁移（OnboardingApproved/Rejected）+ 状态历史落库；
 * 3. approve 提交后触发证书发放服务端口（provisioningTrigger，BE-ONB-03 实现）；
 *    触发失败不影响审批结果（BE-ONB-03 要求签发可重试），绝不向管理员返回私钥。
 *
 * 审计内容：前后状态（申请 status/version + 设备 lifecycleStatus）；DOM-03 脱敏器
 * 自动遮蔽 token 类字段，审计不含 Token。
 */
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';
import { transitionLifecycle } from '@fdp/domain';
import type { ActorContext } from '@fdp/auth';
import { createRedactingLogger } from '@fdp/observability';
import { deviceConflict, requestNotFound, validationFailed } from './errors.js';
import { findOnboardingRequestById, reviewOnboardingRequestWithVersion } from './repository.js';
import type { AdminOnboardingRequestRecord } from './repository.js';

const logger = createRedactingLogger(console);

export interface ReviewInput {
  readonly requestId: string;
  readonly decision: 'approve' | 'reject';
  /** If-Match 版本（Handler 解析 Header 后传入）。 */
  readonly ifMatchVersion: number;
  readonly reason?: string | undefined;
}

/** 证书发放服务端口：BE-ONB-03 注入实现；approve 提交后触发，不返回任何密钥材料。 */
export interface ProvisioningTrigger {
  triggerApproved(request: AdminOnboardingRequestRecord): Promise<void>;
}

export interface ReviewDeps {
  readonly now?: () => Date;
  readonly provisioningTrigger?: ProvisioningTrigger;
}

interface DeviceRow {
  readonly id: string;
  readonly serialNumber: string;
  readonly model: string;
  readonly hardwareVersion: string;
  readonly manufacturer: string;
  readonly manufactureDate: Date;
  readonly lifecycleStatus: string;
}

interface DeviceDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface StateHistoryDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

function devices(client: DbClient): DeviceDelegate {
  return (client as unknown as Record<string, unknown>).device as DeviceDelegate;
}

function stateHistory(client: DbClient): StateHistoryDelegate {
  return (client as unknown as Record<string, unknown>).deviceStateHistory as StateHistoryDelegate;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 审批校验设备资料：库存存在且型号/硬件版本/厂商/生产日期与申请一致；设备须处于 PendingOnboarding。 */
function assertDeviceReviewable(device: DeviceRow | null, request: AdminOnboardingRequestRecord): DeviceRow {
  if (!device) throw deviceConflict('The device inventory record does not exist');
  const matched =
    device.model === request.model &&
    device.hardwareVersion === request.hardwareVersion &&
    device.manufacturer === request.manufacturer &&
    isoDate(device.manufactureDate) === isoDate(request.manufactureDate);
  if (!matched) throw deviceConflict('The device inventory data does not match the onboarding request');
  if (device.lifecycleStatus !== 'PendingOnboarding') {
    throw deviceConflict('The device is not in a state that allows onboarding review');
  }
  return device;
}

export async function reviewOnboardingRequest(
  rootClient: DbClient,
  actor: ActorContext,
  input: ReviewInput,
  deps: ReviewDeps = {},
): Promise<AdminOnboardingRequestRecord> {
  const now = deps.now?.() ?? new Date();
  const reason = input.reason?.trim() || null;
  if (input.decision === 'reject' && !reason) {
    throw validationFailed('The reason is required when rejecting an onboarding request');
  }
  const toStatus = input.decision === 'approve' ? ('APPROVED' as const) : ('REJECTED' as const);
  const action = `onboarding.request.${input.decision}`;

  const reviewed = await audited<AdminOnboardingRequestRecord>(
    rootClient,
    {
      objectType: 'onboarding_request',
      objectId: input.requestId,
      action,
      reason,
      actorId: actor.actorId,
      actorRole: 'PlatformSuperAdmin',
      beforeValue: { status: 'PENDING', version: input.ifMatchVersion },
      afterValue: (result: unknown) => {
        const record = result as AdminOnboardingRequestRecord;
        return { status: record.status, version: record.version, rejectReason: record.rejectReason };
      },
    },
    async (tx) => {
      const request = await findOnboardingRequestById(tx, input.requestId);
      if (!request) throw requestNotFound();

      const device = assertDeviceReviewable(
        await devices(tx).findFirst({ where: { serialNumber: request.serialNumber } }),
        request,
      );

      // DOM-01 生命周期迁移（非法跳转/缺原因由领域层抛错，事务回滚）
      const effects = transitionLifecycle(
        { id: device.id, lifecycleStatus: device.lifecycleStatus as 'PendingOnboarding', operationalStatus: null },
        input.decision === 'approve' ? 'OnboardingApproved' : 'Rejected',
        { actorType: 'ADMIN', actorId: actor.actorId, actorRole: 'PlatformSuperAdmin' },
        input.decision === 'approve' ? { deviceValidated: true } : { reason: reason ?? '' },
      );

      // 条件更新：并发/重复审批最多一个成功
      const updated = await reviewOnboardingRequestWithVersion(tx, input.requestId, input.ifMatchVersion, {
        status: toStatus,
        rejectReason: input.decision === 'reject' ? reason : null,
        reviewedBy: actor.actorId,
        reviewedAt: now,
      });

      await devices(tx).updateMany({
        where: { id: device.id },
        data: { lifecycleStatus: input.decision === 'approve' ? 'OnboardingApproved' : 'Rejected' },
      });
      for (const entry of effects.stateHistory) {
        await stateHistory(tx).create({
          data: {
            deviceId: entry.deviceId,
            axis: entry.axis,
            fromStatus: entry.fromStatus,
            toStatus: entry.toStatus,
            actorType: entry.actorType,
            actorId: entry.actorId,
            reason: entry.reason,
          },
        });
      }
      return updated;
    },
  );

  // approve 只触发证书发放服务（BE-ONB-03 端口）；触发失败可重试，不回滚审批
  if (input.decision === 'approve' && deps.provisioningTrigger) {
    try {
      await deps.provisioningTrigger.triggerApproved(reviewed);
    } catch (err) {
      logger.error('provisioning 触发失败（可重试）', err);
    }
  }
  return reviewed;
}
