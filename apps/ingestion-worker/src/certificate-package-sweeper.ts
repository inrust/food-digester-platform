import type { SecurePackageService } from '@fdp/auth';

export interface CertificatePackageSweeperDeps {
  readonly securePackage: SecurePackageService;
  /** 组合根注入 ProvisioningService 恢复入口：持久化意图 -> AWS 撤证 -> 清包 -> 重签。 */
  readonly recoverExpiredPackage: (certificateId: string) => Promise<void>;
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

export interface CertificatePackageSweepResult {
  readonly recoveredCertificateIds: readonly string[];
  readonly failedCertificateIds: readonly string[];
  readonly exhaustedBatchBudget: boolean;
}

/** EventBridge 定时任务核心：有界扫描并逐项调用可重试恢复状态机。 */
export function createCertificatePackageSweeper(deps: CertificatePackageSweeperDeps) {
  const batchSize = deps.batchSize ?? 100;
  const maxBatches = deps.maxBatches ?? 10;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error('batchSize must be an integer between 1 and 1000');
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) {
    throw new Error('maxBatches must be an integer between 1 and 100');
  }

  return async (): Promise<CertificatePackageSweepResult> => {
    const recoveredCertificateIds: string[] = [];
    const failedCertificateIds: string[] = [];
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const expired = await deps.securePackage.findExpiredPackageIds(batchSize);
      for (const certificateId of expired) {
        try {
          await deps.recoverExpiredPackage(certificateId);
          recoveredCertificateIds.push(certificateId);
        } catch {
          failedCertificateIds.push(certificateId);
        }
      }
      if (expired.length < batchSize) {
        return { recoveredCertificateIds, failedCertificateIds, exhaustedBatchBudget: false };
      }
    }
    return { recoveredCertificateIds, failedCertificateIds, exhaustedBatchBudget: true };
  };
}
