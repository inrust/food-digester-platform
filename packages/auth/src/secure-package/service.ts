/**
 * SEC-01 证书包安全服务（KMS 信封加密短期存储 + 一次性领取 + 销毁）。
 *
 * 规则（DEC-003 / 技术对接要求）：
 * - AWS 返回私钥后立即加密：storePackage 入参明文只经内存，落库为信封密文；
 * - 短期保存：packageExpiresAt = now + retentionSeconds（值由调用方按 DEC-003 策略注入，
 *   本服务不选定数值；DEC-003 冻结前 maxClaims 仅允许 1，构造时强制）；
 * - 一次性领取：单次领取锁（claimedAt 条件更新），重复领取失败关闭（CONFLICT）；
 *   领取成功即销毁密文（明文返回给调用方后库中不再存在）；
 * - 领取资格：仅对应 Onboarding Token（序列号绑定）或旧设备证书（deviceId 绑定）；
 * - 销毁触发：领取成功自动销毁；新证书首个合法 Heartbeat 后由 BE-ONB-04 调用 destroyPackage；
 * - 审计：store/claim/destroy 写 audit_logs（DOM-03），失败 claim 记 FAILURE；
 *   所有审计负载只含指纹/ID，绝不含明文（DOM-03 脱敏器兜底）。
 *
 * 功能边界：不实现证书业务流程（发证/轮换编排归 BE-ONB-03/04、BE-CERT-02）。
 */
import { recordAudit, withTransaction } from '@fdp/database';
import type { DbClient } from '@fdp/database';
import type { DataKeyProvider } from '@fdp/aws-clients';
import type { DeviceAuthContext } from '../device/verifier.js';
import type { OnboardingAuthContext } from '../onboarding/verifier.js';
import { extractEncryptedKey, packEnvelope, unpackEnvelope } from './envelope.js';
import { SecurePackageError } from './errors.js';

/** 领取资格证明：调用方必须先完成 AUTH-02/AUTH-03 认证。 */
export type ClaimProof =
  | { readonly kind: 'onboardingToken'; readonly context: OnboardingAuthContext }
  | { readonly kind: 'deviceCertificate'; readonly context: DeviceAuthContext };

export interface SecurePackageServiceConfig {
  /** 证书包保存时长（秒），>0；由调用方按 DEC-003 策略显式注入，本服务不选定数值。 */
  readonly retentionSeconds: number;
  /** 领取次数上限；DEC-003 冻结前失败关闭：仅允许 1。 */
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
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface DeviceDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<DeviceRow | null>;
}

const AUDIT_OBJECT_TYPE = 'deviceCertificate';

export class SecurePackageService {
  private readonly db: DbClient;
  private readonly keyProvider: DataKeyProvider;
  private readonly retentionSeconds: number;
  private readonly now: () => Date;

  constructor(deps: { db: DbClient; keyProvider: DataKeyProvider; config: SecurePackageServiceConfig }) {
    const { config } = deps;
    if (!Number.isInteger(config.retentionSeconds) || config.retentionSeconds <= 0) {
      throw new SecurePackageError('CONFLICT', 'retentionSeconds must be a positive integer');
    }
    // DEC-003 失败关闭：maxClaims 未冻结前仅支持一次性领取
    if (config.maxClaims !== 1) {
      throw new SecurePackageError('CONFLICT', 'maxClaims must be 1 until DEC-003 is frozen');
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
   * 一次性领取：校验资格 → 单次领取锁 → 解密 → 同事务销毁密文 → 返回明文。
   * 重复领取/过期/资格不符均拒绝；过期包在拒绝后销毁；失败 claim 记 FAILURE 审计。
   */
  async claimPackage(certificateId: string, proof: ClaimProof): Promise<Uint8Array> {
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

        // 领取成功即销毁密文（同事务）
        await this.certificates(tx).updateMany({
          where: { id: certificateId },
          data: { packageCiphertext: null, packageKmsKeyId: null, packageExpiresAt: null },
        });

        await recordAudit(tx, {
          objectType: AUDIT_OBJECT_TYPE,
          objectId: certificateId,
          action: 'CERT_PACKAGE_CLAIM',
          result: 'SUCCESS',
          afterValue: { claimedBy: proof.kind, claimedAt: this.now().toISOString() },
        });
        return payload;
      });
    } catch (err) {
      if (err instanceof SecurePackageError && (err.code === 'FORBIDDEN' || err.code === 'CONFLICT')) {
        await recordAudit(this.db, {
          objectType: AUDIT_OBJECT_TYPE,
          objectId: certificateId,
          action: 'CERT_PACKAGE_CLAIM',
          result: 'FAILURE',
          reason: err.code,
        });
      }
      throw err;
    }
  }

  /** 销毁密文包（新证书 Heartbeat 确认后由 BE-ONB-04 调用）；幂等。 */
  async destroyPackage(certificateId: string): Promise<boolean> {
    const { count } = await this.certificates(this.db).updateMany({
      where: { id: certificateId, packageCiphertext: { not: null } },
      data: { packageCiphertext: null, packageKmsKeyId: null, packageExpiresAt: null },
    });
    if (count === 1) {
      await recordAudit(this.db, {
        objectType: AUDIT_OBJECT_TYPE,
        objectId: certificateId,
        action: 'CERT_PACKAGE_DESTROY',
        result: 'SUCCESS',
      });
    }
    return count === 1;
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
