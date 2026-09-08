/**
 * BE-IOT-02 身份与设备台账解析。
 *
 * 信任边界（BE-IOT-01 契约）：Payload 内设备自报字段不可信；身份 = iotPrincipal（证书 ARN）
 * 对照 device_certificates 台账，且必须与 iotDeviceId（Topic 第三段，AUTH-04 Policy 收敛）一致。
 * customerId 只取设备台账，不取 Payload。
 */
import type { DbClient } from '@fdp/database';
import { quarantineError } from './errors.js';

export interface DeviceContext {
  readonly deviceId: string;
  /** 台账客户归属（可空：未分配）；绝不取 Payload 自报值。 */
  readonly customerId: string | null;
  /** 当前站点归属；历史聚合会按事件时间回查 assignment，不信任 Payload。 */
  readonly siteId?: string | null;
  readonly lifecycleStatus: string;
  readonly certificateId: string;
  readonly certificateFingerprint: string;
}

interface CertificateRow {
  readonly id: string;
  readonly deviceId: string;
  readonly fingerprint: string;
  readonly status: string;
  readonly revokedAt: Date | null;
}

interface DeviceRow {
  readonly id: string;
  readonly customerId: string | null;
  readonly siteId: string | null;
  readonly lifecycleStatus: string;
}

/** 从证书 ARN 提取 certificateId（...:cert/<id>）。 */
export function certificateIdFromPrincipal(principal: string): string | null {
  const marker = ':cert/';
  const idx = principal.indexOf(marker);
  if (idx < 0) return null;
  const id = principal.slice(idx + marker.length);
  return id.length > 0 ? id : null;
}

export async function resolveDeviceContext(
  client: DbClient,
  identity: { readonly iotPrincipal: string; readonly iotDeviceId: string },
): Promise<DeviceContext> {
  const certificateId = certificateIdFromPrincipal(identity.iotPrincipal);
  if (!certificateId) {
    throw quarantineError('IDENTITY_VIOLATION', 'iotPrincipal', 'principal is not a certificate ARN');
  }
  const certificates = (client as unknown as Record<string, unknown>).deviceCertificate as {
    findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null>;
  };
  const certificate = await certificates.findFirst({ where: { id: certificateId } });
  if (!certificate) {
    throw quarantineError('UNKNOWN_DEVICE', 'iotPrincipal', 'certificate not registered in device ledger');
  }
  // Topic 设备与证书绑定设备必须一致（跨设备伪装防护）
  if (certificate.deviceId !== identity.iotDeviceId) {
    throw quarantineError('IDENTITY_VIOLATION', 'iotDeviceId', 'topic device does not match certificate binding');
  }
  const devices = (client as unknown as Record<string, unknown>).device as {
    findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
  };
  const device = await devices.findFirst({ where: { id: certificate.deviceId } });
  if (!device) {
    throw quarantineError('UNKNOWN_DEVICE', 'iotDeviceId', 'device not registered in ledger');
  }
  // DEC-014：退役是不可逆安全边界。即使 AWS IoT INACTIVE 尚在重试，八类业务上行也必须失败关闭。
  if (device.lifecycleStatus === 'Retired') {
    throw quarantineError('IDENTITY_VIOLATION', 'iotDeviceId', 'retired device business MQTT is disabled');
  }
  const active = certificate.status === 'ACTIVE';
  const firstHeartbeatCandidate =
    certificate.status === 'PENDING_CLAIM' && device.lifecycleStatus === 'OnboardingApproved';
  if (certificate.revokedAt !== null || (!active && !firstHeartbeatCandidate)) {
    throw quarantineError(
      'IDENTITY_VIOLATION',
      'iotPrincipal',
      'certificate is neither ACTIVE nor an approved onboarding certificate',
    );
  }
  return {
    deviceId: device.id,
    customerId: device.customerId,
    siteId: device.siteId,
    lifecycleStatus: device.lifecycleStatus,
    certificateId: certificate.id,
    certificateFingerprint: certificate.fingerprint,
  };
}
