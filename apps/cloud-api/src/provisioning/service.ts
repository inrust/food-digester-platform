/**
 * BE-ONB-03 证书签发 Provisioning Service（由持久化 Provisioning Job Worker 调用）。
 *
 * 签发链（approve 提交后触发）：
 * 1. 库存设备定位（deviceId = 库存行 id，不重复创建业务 Device）；
 * 2. 幂等短路：已有带证书包的 PENDING_CLAIM 证书记录 → 直接返回（重试安全）；
 * 3. IoT：ensureThing → 项目 CA 签发并注册 → AUTH-04 最小权限 Policy → 附加 Policy/Thing；
 * 4. DB：device_certificates 落库（公钥证书可保存，私钥绝不落库）；
 * 5. SEC-01：仅含公钥证书的领取包短期存储（一次性领取）。
 *
 * 部分失败重试语义（技术对接要求）：
 * - Thing/Policy 按名幂等，attach 幂等；
 * - 项目 CA 证书注册成功但后续失败：重试产生新证书，旧 PENDING_CLAIM 记录
 *   （无证书包可用）按 DEC-003 丢失处置标记 REVOKED，业务 Device 不重复创建；
 * - 内部 Provisioning 进度不暴露为外部状态（Status API 只映射 PENDING/REJECTED/APPROVED）。
 */
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';
import { buildDevicePolicy } from '@fdp/aws-clients';
import type { DataKeyProvider } from '@fdp/aws-clients';
import { CERTIFICATE_PACKAGE_RETENTION_SECONDS, certificateFingerprintFromPem, SecurePackageService } from '@fdp/auth';
import { onboardingDeadlineFrom } from '@fdp/contracts/lifecycle/onboarding-timeout-policy.js';
import type { AdminOnboardingRequestRecord } from '../admin/onboarding/index.js';
import type { IotProvisioningPort } from './iot-port.js';
import { createHash, X509Certificate } from 'node:crypto';
import { inspectCsr } from '../onboarding/csr-proof.js';

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

export interface ProvisioningAttemptContext {
  readonly operationId: string;
  readonly priorIssuedCertificateId?: string | null;
  readonly onCertificateIssued?: (certificateId: string | null) => Promise<void>;
}

/** 证书包明文负载（仅内存形态；落库前由 SEC-01 信封加密）。 */
export interface CertificatePackagePayload {
  readonly certificatePem: string;
}

