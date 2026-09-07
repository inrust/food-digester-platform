/**
 * BE-SYNC-02 Device Deactivate 领域服务：接收退役确认并完成证书停用。
 *
 * 背景与顺序约束（BE-DEV-04 验收：不能先断证导致设备无法确认）：
 * - BE-DEV-04 管理员 retire 将设备迁移到 Retired（DOM-01 终态，永久不可恢复），撤销
 *   Assignment/License，创建 PENDING_CONFIRMATION 退役记录；证书保持 ACTIVE 以便设备确认；
 * - 设备调用 POST /api/v1/device/deactivate 确认后，本服务标记 CONFIRMED 并撤销 ACTIVE
 *   证书（退役完成步骤，本服务唯一负责撤销点）；
 * - AUTH-03 verifyDeviceCertificate 对 Retired 默认 403（Sync 有 DEC-014 限时例外），因此本端点
 *   使用专用身份校验：证书 ACTIVE+有效期内 → 正常确认；证书已 REVOKED 且对应退役记录
 *   CONFIRMED 且撤销时间一致 → 判定为重复确认，幂等返回（重复调用结果一致）；其余拒绝。
 *
 * 规则：
 * - 非退役设备（Active/Suspended 等）直接调用 → 409 DEVICE_STATE_NOT_ALLOWED；
 * - Retired 但无退役记录 → 409 CONFLICT（状态不一致）；
 * - 重复确认幂等：不产生新写入/审计，返回相同退役视图（replayed=true）；
 * - 审计 device.deactivate.confirm（actorRole=DEVICE）；审计/响应仅含 certificateId +
 *   fingerprint 摘要，绝不泄露证书材料（PEM/私钥/证书包密文）；
 * - 功能边界：不负责设备本地数据删除或物理退役。
 */
import { unauthenticated } from '@fdp/auth';
import type { ClientCertIdentity } from '@fdp/auth';
import { certificateFingerprintFromPem } from '@fdp/auth';
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';

export type DeactivateErrorCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'DEVICE_STATE_NOT_ALLOWED';

export const DEACTIVATE_ERROR_HTTP_STATUS: Readonly<Record<DeactivateErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DEVICE_STATE_NOT_ALLOWED: 409,
} as const;

export class DeviceDeactivateError extends Error {
  override readonly name = 'DeviceDeactivateError';
  readonly code: DeactivateErrorCode;

  constructor(code: DeactivateErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return DEACTIVATE_ERROR_HTTP_STATUS[this.code];
  }
}

export const RETIREMENT_PENDING = 'PENDING_CONFIRMATION' as const;
export const RETIREMENT_CONFIRMED = 'CONFIRMED' as const;
export const COMPLETION_DEVICE_CONFIRM = 'DEVICE_CONFIRM' as const;
/** BE-DEV-04 force-complete 的完成方式标记。 */
export const COMPLETION_FORCE_COMPLETE = 'FORCE_COMPLETE' as const;
/** DEC-014：72 小时未确认自动完成。 */
export const COMPLETION_UNCONFIRMED_TIMEOUT = 'UNCONFIRMED_TIMEOUT' as const;

/**
 * 退役完成步骤（共享：BE-SYNC-02 设备确认 / BE-DEV-04 force-complete）。
 * 同事务：条件更新退役记录 PENDING_CONFIRMATION → CONFIRMED（并发漂移返回 confirmed=false），
 * 随后撤销该设备全部 ACTIVE 证书（确认在先、断证在后）。
 */
export async function completeRetirementStep(
  tx: DbClient,
  input: { readonly deviceId: string; readonly at: Date; readonly completionMethod: string },
): Promise<{ readonly confirmed: boolean; readonly revoked: readonly CertificateRow[] }> {
  const { count } = await retirements(tx).updateMany({
    where: { deviceId: input.deviceId, status: RETIREMENT_PENDING },
    data: {
      status: RETIREMENT_CONFIRMED,
      confirmedAt: input.at,
      completionMethod: input.completionMethod,
      certificateRevokedAt: input.at,
    },
  });
  if (count !== 1) return { confirmed: false, revoked: [] };
  const active = await certificates(tx).findMany({ where: { deviceId: input.deviceId, status: 'ACTIVE' } });
  if (active.length > 0) {
    await certificates(tx).updateMany({
      where: { id: { in: active.map((c) => c.id) }, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: input.at },
    });
  }
  return { confirmed: true, revoked: active };
}

