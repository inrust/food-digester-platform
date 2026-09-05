/**
 * BE-ONB-03 证书签发 Provisioning Service（实现 BE-ONB-02 的 ProvisioningTrigger 端口）。
 *
 * 签发链（approve 提交后触发）：
 * 1. 库存设备定位（deviceId = 库存行 id，不重复创建业务 Device）；
 * 2. 幂等短路：已有带证书包的 PENDING_CLAIM 证书记录 → 直接返回（重试安全）；
 * 3. IoT：ensureThing → CreateKeysAndCertificate → AUTH-04 最小权限 Policy → 附加 Policy/Thing；
 * 4. DB：device_certificates 落库（公钥证书可保存，私钥绝不落库）；
 * 5. SEC-01：证书包（certificatePem + privateKey）立即信封加密短期存储（一次性领取）。
 *
 * 部分失败重试语义（技术对接要求）：
 * - Thing/Policy 按名幂等，attach 幂等；
 * - CreateKeysAndCertificate 成功但后续失败：重试产生新证书，旧 PENDING_CLAIM 记录
 *   （无私钥包可用）按 DEC-003 丢失处置标记 REVOKED，业务 Device 不重复创建；
 * - 内部 Provisioning 进度不暴露为外部状态（Status API 只映射 PENDING/REJECTED/APPROVED）。
 */
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';
import { buildDevicePolicy } from '@fdp/aws-clients';
import type { DataKeyProvider } from '@fdp/aws-clients';
import { CERTIFICATE_PACKAGE_RETENTION_SECONDS, certificateFingerprintFromPem, SecurePackageService } from '@fdp/auth';
import { onboardingDeadlineFrom } from '@fdp/contracts/lifecycle/onboarding-timeout-policy.js';
import type { AdminOnboardingRequestRecord, ProvisioningTrigger } from '../admin/onboarding/index.js';
import type { IotProvisioningPort } from './iot-port.js';

export interface ProvisioningConfig {
  readonly region: string;
  readonly accountId: string;
  /** 证书有效期（秒），用于 notBefore/notAfter 登记。 */
  readonly certificateValiditySeconds: number;
  readonly policyNamePrefix?: string;
}

export interface ProvisioningServiceDeps {
  readonly client: DbClient;
  readonly iot: IotProvisioningPort;
  readonly keyProvider: DataKeyProvider;
  readonly config: ProvisioningConfig;
  readonly now?: () => Date;
}

export interface ProvisioningResult {
  readonly deviceId: string;
  readonly certificateId: string;
  /** true 表示重试短路（已有可用证书包，未重复调用 AWS 发证）。 */
  readonly replayed: boolean;
}

/** 证书包明文负载（仅内存形态；落库前由 SEC-01 信封加密）。 */
export interface CertificatePackagePayload {
  readonly certificatePem: string;
  readonly privateKey: string;
}

interface DeviceRow {
  readonly id: string;
  readonly serialNumber: string;
}

interface CertificateRow {
  readonly id: string;
  readonly deviceId: string;
  readonly status: string;
  readonly packageCiphertext: Uint8Array | null;
  readonly packageExpiresAt: Date | null;
}

interface DeviceDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
}

interface CertificateDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<CertificateRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface OnboardingRequestDelegate {
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

export class ProvisioningError extends Error {
  override readonly name = 'ProvisioningError';
}

export class ProvisioningService implements ProvisioningTrigger {
  private readonly db: DbClient;
  private readonly now: () => Date;
  private readonly securePackage: SecurePackageService;

  constructor(private readonly deps: ProvisioningServiceDeps) {
    this.db = deps.client;
    this.now = deps.now ?? (() => new Date());
    this.securePackage = new SecurePackageService({
      db: deps.client,
      keyProvider: deps.keyProvider,
      config: { retentionSeconds: CERTIFICATE_PACKAGE_RETENTION_SECONDS, maxClaims: 1, now: this.now },
    });
  }

  /** BE-ONB-02 approve 后触发点。 */
  async triggerApproved(request: AdminOnboardingRequestRecord): Promise<void> {
    await this.provision(request);
  }

  /** DEC-003 响应不确定恢复：云端撤证、销毁未确认包并重签。 */
  async recoverUnconfirmedDelivery(
    request: Pick<AdminOnboardingRequestRecord, 'id' | 'serialNumber'>,
    certificateId: string,
  ): Promise<ProvisioningResult> {
    await this.deps.iot.revokeCertificate(certificateId);
    const revoked = await this.securePackage.revokeUnconfirmedDelivery(certificateId);
    if (!revoked) throw new ProvisioningError('未确认交付状态已变化，请重试');
    return this.provision(request);
  }

