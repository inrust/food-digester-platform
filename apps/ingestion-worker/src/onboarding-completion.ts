/**
 * BE-ONB-04 首个 Heartbeat 完成 Onboarding（领域集成 Handler）。
 *
 * 由 BE-IOT-04 Heartbeat Handler 在消息认证（AUTH-03）与最新状态更新后调用本扩展点。
 *
 * 规则（技术对接要求）：
 * - 证书必须与 Device 匹配：device_certificates 中 fingerprint + deviceId 对应且未撤销；
 *   不匹配 → FORBIDDEN（不迁移，记 FAILURE 审计）；
 * - 仅 OnboardingApproved 可迁移；其他状态（含 PendingOnboarding/Active 等）→ DEVICE_STATE_NOT_ALLOWED；
 * - 原子性：设备迁移 + 状态历史 + 证书置 ACTIVE + 证书包销毁 + 上线时间记录在同一事务；
 * - 幂等：重复 Heartbeat（设备已 Onboarded）→ transitioned=false，无重复写入；
 *   并发首个 Heartbeat 由条件更新 (id, lifecycleStatus='OnboardingApproved') 兜底，仅一个生效。
 *
 * 功能边界：不自动分配 Customer/Site，不自动发 License。
 */
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';
import { DeviceStateError, transitionLifecycle } from '@fdp/domain';
import type { SecurePackageService } from '@fdp/auth';

export interface FirstHeartbeatInput {
  /** 来自已认证消息上下文的设备 ID（AUTH-03/BE-IOT-04 注入）。 */
  readonly deviceId: string;
  /** 当前连接使用的证书指纹（SHA-256，AUTH-03 提取）。 */
  readonly certificateFingerprint: string;
  /** Heartbeat 发生时间（缺省为注入时钟）。 */
  readonly occurredAt?: Date;
}

export interface OnboardingCompletionDeps {
  readonly client: DbClient;
  readonly securePackage: SecurePackageService;
  readonly now?: () => Date;
}

export interface OnboardingCompletionResult {
  readonly deviceId: string;
  /** true 表示本次执行了 OnboardingApproved → Onboarded 迁移；false 为幂等重放。 */
  readonly transitioned: boolean;
  /** 本次是否销毁了证书包密文（已领取销毁/无包 → false，幂等）。 */
  readonly packageDestroyed: boolean;
}

interface DeviceRow {
  readonly id: string;
  readonly lifecycleStatus: string;
}

interface CertificateRow {
  readonly id: string;
  readonly deviceId: string;
  readonly status: string;
}

interface DeviceDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface CertificateDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface StateHistoryDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

interface LatestStateDelegate {
  upsert(args: {
    where: Record<string, unknown>;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
}

function devices(client: DbClient): DeviceDelegate {
  return (client as unknown as Record<string, unknown>).device as DeviceDelegate;
}

function certificates(client: DbClient): CertificateDelegate {
  return (client as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;
}

/** 并发首个 Heartbeat 败方标记（条件更新未命中）：对外转为幂等重放。 */
class ConcurrentCompletion extends Error {
  override readonly name = 'ConcurrentCompletion';
}

export async function completeOnboardingOnFirstHeartbeat(
  deps: OnboardingCompletionDeps,
  input: FirstHeartbeatInput,
): Promise<OnboardingCompletionResult> {
  const now = deps.now?.() ?? new Date();
  const occurredAt = input.occurredAt ?? now;

  // 预检（根客户端）：已完成 Onboarding 的重复 Heartbeat 直接幂等返回，不产生审计噪音
  const preview = await devices(deps.client).findFirst({ where: { id: input.deviceId } });
  if (preview?.lifecycleStatus === 'Onboarded') {
    return { deviceId: preview.id, transitioned: false, packageDestroyed: false };
  }

  try {
    return await audited(
      deps.client,
      {
        objectType: 'device',
        objectId: input.deviceId,
        action: 'device.lifecycle.OnboardingApproved_to_Onboarded',
        actorId: 'system:onboarding-completion',
        beforeValue: { lifecycleStatus: 'OnboardingApproved' },
        afterValue: (result: unknown) => ({
          lifecycleStatus: 'Onboarded',
          transitioned: (result as OnboardingCompletionResult).transitioned,
        }),
      },
      async (tx) => {
        const device = await devices(tx).findFirst({ where: { id: input.deviceId } });
        if (!device) throw new DeviceStateError('VALIDATION_FAILED', `设备不存在: ${input.deviceId}`);

        // 幂等：已完成 Onboarding → 重放，无重复写入
        if (device.lifecycleStatus === 'Onboarded') {
          return { deviceId: device.id, transitioned: false, packageDestroyed: false };
        }
        if (device.lifecycleStatus !== 'OnboardingApproved') {
          throw new DeviceStateError(
            'DEVICE_STATE_NOT_ALLOWED',
            `生命周期不允许迁移: ${device.lifecycleStatus} → Onboarded`,
          );
        }

        // 证书必须与 Device 匹配（未撤销/未过期）
        const certificate = await certificates(tx).findFirst({
          where: {
            deviceId: device.id,
            fingerprint: input.certificateFingerprint,
            status: { notIn: ['REVOKED', 'EXPIRED'] },
          },
        });
        if (!certificate) {
          throw new DeviceStateError('FORBIDDEN', 'Heartbeat 证书与设备不匹配');
        }

        // DOM-01 迁移（SYSTEM actor；前置：证书已安装 + 首个 Heartbeat）
        const effects = transitionLifecycle(
          { id: device.id, lifecycleStatus: 'OnboardingApproved', operationalStatus: null },
          'Onboarded',
          { actorType: 'SYSTEM', actorId: 'system:onboarding-completion' },
          { certificateInstalled: true, firstHeartbeatReceived: true },
        );

        // 原子条件更新：并发首个 Heartbeat 仅一个生效
        const { count } = await devices(tx).updateMany({
          where: { id: device.id, lifecycleStatus: 'OnboardingApproved' },
          data: { lifecycleStatus: 'Onboarded' },
        });
        if (count !== 1) throw new ConcurrentCompletion();

        const history = (tx as unknown as Record<string, unknown>).deviceStateHistory as StateHistoryDelegate;
        for (const entry of effects.stateHistory) {
          await history.create({
            data: {
              deviceId: entry.deviceId,
              fromStatus: entry.fromStatus,
              toStatus: entry.toStatus,
              actorType: entry.actorType,
              actorId: entry.actorId,
              reason: entry.reason,
            },
          });
        }

        // 证书确认在用：PENDING_CLAIM → ACTIVE；证书包同事务销毁（幂等）
        await certificates(tx).updateMany({
          where: { id: certificate.id, status: 'PENDING_CLAIM' },
          data: { status: 'ACTIVE', claimedAt: now },
        });
        const packageDestroyed = await deps.securePackage.destroyPackage(certificate.id, tx);

        // 记录设备上线时间（latest state 归 BE-IOT-04 全量维护，此处仅落上线基点）
        const latestState = (tx as unknown as Record<string, unknown>).deviceLatestState as LatestStateDelegate;
        await latestState.upsert({
          where: { deviceId: device.id },
          create: { deviceId: device.id, connectivity: 'ONLINE', lastHeartbeatAt: occurredAt },
          update: { connectivity: 'ONLINE', lastHeartbeatAt: occurredAt },
        });

        return { deviceId: device.id, transitioned: true, packageDestroyed };
      },
    );
  } catch (err) {
    if (err instanceof ConcurrentCompletion) {
      return { deviceId: input.deviceId, transitioned: false, packageDestroyed: false };
    }
    throw err;
  }
}
