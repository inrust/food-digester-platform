/**
 * AUTH-03 Device mTLS 身份映射（应用白名单校验）。
 *
 * CA 链验证（API Gateway mTLS）不能替代应用白名单：同 CA 签出但未登记的证书必须拒绝。
 * 校验链：证书存在（指纹唯一索引）→ 状态 ACTIVE（PENDING_CLAIM/REVOKED/EXPIRED 拒绝）→
 * 有效期（notBefore/notAfter）→ Device 归属（请求 deviceId 必须等于证书绑定设备）→
 * 设备生命周期（Retired 默认拒绝，DOM-01）；DEC-014 仅允许 Sync 显式申请 72 小时
 * 待确认窗口能力，且必须存在 PENDING_CONFIRMATION 记录；Suspended 设备放行。
 *
 * 凭证问题（缺失/未登记/非 ACTIVE/过期）→ 401 UNAUTHENTICATED；
 * 归属与生命周期拒绝 → 403 FORBIDDEN。
 */
import type { DbClient } from '@fdp/database';
import { forbidden, unauthenticated } from '../errors.js';
import { certificateFingerprintFromPem } from './mtls-context.js';
import type { ClientCertIdentity } from './mtls-context.js';

/** 证书状态（device_certificates.status，DB-01）。仅 ACTIVE 可通过认证。 */
export const CERT_STATUS_ACTIVE = 'ACTIVE' as const;
export const RETIREMENT_CONFIRMATION_WINDOW_HOURS = 72 as const;
export const RETIREMENT_CONFIRMATION_WINDOW_MS = RETIREMENT_CONFIRMATION_WINDOW_HOURS * 60 * 60 * 1000;

/** 注入下游的可信设备上下文。 */
export interface DeviceAuthContext {
  readonly deviceId: string;
  readonly certificateId: string;
  /** 证书指纹（日志/审计使用，等价于证书身份）。 */
  readonly certificateFingerprint: string;
  readonly customerId: string | null;
  readonly siteId: string | null;
  readonly deviceLifecycleStatus: string;
}

interface DeviceCertificateDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<{
    id: string;
    deviceId: string;
    status: string;
    revokedAt: Date | null;
    notBefore: Date;
    notAfter: Date;
    rotationDeadlineAt?: Date | null;
    rotationConfirmedAt?: Date | null;
  } | null>;
}

interface DeviceDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<{
    id: string;
    customerId: string | null;
    siteId: string | null;
    lifecycleStatus: string;
  } | null>;
}

interface DeviceRetirementDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<{
    status: string;
    initiatedAt: Date;
  } | null>;
}

export interface VerifyDeviceCertificateOptions {
  /** 请求路径/参数中的 deviceId；提供时强制与证书绑定设备一致（不一致 → 403）。 */
  readonly requestedDeviceId?: string;
  /** 注入时钟（测试用）。 */
  readonly now?: Date;
  /** DEC-014：仅 Sync 可申请 Retired 待确认窗口能力；其他调用方不得设置。 */
  readonly retiredAccess?: 'SYNC';
}

export async function verifyDeviceCertificate(
  client: DbClient,
  identity: ClientCertIdentity | null | undefined,
  options: VerifyDeviceCertificateOptions = {},
): Promise<DeviceAuthContext> {
  if (!identity?.clientCertPem) throw unauthenticated();
  const fingerprint = certificateFingerprintFromPem(identity.clientCertPem);

  const certificates = (client as unknown as Record<string, unknown>).deviceCertificate as DeviceCertificateDelegate;
  const certificate = await certificates.findFirst({ where: { fingerprint } });
  // 同 CA 未登记证书：白名单拒绝
  if (!certificate) throw unauthenticated();
  // 状态白名单：仅 ACTIVE；REVOKED/EXPIRED/PENDING_CLAIM 一律拒绝
  if (certificate.status !== CERT_STATUS_ACTIVE) throw unauthenticated();
  // 冗余防线：撤销时间戳存在即拒绝（状态机之外的直接置位）
  if (certificate.revokedAt !== null) throw unauthenticated();

  const now = options.now ?? new Date();
  if (now.getTime() < certificate.notBefore.getTime() || now.getTime() >= certificate.notAfter.getTime()) {
    throw unauthenticated();
  }
  if (certificate.rotationDeadlineAt && !certificate.rotationConfirmedAt && now >= certificate.rotationDeadlineAt)
    throw unauthenticated();

  // Device 归属：请求其他 deviceId → 403（身份有效但无权代表该设备）
  if (options.requestedDeviceId !== undefined && options.requestedDeviceId !== certificate.deviceId) {
    throw forbidden('The certificate is not bound to the requested device');
  }

  const devices = (client as unknown as Record<string, unknown>).device as DeviceDelegate;
  const device = await devices.findFirst({ where: { id: certificate.deviceId } });
  if (!device) throw unauthenticated();
  // Retired 为永久退役（DOM-01）；DEC-014 仅给 Sync 一个有截止时间的显式例外。
  if (device.lifecycleStatus === 'Retired') {
    if (options.retiredAccess !== 'SYNC') throw forbidden('The device is retired');
    const retirements = (client as unknown as Record<string, unknown>).deviceRetirement as DeviceRetirementDelegate;
    const retirement = await retirements.findFirst({
      where: { deviceId: device.id, status: 'PENDING_CONFIRMATION' },
    });
    const deadline = retirement
      ? retirement.initiatedAt.getTime() + RETIREMENT_CONFIRMATION_WINDOW_MS
      : Number.NEGATIVE_INFINITY;
    // 到达边界即 fail closed；即使调度器延迟，也不会扩大临时认证窗口。
    if (!retirement || now.getTime() >= deadline) throw forbidden('The device retirement window is closed');
  }

  return {
    deviceId: device.id,
    certificateId: certificate.id,
    certificateFingerprint: fingerprint,
    customerId: device.customerId,
    siteId: device.siteId,
    deviceLifecycleStatus: device.lifecycleStatus,
  };
}