  /** DEC-003 + DEC-017：截止前未领取包过期，撤销旧证书并重签；截止后由评估器终止。 */
  async recoverExpiredPackage(
    request: Pick<AdminOnboardingRequestRecord, 'id' | 'serialNumber'>,
    certificateId: string,
  ): Promise<ProvisioningResult> {
    await this.deps.iot.revokeCertificate(certificateId);
    const certificates = (this.db as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;
    const { count } = await certificates.updateMany({
      where: { id: certificateId, status: 'PENDING_CLAIM' },
      data: {
        status: 'REVOKED',
        revokedAt: this.now(),
        packageCiphertext: null,
        packageKmsKeyId: null,
        packageExpiresAt: null,
      },
    });
    if (count !== 1) throw new ProvisioningError('过期证书状态已变化，请重试');
    return this.provision(request);
  }

  async provision(request: Pick<AdminOnboardingRequestRecord, 'id' | 'serialNumber'>): Promise<ProvisioningResult> {
    const devices = (this.db as unknown as Record<string, unknown>).device as DeviceDelegate;
    const certificates = (this.db as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;

    const device = await devices.findFirst({ where: { serialNumber: request.serialNumber } });
    if (!device) throw new ProvisioningError(`设备库存不存在: ${request.serialNumber}`);

    // 幂等短路：已有可用证书包 → 重试直接返回，不重复调用 AWS
    const existing = await certificates.findFirst({
      where: { deviceId: device.id, status: 'PENDING_CLAIM' },
    });
    if (existing?.packageCiphertext) {
      if (!existing.packageExpiresAt) throw new ProvisioningError('证书包缺少过期时间，不能设置 Onboarding 截止时间');
      await this.setOnboardingDeadline(request.id, this.deadlineFromPackageExpiry(existing.packageExpiresAt));
      return { deviceId: device.id, certificateId: existing.id, replayed: true };
    }

    // DEC-003 丢失处置：前次签发在封包前失败（私钥材料已不可恢复）→ 旧记录标记 REVOKED 后重签
    if (existing && !existing.packageCiphertext) {
      await certificates.updateMany({
        where: { id: existing.id, status: 'PENDING_CLAIM' },
        data: { status: 'REVOKED', revokedAt: this.now() },
      });
    }

    await this.deps.iot.ensureThing(device.id);
    const cert = await this.deps.iot.createKeysAndCertificate();
    const policy = buildDevicePolicy({
      region: this.deps.config.region,
      accountId: this.deps.config.accountId,
      thingName: device.id,
      ...(this.deps.config.policyNamePrefix ? { policyNamePrefix: this.deps.config.policyNamePrefix } : {}),
    });
    await this.deps.iot.ensurePolicy(policy.policyName, policy.policyDocument);
    await this.deps.iot.attachPolicy(policy.policyName, cert.certificateArn);
    await this.deps.iot.attachThingPrincipal(device.id, cert.certificateArn);

    const now = this.now();
    const notAfter = new Date(now.getTime() + this.deps.config.certificateValiditySeconds * 1000);
    await withTransaction(this.db, async (tx) => {
      const txCertificates = (tx as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;
      await txCertificates.create({
        data: {
          id: cert.certificateId,
          deviceId: device.id,
          fingerprint: certificateFingerprintFromPem(cert.certificatePem),
          status: 'PENDING_CLAIM',
          certificatePem: cert.certificatePem,
          notBefore: now,
          notAfter,
        },
      });
      await recordAudit(tx, {
        objectType: 'device',
        objectId: device.id,
        action: 'onboarding.provision',
        result: 'SUCCESS',
        afterValue: { certificateId: cert.certificateId, policyName: policy.policyName, requestId: request.id },
      });
    });

    // AWS 返回私钥后立即信封加密存储（明文仅内存经过；SEC-01 自记 CERT_PACKAGE_STORE 审计）
    const payload: CertificatePackagePayload = { certificatePem: cert.certificatePem, privateKey: cert.privateKey };
    const { expiresAt } = await this.securePackage.storePackage(
      cert.certificateId,
      Buffer.from(JSON.stringify(payload), 'utf8'),
    );
    await this.setOnboardingDeadline(request.id, this.deadlineFromPackageExpiry(expiresAt));
    return { deviceId: device.id, certificateId: cert.certificateId, replayed: false };
  }

  private deadlineFromPackageExpiry(packageExpiresAt: Date): Date {
    const packageStoredAt = new Date(packageExpiresAt.getTime() - CERTIFICATE_PACKAGE_RETENTION_SECONDS * 1000);
    return onboardingDeadlineFrom(packageStoredAt);
  }

  private async setOnboardingDeadline(requestId: string, deadlineAt: Date): Promise<void> {
    const requests = (this.db as unknown as Record<string, unknown>).onboardingRequest as OnboardingRequestDelegate;
    const { count } = await requests.updateMany({
      where: { id: requestId, status: 'APPROVED', timedOutAt: null },
      data: { onboardingDeadlineAt: deadlineAt },
    });
    if (count !== 1) throw new ProvisioningError('Onboarding 申请状态已变化，不能设置首个 Heartbeat 截止时间');
  }
}

/** 解析证书包明文负载（Status API 领取后使用）。 */
export function parseCertificatePackage(payload: Uint8Array): CertificatePackagePayload {
  const parsed = JSON.parse(Buffer.from(payload).toString('utf8')) as Partial<CertificatePackagePayload>;
  if (typeof parsed.certificatePem !== 'string' || typeof parsed.privateKey !== 'string') {
    throw new ProvisioningError('证书包负载结构非法');
  }
  return { certificatePem: parsed.certificatePem, privateKey: parsed.privateKey };
}
