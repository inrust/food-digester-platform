/**
 * BE-CERT-02 证书轮换 Service（业务核心，框架无关）。
 *
 * 轮换链（POST /api/v1/device/certificate/rotate，mTLS 认证后调用）：
 * 1. 资格：currentCertificateId 必须等于当前 mTLS 身份证书（错误/跨设备 → 403）；
 *    旧证书 ACTIVE 且属于设备由 AUTH-03 认证链保证（撤销/过期 → 401 先行）；
 * 2. 重试恢复：已封包但未预留则继续交付；已预留但响应未确认则撤销新证书并重签；
 *    响应已经成功提交但尚无新证 Heartbeat 时稳定返回冲突，绝不撤销已交付证书或重签；
 * 3. 发证：项目 CA 签发并注册 AWS IoT → AUTH-04 单设备 Policy（按名幂等）→ attach；
 * 4. 双证书窗口：新证书 ACTIVE + rotatedFromId=旧证书（旧证书保持 ACTIVE 可用），
 *    证书包 SEC-01 信封加密短期保存；写 ROTATION_START 审计；
 * 5. 响应一次性返回证书包明文（私钥仅内存经过，绝不落库/日志/审计）。
 *
 * 封包前失败的重试：按 DEC-003 丢失处置，遗留记录 REVOKED 后重签（有界替换，非无限）。
 * 确认：新证书首个合法 Heartbeat 后由 confirmCertificateRotationOnFirstHeartbeat
 * 停用旧证书并销毁新证书包（DEC-003 销毁触发点 NEW_CERTIFICATE_FIRST_HEARTBEAT）。
 */
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';
import { buildDevicePolicy } from '@fdp/aws-clients';
import type { DataKeyProvider } from '@fdp/aws-clients';
import { CERTIFICATE_PACKAGE_RETENTION_SECONDS, certificateFingerprintFromPem, SecurePackageService } from '@fdp/auth';
import type { DeviceAuthContext } from '@fdp/auth';
import type { IotProvisioningPort } from '../provisioning/index.js';

export type RotationErrorCode = 'VALIDATION_FAILED' | 'FORBIDDEN' | 'CONFLICT';

export const ROTATION_ERROR_HTTP_STATUS: Readonly<Record<RotationErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  FORBIDDEN: 403,
  CONFLICT: 409,
} as const;

export class CertificateRotationError extends Error {
  override readonly name = 'CertificateRotationError';
  readonly code: RotationErrorCode;

  constructor(code: RotationErrorCode, message?: string) {
    super(message ?? 'The request failed');
    this.code = code;
  }

  get httpStatus(): number {
    return ROTATION_ERROR_HTTP_STATUS[this.code];
  }
}

export interface RotationConfig {
  readonly region: string;
  readonly accountId: string;
  readonly certificateValiditySeconds: number;
  readonly policyNamePrefix?: string;
}

export interface RotationServiceDeps {
  readonly client: DbClient;
  readonly iot: IotProvisioningPort;
  readonly keyProvider: DataKeyProvider;
  readonly config: RotationConfig;
  readonly now?: () => Date;
}

export interface RotationResult {
  readonly certificateId: string;
  readonly certificatePem: string;
  readonly privateKey: string;
  /** 新证书生效时间（UTC ISO 时间戳，双证书窗口起点）。 */
  readonly effectiveDate: string;
  /** UTC 到期日（YYYY-MM-DD）。 */
  readonly expiryDate: string;
  /** 双证书窗口记录：被轮换的旧证书。 */
  readonly rotatedFromId: string;
  /** HTTP 响应成功提交后调用，销毁唯一密文包。 */
  readonly confirmDelivery: () => Promise<void>;
}

