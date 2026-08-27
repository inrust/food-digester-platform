/**
 * BE-CERT-02 轮换确认扩展点：新证书首个合法 Heartbeat 后停用旧证书并销毁新证书包。
 *
 * 由 BE-IOT-04 Heartbeat Handler 在消息认证（AUTH-03）后调用（与 BE-ONB-04 扩展点并列）。
 *
 * 规则：
 * - 仅当心跳证书是该设备的轮换新证书（rotatedFromId 非空、ACTIVE）时才确认；
 * - 原子性：旧证书 REVOKED（条件更新保证并发仅一次）+ 新证书包销毁在同一事务；
 * - 幂等：重复 Heartbeat / 非轮换证书 / 已完成确认 → confirmed=false，无重复写入；
 * - 确认后旧证书立即不可用（AUTH-03 白名单：REVOKED → 401）。
 */
import type { DbClient } from '@fdp/database';
import { audited } from '@fdp/database';
import type { SecurePackageService } from '@fdp/auth';

export interface RotationConfirmationInput {
  /** 来自已认证消息上下文的设备 ID。 */
  readonly deviceId: string;
  /** 当前连接使用的证书指纹。 */
  readonly certificateFingerprint: string;
}

export interface RotationConfirmationDeps {
  readonly client: DbClient;
  readonly securePackage: SecurePackageService;
  readonly now?: () => Date;
}

export interface RotationConfirmationResult {
  readonly deviceId: string;
  /** true 表示本次完成轮换确认（停用旧证书 + 销毁新证书包）。 */
  readonly confirmed: boolean;
  /** 被停用的旧证书 ID（未确认/幂等重放为 null）。 */
  readonly revokedCertificateId: string | null;
}

interface CertificateRow {
  readonly id: string;
  readonly deviceId: string;
  readonly status: string;
  readonly rotatedFromId: string | null;
}

function certificates(client: DbClient) {
  return (client as unknown as Record<string, unknown>).deviceCertificate as {
    findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

export async function confirmCertificateRotationOnFirstHeartbeat(
  deps: RotationConfirmationDeps,
  input: RotationConfirmationInput,
): Promise<RotationConfirmationResult> {
  const now = deps.now?.() ?? new Date();

  // 预检：心跳证书须为本设备的轮换新证书（rotatedFromId 非空且 ACTIVE）
  const preview = await certificates(deps.client).findFirst({
    where: { deviceId: input.deviceId, fingerprint: input.certificateFingerprint, status: 'ACTIVE' },
  });
  if (!preview?.rotatedFromId) {
    return { deviceId: input.deviceId, confirmed: false, revokedCertificateId: null };
  }
  // 已确认过的轮换（旧证已 REVOKED）：后续新证书 Heartbeat 静默幂等，不产生审计噪音
  const oldCert = await certificates(deps.client).findFirst({ where: { id: preview.rotatedFromId } });
  if (!oldCert || oldCert.status !== 'ACTIVE') {
    return { deviceId: input.deviceId, confirmed: false, revokedCertificateId: null };
  }

  return audited(
    deps.client,
    {
      objectType: 'deviceCertificate',
      objectId: preview.id,
      action: 'CERT_ROTATION_CONFIRM',
      actorId: 'system:certificate-rotation',
      beforeValue: { newCertificateId: preview.id, oldCertificateId: preview.rotatedFromId },
      afterValue: (result: unknown) => ({
        confirmed: (result as RotationConfirmationResult).confirmed,
        revokedCertificateId: (result as RotationConfirmationResult).revokedCertificateId,
      }),
    },
    async (tx) => {
      const txCerts = certificates(tx);
      const newCert = await txCerts.findFirst({
        where: { deviceId: input.deviceId, fingerprint: input.certificateFingerprint, status: 'ACTIVE' },
      });
      if (!newCert?.rotatedFromId) {
        return { deviceId: input.deviceId, confirmed: false, revokedCertificateId: null };
      }

      // 停用旧证书（条件更新：并发确认仅一个生效）
      const { count } = await txCerts.updateMany({
        where: { id: newCert.rotatedFromId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now },
      });
      if (count !== 1) {
        return { deviceId: input.deviceId, confirmed: false, revokedCertificateId: null };
      }

      // 销毁新证书包（DEC-003 销毁触发点；幂等）
      await deps.securePackage.destroyPackage(newCert.id, tx);
      return { deviceId: input.deviceId, confirmed: true, revokedCertificateId: newCert.rotatedFromId };
    },
  );
}
