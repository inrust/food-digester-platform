/**
 * SEC-01 证书包安全服务（KMS 信封加密短期存储 + 一次性领取 + 销毁）。
 *
 * 规则（DEC-003 / 技术对接要求）：
 * - AWS 返回私钥后立即加密：storePackage 入参明文只经内存，落库为信封密文；
 * - 短期保存：packageExpiresAt = now + retentionSeconds（DEC-003@1.0.0 固定为 86400 秒，
 *   由组合根注入；本服务强制 maxClaims=1）；
 * - 两阶段交付：preparePackageDelivery 预留并解密但保留密文；HTTP 适配层确认响应提交后
 *   调用 confirmPackageDelivery 销毁。预留后未确认的重试必须撤证重签；
 * - 领取资格：仅对应 Onboarding Token（序列号绑定）或旧设备证书（deviceId 绑定）；
 * - 销毁触发：领取成功自动销毁；新证书首个合法 Heartbeat 后由 BE-ONB-04 调用 destroyPackage；
 * - 审计：store/prepare/confirm/uncertain-revoke/destroy 写 audit_logs；
 *   所有审计负载只含指纹/ID，绝不含明文（DOM-03 脱敏器兜底）。
 *
 * 功能边界：不实现证书业务流程（发证/轮换编排归 BE-ONB-03/04、BE-CERT-02）。
 */
import { recordAudit, withTransaction } from '@fdp/database';
import type { DbClient } from '@fdp/database';
import type { DataKeyProvider } from '@fdp/aws-clients';
import { getMaxClaims, getRetentionSeconds } from '@fdp/contracts/security/certificate-package-policy.js';
import type { DeviceAuthContext } from '../device/verifier.js';
import type { OnboardingAuthContext } from '../onboarding/verifier.js';
import { extractEncryptedKey, packEnvelope, unpackEnvelope } from './envelope.js';
import { SecurePackageError } from './errors.js';

/** 领取资格证明：调用方必须先完成 AUTH-02/AUTH-03 认证。 */
export type ClaimProof =
  | { readonly kind: 'onboardingToken'; readonly context: OnboardingAuthContext }
  | { readonly kind: 'deviceCertificate'; readonly context: DeviceAuthContext };

export interface SecurePackageServiceConfig {
  /** 证书包保存时长（秒）；必须严格等于 DEC-003 冻结值。 */
  readonly retentionSeconds: number;
  /** 领取次数上限；DEC-003@1.0.0 固定为 1。 */
  readonly maxClaims: number;
  /** 注入时钟（测试用）。 */
  readonly now?: () => Date;
}

interface CertificateRow {
  readonly id: string;
  readonly deviceId: string;
  readonly packageCiphertext: Uint8Array | null;
  readonly packageKmsKeyId: string | null;
  readonly packageExpiresAt: Date | null;
  readonly claimedAt: Date | null;
}

interface DeviceRow {
  readonly id: string;
  readonly serialNumber: string;
}

interface CertificateDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<CertificateRow | null>;
  findMany(args: {
    where: Record<string, unknown>;
    select: { id: true };
    orderBy: { packageExpiresAt: 'asc' };
    take: number;
  }): Promise<readonly Pick<CertificateRow, 'id'>[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface DeviceDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
}

const AUDIT_OBJECT_TYPE = 'deviceCertificate';
export const CERTIFICATE_PACKAGE_RETENTION_SECONDS = getRetentionSeconds();
export const CERTIFICATE_PACKAGE_MAX_CLAIMS = getMaxClaims();

export class SecurePackageService {
  private readonly db: DbClient;
  private readonly keyProvider: DataKeyProvider;
  private readonly retentionSeconds: number;
  private readonly now: () => Date;

  constructor(deps: { db: DbClient; keyProvider: DataKeyProvider; config: SecurePackageServiceConfig }) {
    const { config } = deps;
    if (config.retentionSeconds !== CERTIFICATE_PACKAGE_RETENTION_SECONDS) {
      throw new SecurePackageError(
        'CONFLICT',
        `retentionSeconds must equal DEC-003 frozen value ${CERTIFICATE_PACKAGE_RETENTION_SECONDS}`,
      );
    }
    // DEC-003@1.0.0：只支持一次性交付
    if (config.maxClaims !== CERTIFICATE_PACKAGE_MAX_CLAIMS) {
      throw new SecurePackageError(
        'CONFLICT',
        `maxClaims must be ${CERTIFICATE_PACKAGE_MAX_CLAIMS} under DEC-003@1.0.0`,
      );
    }
    this.db = deps.db;
    this.keyProvider = deps.keyProvider;
    this.retentionSeconds = config.retentionSeconds;
    this.now = config.now ?? (() => new Date());
  }