interface CertificateRow {
  readonly id: string;
  readonly deviceId: string;
  readonly status: string;
  readonly rotatedFromId: string | null;
  readonly packageCiphertext: Uint8Array | null;
  readonly claimedAt: Date | null;
  readonly certificatePem: string | null;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

function certificates(client: DbClient) {
  return (client as unknown as Record<string, unknown>).deviceCertificate as {
    findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<CertificateRow>;
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

export async function rotateCertificate(
  deps: RotationServiceDeps,
  auth: DeviceAuthContext,
  currentCertificateId: string | undefined,
): Promise<RotationResult> {
  if (!currentCertificateId) {
    throw new CertificateRotationError('VALIDATION_FAILED', 'currentCertificateId is required');
  }
  // 仅旧证书属于当前 mTLS 身份对应设备时允许（跨设备/错误声明 → 403）
  if (currentCertificateId !== auth.certificateId) {
    throw new CertificateRotationError(
      'FORBIDDEN',
      'currentCertificateId does not match the authenticated certificate',
    );
  }

  const now = deps.now?.() ?? new Date();
  const certs = certificates(deps.client);
  const securePackage = new SecurePackageService({
    db: deps.client,
    keyProvider: deps.keyProvider,
    config: {
      retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS,
      maxClaims: 1,
      now: deps.now ?? (() => new Date()),
    },
  });

  // 重试短路：同旧证书的未确认轮换已存在
  const existing = await certs.findFirst({
    where: { deviceId: auth.deviceId, rotatedFromId: auth.certificateId, status: 'ACTIVE' },
  });
  if (existing?.packageCiphertext && existing.claimedAt === null) {
    const payload = await securePackage.preparePackageDelivery(existing.id, {
      kind: 'deviceCertificate',
      context: auth,
    });
    const parsed = parseRotationPackage(payload);
    return {
      certificateId: existing.id,
      certificatePem: parsed.certificatePem,
      privateKey: parsed.privateKey,
      effectiveDate: existing.notBefore.toISOString().slice(0, 10),
      expiryDate: existing.notAfter.toISOString().slice(0, 10),
      rotatedFromId: auth.certificateId,
      confirmDelivery: async () => {
        await securePackage.confirmPackageDelivery(existing.id);
      },
    };
  }
  if (existing?.packageCiphertext && existing.claimedAt !== null) {
    await deps.iot.revokeCertificate(existing.id);
    await securePackage.revokeUnconfirmedDelivery(existing.id);
  }
  if (existing && !existing.packageCiphertext && existing.claimedAt !== null) {
    throw new CertificateRotationError(
      'CONFLICT',
      'The replacement certificate was delivered and is awaiting its first heartbeat',
    );
  }
  if (existing && !existing.packageCiphertext && existing.claimedAt === null) {
    // 封包前失败的遗留：DEC-003 丢失处置，REVOKED 后重签（有界替换）
    await certs.updateMany({
      where: { id: existing.id, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: now },
    });
  }

  const cert = await deps.iot.createKeysAndCertificate();
  const policy = buildDevicePolicy({
    region: deps.config.region,
    accountId: deps.config.accountId,
    thingName: auth.deviceId,
    ...(deps.config.policyNamePrefix ? { policyNamePrefix: deps.config.policyNamePrefix } : {}),
  });
  await deps.iot.ensurePolicy(policy.policyName, policy.policyDocument);
  await deps.iot.attachPolicy(policy.policyName, cert.certificateArn);
  await deps.iot.attachThingPrincipal(auth.deviceId, cert.certificateArn);

  const notAfter = new Date(now.getTime() + deps.config.certificateValiditySeconds * 1000);
  await withTransaction(deps.client, async (tx) => {
    await certificates(tx).create({
      data: {
        id: cert.certificateId,
        deviceId: auth.deviceId,
        fingerprint: certificateFingerprintFromPem(cert.certificatePem),
        status: 'ACTIVE',
        certificatePem: cert.certificatePem,
        rotatedFromId: auth.certificateId,
        notBefore: now,
        notAfter,
      },
    });
    await recordAudit(tx, {
      objectType: 'deviceCertificate',
      objectId: cert.certificateId,
      action: 'CERT_ROTATION_START',
      result: 'SUCCESS',
      beforeValue: { certificateId: auth.certificateId, deviceId: auth.deviceId },
      afterValue: { certificateId: cert.certificateId, rotatedFromId: auth.certificateId },
    });
  });

  // AWS 返回私钥后立即信封加密短期保存（窗口期内供确认前重试对账；明文仅内存经过）
  await securePackage.storePackage(
    cert.certificateId,
    Buffer.from(JSON.stringify({ certificatePem: cert.certificatePem, privateKey: cert.privateKey }), 'utf8'),
  );

  const delivery = parseRotationPackage(
    await securePackage.preparePackageDelivery(cert.certificateId, {
      kind: 'deviceCertificate',
      context: auth,
    }),
  );

  return {
    certificateId: cert.certificateId,
    certificatePem: delivery.certificatePem,
    privateKey: delivery.privateKey,
    effectiveDate: now.toISOString().slice(0, 10),
    expiryDate: notAfter.toISOString().slice(0, 10),
    rotatedFromId: auth.certificateId,
    confirmDelivery: async () => {
      await securePackage.confirmPackageDelivery(cert.certificateId);
    },
  };
}

function parseRotationPackage(payload: Uint8Array): { certificatePem: string; privateKey: string } {
  const parsed = JSON.parse(Buffer.from(payload).toString('utf8')) as Record<string, unknown>;
  if (typeof parsed.certificatePem !== 'string' || typeof parsed.privateKey !== 'string') {
    throw new CertificateRotationError('CONFLICT', 'The certificate package is invalid');
  }
  return { certificatePem: parsed.certificatePem, privateKey: parsed.privateKey };
}