interface DeviceRow {
  readonly id: string;
  readonly serialNumber: string;
  readonly lifecycleStatus: string;
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
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface CertificateDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<CertificateRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface OnboardingRequestDelegate {
  findFirst(args: { where: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'> }): Promise<{
    id: string;
    serialNumber: string;
    status: string;
    onboardingDeadlineAt: Date | null;
    revocationCompletedAt: Date | null;
  } | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface ProvisioningJobDelegate {
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface StateHistoryDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

interface RecoveryCertificateDelegate {
  findFirst(args: { where: Record<string, unknown>; select: Record<string, unknown> }): Promise<{
    id: string;
    deviceId: string;
    status: string;
    rotatedFromId: string | null;
    device: { serialNumber: string };
  } | null>;
}

export class ProvisioningError extends Error {
  override readonly name = 'ProvisioningError';
}

export class ProvisioningService {
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

  /** DEC-003 响应不确定恢复：云端撤证、销毁未确认包并重签。 */
  async recoverUnconfirmedDelivery(
    request: Pick<AdminOnboardingRequestRecord, 'id' | 'serialNumber'> & { readonly csrPem?: string | null },
    certificateId: string,
  ): Promise<ProvisioningResult> {
    await this.deps.iot.revokeCertificate(certificateId);
    const revoked = await this.securePackage.revokeUnconfirmedDelivery(certificateId);
    if (!revoked) throw new ProvisioningError('未确认交付状态已变化，请重试');
    return this.provision(request);
  }

  /** Status 在截止边界主动收敛本地状态；AWS 撤证失败由 deadline evaluator 按持久化状态重试。 */
  async convergeOnboardingTimeout(requestId: string, at: Date): Promise<boolean> {
    const certificateId = await withTransaction(this.db, async (tx) => {
      const requests = (tx as unknown as Record<string, unknown>).onboardingRequest as OnboardingRequestDelegate;
      const raw = tx as unknown as { $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> };
      await raw.$queryRawUnsafe(
        `SELECT id FROM onboarding_requests WHERE id = $1 AND status = 'APPROVED' FOR UPDATE`,
        requestId,
      );
      const request = await requests.findFirst({ where: { id: requestId } });
      if (!request || request.status !== 'APPROVED' || !request.onboardingDeadlineAt) return null;
      if (request.onboardingDeadlineAt.getTime() > at.getTime()) return null;
      const txDevices = (tx as unknown as Record<string, unknown>).device as DeviceDelegate;
      const device = await txDevices.findFirst({ where: { serialNumber: request.serialNumber } });
      if (!device || device.lifecycleStatus !== 'OnboardingApproved') return null;
      const txCertificates = (tx as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;
      const certificate = await txCertificates.findFirst({
        where: { deviceId: device.id, status: 'PENDING_CLAIM' },
      });
      if (!certificate) return null;

      const requestUpdated = await requests.updateMany({
        where: { id: request.id, status: 'APPROVED', onboardingDeadlineAt: { lte: at }, timedOutAt: null },
        data: { status: 'TIMED_OUT', rejectReason: 'ONBOARDING_TIMEOUT', timedOutAt: at, version: { increment: 1 } },
      });
      const deviceUpdated = await txDevices.updateMany({
        where: { id: device.id, lifecycleStatus: 'OnboardingApproved' },
        data: { lifecycleStatus: 'PendingOnboarding' },
      });
      const certificateUpdated = await txCertificates.updateMany({
        where: { id: certificate.id, status: 'PENDING_CLAIM' },
        data: { status: 'REVOKED' },
      });
      if (requestUpdated.count !== 1 || deviceUpdated.count !== 1 || certificateUpdated.count !== 1) {
        throw new ProvisioningError('Onboarding 超时状态并发变化，请重试');
      }
      await this.securePackage.destroyPackage(certificate.id, tx);
      const history = (tx as unknown as Record<string, unknown>).deviceStateHistory as StateHistoryDelegate;
      await history.create({
        data: {
          deviceId: device.id,
          axis: 'lifecycle',
          fromStatus: 'OnboardingApproved',
          toStatus: 'PendingOnboarding',
          actorType: 'SYSTEM',
          actorId: 'system:onboarding-status-timeout',
          reason: 'ONBOARDING_TIMEOUT',
        },
      });
      await recordAudit(tx, {
        objectType: 'onboarding_request',
        objectId: request.id,
        action: 'onboarding.timeout',
        result: 'SUCCESS',
        reason: 'ONBOARDING_TIMEOUT',
        afterValue: { deviceId: device.id, certificateId: certificate.id, detectedBy: 'status' },
      });
      return certificate.id;
    });
    if (!certificateId) return false;

    try {
      await this.deps.iot.revokeCertificate(certificateId);
      await withTransaction(this.db, async (tx) => {
        const requests = (tx as unknown as Record<string, unknown>).onboardingRequest as OnboardingRequestDelegate;
        const txCertificates = (tx as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;
        await requests.updateMany({
          where: { id: requestId, status: 'TIMED_OUT', revocationCompletedAt: null },
          data: { revocationCompletedAt: at },
        });
        await txCertificates.updateMany({
          where: { id: certificateId, status: 'REVOKED', revokedAt: null },
          data: { revokedAt: at },
        });
        await recordAudit(tx, {
          objectType: 'deviceCertificate',
          objectId: certificateId,
          action: 'onboarding.timeout.certificate_revoke',
          result: 'SUCCESS',
          reason: 'ONBOARDING_TIMEOUT',
        });
      });
    } catch (error) {
      await recordAudit(this.db, {
        objectType: 'deviceCertificate',
        objectId: certificateId,
        action: 'onboarding.timeout.certificate_revoke',
        result: 'FAILURE',
        reason: error instanceof Error ? error.name : 'UNKNOWN',
      });
    }
    return true;
  }

  /**
   * DEC-003 + DEC-017：持久化恢复意图后再撤证；AWS 失败保留密文并进入 RECOVERY_FAILED。
   * 只有云端撤证成功后才在事务中清空密文并标记 RECOVERY_COMPLETED。
   */
  async recoverExpiredPackage(
    request: Pick<AdminOnboardingRequestRecord, 'id' | 'serialNumber'>,
    certificateId: string,
  ): Promise<ProvisioningResult> {
    const certificates = (this.db as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;
    const current = this.now();
    const staleLeaseBefore = new Date(current.getTime() - 5 * 60 * 1000);
    await certificates.updateMany({
      where: {
        id: certificateId,
        status: 'PENDING_CLAIM',
        packageCiphertext: { not: null },
        OR: [
          { recoveryState: null },
          { recoveryState: 'RECOVERY_FAILED' },
          { recoveryState: 'RECOVERY_IN_PROGRESS', recoveryLastAttemptAt: { lt: staleLeaseBefore } },
        ],
      },
      data: {
        recoveryState: 'RECOVERY_REQUIRED',
        recoveryRequestedAt: current,
        recoveryLastError: null,
      },
    });

    const claimed = await certificates.updateMany({
      where: { id: certificateId, status: 'PENDING_CLAIM', recoveryState: 'RECOVERY_REQUIRED' },
      data: {
        recoveryState: 'RECOVERY_IN_PROGRESS',
        recoveryAttempts: { increment: 1 },
        recoveryLastAttemptAt: current,
      },
    });
    if (claimed.count !== 1) throw new ProvisioningError('过期证书恢复正在处理或状态已变化');

    try {
      await this.deps.iot.revokeCertificate(certificateId);
    } catch (error) {
      await certificates.updateMany({
        where: { id: certificateId, status: 'PENDING_CLAIM', recoveryState: 'RECOVERY_IN_PROGRESS' },
        data: {
          recoveryState: 'RECOVERY_FAILED',
          recoveryLastError: error instanceof Error ? error.name : 'IOT_REVOKE_FAILED',
        },
      });
      throw error;
    }

    const count = await withTransaction(this.db, async (tx) => {
      const txCertificates = (tx as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;
      const updated = await txCertificates.updateMany({
        where: { id: certificateId, status: 'PENDING_CLAIM', recoveryState: 'RECOVERY_IN_PROGRESS' },
        data: {
          status: 'REVOKED',
          revokedAt: this.now(),
          packageCiphertext: null,
          packageKmsKeyId: null,
          packageExpiresAt: null,
          recoveryState: 'RECOVERY_COMPLETED',
          recoveryLastError: null,
        },
      });
      if (updated.count === 1) {
        await recordAudit(tx, {
          objectType: 'deviceCertificate',
          objectId: certificateId,
          action: 'CERT_PACKAGE_EXPIRED_RECOVERY',
          result: 'SUCCESS',
          afterValue: { requestId: request.id, recoveryState: 'RECOVERY_COMPLETED' },
        });
      }
      return updated.count;
    });
    if (count !== 1) throw new ProvisioningError('过期证书状态已变化，请重试');
    return this.provision(request);
  }

  /** EventBridge 组合根入口：只凭过期证书 ID 反查已批准申请并进入同一恢复状态机。 */
  async recoverExpiredCertificate(certificateId: string): Promise<void> {
    const certificates = (this.db as unknown as Record<string, unknown>)
      .deviceCertificate as RecoveryCertificateDelegate;
    const requests = (this.db as unknown as Record<string, unknown>).onboardingRequest as OnboardingRequestDelegate;
    const certificate = await certificates.findFirst({
      where: { id: certificateId, packageCiphertext: { not: null }, packageExpiresAt: { lte: this.now() } },
      select: {
        id: true,
        deviceId: true,
        status: true,
        rotatedFromId: true,
        device: { select: { serialNumber: true } },
      },
    });
    if (!certificate) throw new ProvisioningError('过期证书包不存在或状态已变化');
    if (certificate.status === 'ACTIVE' && certificate.rotatedFromId) {
      await this.recoverExpiredRotationPackage(certificate);
      return;
    }
    if (certificate.status !== 'PENDING_CLAIM' || certificate.rotatedFromId) {
      throw new ProvisioningError('过期证书包状态不支持自动恢复');
    }
    const request = await requests.findFirst({
      where: { serialNumber: certificate.device.serialNumber, status: 'APPROVED' },
      orderBy: { reviewedAt: 'desc' },
    });
    if (!request) throw new ProvisioningError('找不到过期证书对应的已批准 Onboarding 申请');
    await this.recoverExpiredPackage(request, certificateId);
  }

  /**
   * BE-CERT-02 轮换包过期：先持久化恢复租约，再撤销未确认的新证书，最后事务清包。
   * 被轮换的旧证书仍为 ACTIVE；设备下一次使用旧证重试 rotate 时会走既有签发链产生替代证书。
   */
  private async recoverExpiredRotationPackage(certificate: {
    id: string;
    deviceId: string;
    rotatedFromId: string | null;
  }): Promise<void> {
    const certificates = (this.db as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;
    const current = this.now();
    const staleLeaseBefore = new Date(current.getTime() - 5 * 60 * 1000);
    await certificates.updateMany({
      where: {
        id: certificate.id,
        status: 'ACTIVE',
        rotatedFromId: certificate.rotatedFromId,
        packageCiphertext: { not: null },
        OR: [
          { recoveryState: null },
          { recoveryState: 'RECOVERY_FAILED' },
          { recoveryState: 'RECOVERY_IN_PROGRESS', recoveryLastAttemptAt: { lt: staleLeaseBefore } },
        ],
      },
      data: {
        recoveryState: 'RECOVERY_REQUIRED',
        recoveryRequestedAt: current,
        recoveryLastError: null,
      },
    });
    const claimed = await certificates.updateMany({
      where: { id: certificate.id, status: 'ACTIVE', recoveryState: 'RECOVERY_REQUIRED' },
      data: {
        recoveryState: 'RECOVERY_IN_PROGRESS',
        recoveryAttempts: { increment: 1 },
        recoveryLastAttemptAt: current,
      },
    });
    if (claimed.count !== 1) throw new ProvisioningError('过期轮换证书恢复正在处理或状态已变化');

    try {
      await this.deps.iot.revokeCertificate(certificate.id);
    } catch (error) {
      await certificates.updateMany({
        where: { id: certificate.id, status: 'ACTIVE', recoveryState: 'RECOVERY_IN_PROGRESS' },
        data: {
          recoveryState: 'RECOVERY_FAILED',
          recoveryLastError: error instanceof Error ? error.name : 'IOT_REVOKE_FAILED',
        },
      });
      throw error;
    }

    const count = await withTransaction(this.db, async (tx) => {
      const txCertificates = (tx as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;
      const updated = await txCertificates.updateMany({
        where: { id: certificate.id, status: 'ACTIVE', recoveryState: 'RECOVERY_IN_PROGRESS' },
        data: {
          status: 'REVOKED',
          revokedAt: this.now(),
          packageCiphertext: null,
          packageKmsKeyId: null,
          packageExpiresAt: null,
          recoveryState: 'RECOVERY_COMPLETED',
          recoveryLastError: null,
        },
      });
      if (updated.count === 1) {
        await recordAudit(tx, {
          objectType: 'deviceCertificate',
          objectId: certificate.id,
          action: 'CERT_ROTATION_PACKAGE_EXPIRED_RECOVERY',
          result: 'SUCCESS',
          beforeValue: { rotatedFromId: certificate.rotatedFromId },
          afterValue: { deviceId: certificate.deviceId, recoveryState: 'RECOVERY_COMPLETED' },
        });
      }
      return updated.count;
    });
    if (count !== 1) throw new ProvisioningError('过期轮换证书状态已变化，请重试');
  }

  async provision(
    request: Pick<AdminOnboardingRequestRecord, 'id' | 'serialNumber'> & { readonly csrPem?: string | null },
    attempt?: ProvisioningAttemptContext,
  ): Promise<ProvisioningResult> {
    const devices = (this.db as unknown as Record<string, unknown>).device as DeviceDelegate;
    const certificates = (this.db as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;
    if (!request.csrPem) throw new ProvisioningError('申请缺少 CSR，禁止签发设备证书');

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
      await this.deps.iot.revokeCertificate(existing.id);
      await certificates.updateMany({
        where: { id: existing.id, status: 'PENDING_CLAIM' },
        data: { status: 'REVOKED', revokedAt: this.now() },
      });
      await attempt?.onCertificateIssued?.(null);
    } else if (attempt?.priorIssuedCertificateId) {
      // 上次进程在 AWS 发证后、业务证书落库前崩溃：凭持久化 attempt 凭证立即撤销孤儿证书。
      await this.deps.iot.revokeCertificate(attempt.priorIssuedCertificateId);
      await attempt.onCertificateIssued?.(null);
    }

    await this.deps.iot.ensureThing(device.id);
    const cert = await this.deps.iot.createKeysAndCertificate(request.csrPem);
    const now = this.now();
    try {
      await attempt?.onCertificateIssued?.(cert.certificateId);
      if (cert.privateKey) throw new ProvisioningError('CSR 签发不得返回设备私钥');
      const expected = inspectCsr(request.csrPem).fingerprint;
      const actual = createHash('sha256')
        .update(new X509Certificate(cert.certificatePem).publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex');
      if (actual !== expected) throw new ProvisioningError('签发证书公钥与申请 CSR 不匹配');
      const policy = buildDevicePolicy({
        region: this.deps.config.region,
        accountId: this.deps.config.accountId,
        thingName: device.id,
        ...(this.deps.config.policyNamePrefix ? { policyNamePrefix: this.deps.config.policyNamePrefix } : {}),
      });
      const notAfter = new Date(now.getTime() + this.deps.config.certificateValiditySeconds * 1000);
      await certificates.create({
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
      await this.deps.iot.ensurePolicy(policy.policyName, policy.policyDocument);
      await this.deps.iot.attachPolicy(policy.policyName, cert.certificateArn);
      await this.deps.iot.attachThingPrincipal(device.id, cert.certificateArn);

      const payload: CertificatePackagePayload = { certificatePem: cert.certificatePem };
      const { expiresAt } = await this.securePackage.storePackage(
        cert.certificateId,
        Buffer.from(JSON.stringify(payload), 'utf8'),
      );
      await this.setOnboardingDeadline(request.id, this.deadlineFromPackageExpiry(expiresAt));
      await recordAudit(this.db, {
        objectType: 'device',
        objectId: device.id,
        action: 'onboarding.provision',
        result: 'SUCCESS',
        afterValue: {
          certificateId: cert.certificateId,
          policyName: policy.policyName,
          requestId: request.id,
          operationId: attempt?.operationId ?? request.id,
        },
      });
      return { deviceId: device.id, certificateId: cert.certificateId, replayed: false };
    } catch (error) {
      let compensation = 'REVOKED';
      try {
        await this.deps.iot.revokeCertificate(cert.certificateId);
        await this.securePackage.destroyPackage(cert.certificateId);
        await certificates.updateMany({
          where: { id: cert.certificateId, status: 'PENDING_CLAIM' },
          data: { status: 'REVOKED', revokedAt: this.now() },
        });
        await attempt?.onCertificateIssued?.(null);
      } catch {
        compensation = 'REVOKE_PENDING';
      }
      await recordAudit(this.db, {
        objectType: 'device',
        objectId: device.id,
        action: 'onboarding.provision',
        result: 'FAILURE',
        reason: error instanceof Error ? error.name : 'UNKNOWN',
        afterValue: {
          certificateId: cert.certificateId,
          requestId: request.id,
          operationId: attempt?.operationId ?? request.id,
          compensation,
        },
      });
      // Status 恢复路径可能在 Worker 已完成后再次触发签发。若此时失败，重新打开持久化 Job，
      // 避免仅依赖下一次设备轮询而永久遗留无证书包/未撤销证书。
      const provisioningJobs = (this.db as unknown as Record<string, unknown>).onboardingProvisioningJob as
        ProvisioningJobDelegate | undefined;
      await provisioningJobs?.updateMany({
        where: { requestId: request.id, status: 'COMPLETED' },
        data: {
          status: 'RETRY',
          issuedCertificateId: compensation === 'REVOKE_PENDING' ? cert.certificateId : null,
          lastError: error instanceof Error ? error.name : 'UNKNOWN',
          nextAttemptAt: this.now(),
          completedAt: null,
        },
      });
      throw error;
    }
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
  const parsed = JSON.parse(Buffer.from(payload).toString('utf8')) as Record<string, unknown>;
  if (typeof parsed.certificatePem !== 'string' || parsed.privateKey !== undefined) {
    throw new ProvisioningError('证书包负载结构非法');
  }
  return { certificatePem: parsed.certificatePem };
}
