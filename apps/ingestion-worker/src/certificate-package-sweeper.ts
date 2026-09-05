import type { SecurePackageService } from '@fdp/auth';

export interface CertificatePackageSweeperDeps {
  readonly securePackage: SecurePackageService;
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

export interface CertificatePackageSweepResult {
  readonly destroyedCertificateIds: readonly string[];
  readonly exhaustedBatchBudget: boolean;
}

/** EventBridge 定时任务核心：有界批量清除所有已过期证书包，不依赖领取请求触发。 */
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
    const destroyedCertificateIds: string[] = [];
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const destroyed = await deps.securePackage.sweepExpiredPackages(batchSize);
      destroyedCertificateIds.push(...destroyed);
      if (destroyed.length < batchSize) {
        return { destroyedCertificateIds, exhaustedBatchBudget: false };
      }
    }
    return { destroyedCertificateIds, exhaustedBatchBudget: true };
  };
}