  private certificates(client: DbClient): CertificateDelegate {
    return (client as unknown as Record<string, unknown>).deviceCertificate as CertificateDelegate;
  }

  private devices(client: DbClient): DeviceDelegate {
    return (client as unknown as Record<string, unknown>).device as DeviceDelegate;
  }

  /**
   * 发证后立即存储：AWS 返回私钥/证书包明文 → 信封加密 → 落库。
   * 明文仅在内存中经过本方法；返回过期时间。
   */
  async storePackage(certificateId: string, packagePayload: Uint8Array): Promise<{ expiresAt: Date }> {
    const certificate = await this.certificates(this.db).findFirst({ where: { id: certificateId } });
    if (!certificate) throw new SecurePackageError('NOT_FOUND', 'certificate not found');

    const { plaintextKey, encryptedKey } = await this.keyProvider.generateDataKey();
    const packed = packEnvelope(plaintextKey, encryptedKey, packagePayload);
    const expiresAt = new Date(this.now().getTime() + this.retentionSeconds * 1000);

    const { count } = await this.certificates(this.db).updateMany({
      where: { id: certificateId },
      data: {
        packageCiphertext: packed,
        packageKmsKeyId: this.keyProvider.keyId,
        packageExpiresAt: expiresAt,
        claimedAt: null,
      },
    });
    if (count !== 1) throw new SecurePackageError('NOT_FOUND', 'certificate not found');

    await recordAudit(this.db, {
      objectType: AUDIT_OBJECT_TYPE,
      objectId: certificateId,
      action: 'CERT_PACKAGE_STORE',
      result: 'SUCCESS',
      afterValue: { packageKmsKeyId: this.keyProvider.keyId, packageExpiresAt: expiresAt.toISOString() },
    });
    return { expiresAt };
  }

  /**
   * 第一阶段：校验资格 → 单次交付预留锁 → 解密 → 保留密文 → 返回明文。
   * 调用方必须在 HTTP 响应提交后调用 confirmPackageDelivery；响应不确定时不得再次解密。
   */
  async preparePackageDelivery(certificateId: string, proof: ClaimProof): Promise<Uint8Array> {
    try {
      // 预检（只读）：资格与过期；过期包销毁必须在事务外（事务内销毁会随异常回滚）
      const preview = await this.certificates(this.db).findFirst({ where: { id: certificateId } });
      if (!preview) throw new SecurePackageError('NOT_FOUND', 'certificate not found');
      await this.assertClaimEligibility(this.db, preview, proof);
      if (
        preview.packageCiphertext &&
        preview.packageExpiresAt &&
        preview.packageExpiresAt.getTime() <= this.now().getTime()
      ) {
        await this.destroyPackage(certificateId);
        throw new SecurePackageError('CONFLICT', 'certificate package expired');
      }

      return await withTransaction(this.db, async (tx) => {
        const certificate = await this.certificates(tx).findFirst({ where: { id: certificateId } });
        if (!certificate) throw new SecurePackageError('NOT_FOUND', 'certificate not found');
        if (!certificate.packageCiphertext || !certificate.packageExpiresAt) {
          // 已领取销毁或从未存储：失败关闭
          throw new SecurePackageError('NOT_FOUND', 'certificate package not found');
        }
        if (certificate.packageExpiresAt.getTime() <= this.now().getTime()) {
          throw new SecurePackageError('CONFLICT', 'certificate package expired');
        }

        // 单次领取锁：并发/重复领取失败关闭
        const lock = await this.certificates(tx).updateMany({
          where: { id: certificateId, claimedAt: null },
          data: { claimedAt: this.now() },
        });
        if (lock.count !== 1) {
          throw new SecurePackageError('CONFLICT', 'certificate package already claimed');
        }

        const plaintextKey = await this.keyProvider.decryptDataKey(extractEncryptedKey(certificate.packageCiphertext));
        const payload = unpackEnvelope(plaintextKey, certificate.packageCiphertext);

        await recordAudit(tx, {
          objectType: AUDIT_OBJECT_TYPE,
          objectId: certificateId,
          action: 'CERT_PACKAGE_DELIVERY_PREPARE',
          result: 'SUCCESS',
          afterValue: { claimedBy: proof.kind, deliveryReservedAt: this.now().toISOString() },
        });
        return payload;
      });
    } catch (err) {
      if (err instanceof SecurePackageError && (err.code === 'FORBIDDEN' || err.code === 'CONFLICT')) {
        await recordAudit(this.db, {
          objectType: AUDIT_OBJECT_TYPE,
          objectId: certificateId,
          action: 'CERT_PACKAGE_DELIVERY_PREPARE',
          result: 'FAILURE',
          reason: err.code,
        });
      }
      throw err;
    }
  }