export interface RevokedCertificateSummary {
  readonly certificateId: string;
  readonly fingerprint: string;
  readonly status: 'REVOKED';
  readonly revokedAt: string;
}

export interface DeactivationResult {
  readonly deviceId: string;
  readonly lifecycleStatus: 'Retired';
  readonly retirement: {
    readonly retirementId: string;
    readonly status: typeof RETIREMENT_CONFIRMED;
    readonly reason: string;
    readonly initiatedBy: string;
    readonly initiatedAt: string;
    readonly confirmedAt: string;
    readonly completionMethod: string;
    readonly certificateRevokedAt: string | null;
  };
  readonly certificates: readonly RevokedCertificateSummary[];
  /** 幂等重放：退役已完成（含证书撤销后的重复确认），未产生新写入。 */
  readonly replayed: boolean;
}

interface CertificateRow {
  readonly id: string;
  readonly deviceId: string;
  readonly fingerprint: string;
  readonly status: string;
  readonly revokedAt: Date | null;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

interface RetirementRow {
  readonly id: string;
  readonly deviceId: string;
  readonly status: string;
  readonly reason: string;
  readonly initiatedBy: string;
  readonly initiatedAt: Date;
  readonly confirmedAt: Date | null;
  readonly completionMethod: string | null;
  readonly certificateRevokedAt: Date | null;
}

interface DeviceRow {
  readonly id: string;
  readonly customerId: string | null;
  readonly lifecycleStatus: string;
}

interface CertificateDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null>;
  findMany(args: { where: Record<string, unknown> }): Promise<CertificateRow[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface RetirementDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<RetirementRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function certificates(client: DbClient): CertificateDelegate {
  return (client as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;
}

function retirements(client: DbClient): RetirementDelegate {
  return (client as unknown as Record<string, unknown>).deviceRetirement as RetirementDelegate;
}

function devices(client: DbClient): { findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null> } {
  return (client as unknown as Record<string, unknown>).device as never;
}

/** deactivate 专用身份上下文（允许 Retired 设备在证书仍 ACTIVE 时确认）。 */
export interface DeactivateIdentity {
  readonly deviceId: string;
  readonly certificateId: string;
  readonly certificateFingerprint: string;
  /** 证书已撤销但对应退役已 CONFIRMED：重复确认重放。 */
  readonly revokedReplay: boolean;
}

/**
 * deactivate 专用身份校验（不使用 AUTH-03 verifyDeviceCertificate：其对 Retired 默认 403，
 * 而本端点正是 Retired 设备在证书撤销前的确认入口）。
 */
export async function verifyDeactivateIdentity(
  client: DbClient,
  identity: ClientCertIdentity | null | undefined,
  now: Date = new Date(),
): Promise<DeactivateIdentity> {
  if (!identity?.clientCertPem) throw unauthenticated();
  const fingerprint = certificateFingerprintFromPem(identity.clientCertPem);
  const cert = await certificates(client).findFirst({ where: { fingerprint } });
  if (!cert) throw unauthenticated();

  if (cert.status === 'ACTIVE' && cert.revokedAt === null) {
    if (now.getTime() < cert.notBefore.getTime() || now.getTime() >= cert.notAfter.getTime()) {
      throw unauthenticated();
    }
    return {
      deviceId: cert.deviceId,
      certificateId: cert.id,
      certificateFingerprint: fingerprint,
      revokedReplay: false,
    };
  }

  if (cert.status === 'REVOKED') {
    // 重复确认：证书由本服务的退役完成步骤撤销（撤销时间与退役记录一致）→ 幂等放行
    const retirement = await retirements(client).findFirst({ where: { deviceId: cert.deviceId } });
    if (
      retirement?.status === RETIREMENT_CONFIRMED &&
      retirement.certificateRevokedAt !== null &&
      cert.revokedAt !== null &&
      retirement.certificateRevokedAt.getTime() === cert.revokedAt.getTime()
    ) {
      return {
        deviceId: cert.deviceId,
        certificateId: cert.id,
        certificateFingerprint: fingerprint,
        revokedReplay: true,
      };
    }
    throw unauthenticated();
  }
  // PENDING_CLAIM / EXPIRED 一律拒绝
  throw unauthenticated();
}

function toResult(
  device: DeviceRow,
  retirement: RetirementRow,
  certs: readonly CertificateRow[],
  replayed: boolean,
): DeactivationResult {
  return {
    deviceId: device.id,
    lifecycleStatus: 'Retired',
    retirement: {
      retirementId: retirement.id,
      status: RETIREMENT_CONFIRMED,
      reason: retirement.reason,
      initiatedBy: retirement.initiatedBy,
      initiatedAt: retirement.initiatedAt.toISOString(),
      confirmedAt: retirement.confirmedAt?.toISOString() ?? '',
      completionMethod: retirement.completionMethod ?? COMPLETION_DEVICE_CONFIRM,
      certificateRevokedAt: retirement.certificateRevokedAt?.toISOString() ?? null,
    },
    certificates: certs.map((c) => ({
      certificateId: c.id,
      fingerprint: c.fingerprint,
      status: 'REVOKED' as const,
      revokedAt: c.revokedAt?.toISOString() ?? '',
    })),
    replayed,
  };
}

async function replayView(client: DbClient, device: DeviceRow, retirement: RetirementRow): Promise<DeactivationResult> {
  // 重放视图：本次完成步骤撤销的证书（revokedAt 与退役记录一致）
  const certs = retirement.certificateRevokedAt
    ? await certificates(client).findMany({
        where: { deviceId: device.id, status: 'REVOKED', revokedAt: retirement.certificateRevokedAt },
      })
    : [];
  return toResult(device, retirement, certs, true);
}

/** 接收退役确认：校验待退役上下文 → 标记 CONFIRMED → 完成证书停用（同事务）→ 审计。 */
export async function confirmDeactivation(
  rootClient: DbClient,
  identity: DeactivateIdentity,
  now: () => Date = () => new Date(),
): Promise<DeactivationResult> {
  const device = await devices(rootClient).findFirst({ where: { id: identity.deviceId } });
  if (!device) throw new DeviceDeactivateError('NOT_FOUND', 'The requested resource was not found');
  // 非退役设备不得停用（Active/Suspended 直接调用被拒绝）
  if (device.lifecycleStatus !== 'Retired') {
    throw new DeviceDeactivateError(
      'DEVICE_STATE_NOT_ALLOWED',
      `The device lifecycle status ${device.lifecycleStatus} does not allow deactivation`,
    );
  }
  const retirement = await retirements(rootClient).findFirst({ where: { deviceId: device.id } });
  if (!retirement) {
    throw new DeviceDeactivateError('CONFLICT', 'The device has no pending retirement record');
  }
  if (retirement.status === RETIREMENT_CONFIRMED) {
    return replayView(rootClient, device, retirement);
  }

  const at = now();
  return audited<DeactivationResult>(
    rootClient,
    {
      objectType: 'device',
      objectId: device.id,
      action: 'device.deactivate.confirm',
      reason: retirement.reason,
      actorId: identity.deviceId,
      actorRole: 'DEVICE',
      customerId: device.customerId,
      beforeValue: { retirementStatus: RETIREMENT_PENDING },
      afterValue: (result: unknown) => {
        const r = result as DeactivationResult;
        // 仅摘要：certificateId + fingerprint，绝不写入证书材料
        return {
          retirementStatus: r.retirement.status,
          completionMethod: r.retirement.completionMethod,
          revokedCertificates: r.certificates.map((c) => ({
            certificateId: c.certificateId,
            fingerprint: c.fingerprint,
          })),
        };
      },
    },
    async (tx) => {
      // 并发兜底 + 退役完成步骤：确认在先、断证在后（共享 completeRetirementStep）
      const step = await completeRetirementStep(tx, {
        deviceId: device.id,
        at,
        completionMethod: COMPLETION_DEVICE_CONFIRM,
      });
      if (!step.confirmed) {
        throw new DeviceDeactivateError('CONFLICT', 'The retirement was confirmed concurrently; refresh and retry');
      }

      return toResult(
        device,
        {
          ...retirement,
          status: RETIREMENT_CONFIRMED,
          confirmedAt: at,
          completionMethod: COMPLETION_DEVICE_CONFIRM,
          certificateRevokedAt: at,
        },
        step.revoked.map((c) => ({ ...c, status: 'REVOKED', revokedAt: at })),
        false,
      );
    },
  );
}