  /** 第二阶段：HTTP 成功响应已经提交后销毁密文；幂等。 */
  async confirmPackageDelivery(certificateId: string): Promise<boolean> {
    const { count } = await this.certificates(this.db).updateMany({
      where: { id: certificateId, claimedAt: { not: null }, packageCiphertext: { not: null } },
      data: { packageCiphertext: null, packageKmsKeyId: null, packageExpiresAt: null },
    });
    if (count === 1) {
      await recordAudit(this.db, {
        objectType: AUDIT_OBJECT_TYPE,
        objectId: certificateId,
        action: 'CERT_PACKAGE_DELIVERY_CONFIRM',
        result: 'SUCCESS',
      });
    }
    return count === 1;
  }

  /**
   * 响应不确定恢复：销毁未确认包并把新证书标记 REVOKED；调用方还必须撤销云端证书后重签。
   */
  async revokeUnconfirmedDelivery(certificateId: string): Promise<boolean> {
    return withTransaction(this.db, async (tx) => {
      const { count } = await this.certificates(tx).updateMany({
        where: {
          id: certificateId,
          claimedAt: { not: null },
          packageCiphertext: { not: null },
          status: { in: ['PENDING_CLAIM', 'ACTIVE'] },
        },
        data: {
          status: 'REVOKED',
          revokedAt: this.now(),
          packageCiphertext: null,
          packageKmsKeyId: null,
          packageExpiresAt: null,
        },
      });
      if (count === 1) {
        await recordAudit(tx, {
          objectType: AUDIT_OBJECT_TYPE,
          objectId: certificateId,
          action: 'CERT_PACKAGE_DELIVERY_UNCERTAIN_REVOKE',
          result: 'SUCCESS',
        });
      }
      return count === 1;
    });
  }

  /** 销毁密文包（新证书 Heartbeat 确认后由 BE-ONB-04 调用）；幂等；可传入事务客户端加入外层事务。 */
  async destroyPackage(certificateId: string, client?: DbClient): Promise<boolean> {
    const db = client ?? this.db;
    const { count } = await this.certificates(db).updateMany({
      where: { id: certificateId, packageCiphertext: { not: null } },
      data: { packageCiphertext: null, packageKmsKeyId: null, packageExpiresAt: null },
    });
    if (count === 1) {
      await recordAudit(db, {
        objectType: AUDIT_OBJECT_TYPE,
        objectId: certificateId,
        action: 'CERT_PACKAGE_DESTROY',
        result: 'SUCCESS',
      });
    }
    return count === 1;
  }

  /**
   * 定时清理超过冻结保留期且从未被领取的密文包。
   * 每条记录复用 destroyPackage，确保物理清空密文字段并生成可追踪审计。
   */
  async sweepExpiredPackages(limit = 100): Promise<readonly string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new SecurePackageError('CONFLICT', 'sweep limit must be an integer between 1 and 1000');
    }
    const expired = await this.certificates(this.db).findMany({
      where: {
        packageCiphertext: { not: null },
        packageExpiresAt: { lte: this.now() },
      },
      select: { id: true },
      orderBy: { packageExpiresAt: 'asc' },
      take: limit,
    });
    const destroyed: string[] = [];
    for (const certificate of expired) {
      if (await this.destroyPackage(certificate.id)) destroyed.push(certificate.id);
    }
    return destroyed;
  }

  private async assertClaimEligibility(tx: DbClient, certificate: CertificateRow, proof: ClaimProof): Promise<void> {
    if (proof.kind === 'deviceCertificate') {
      if (proof.context.deviceId !== certificate.deviceId) {
        throw new SecurePackageError('FORBIDDEN', 'claim proof does not match the certificate device');
      }
      return;
    }
    const device = await this.devices(tx).findFirst({ where: { id: certificate.deviceId } });
    if (!device || device.serialNumber !== proof.context.serialNumber) {
      throw new SecurePackageError('FORBIDDEN', 'claim proof does not match the certificate device');
    }
  }
}
