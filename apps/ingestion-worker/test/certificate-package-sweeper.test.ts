import { describe, expect, test, vi } from 'vitest';
import type { SecurePackageService } from '@fdp/auth';
import { createCertificatePackageSweeper } from '../src/index.js';

describe('SEC-01 certificate package scheduled sweeper', () => {
  test('持续分批清理直至不足一批', async () => {
    const sweepExpiredPackages = vi.fn().mockResolvedValueOnce(['cert-1', 'cert-2']).mockResolvedValueOnce(['cert-3']);
    const sweep = createCertificatePackageSweeper({
      securePackage: { sweepExpiredPackages } as unknown as SecurePackageService,
      batchSize: 2,
      maxBatches: 3,
    });

    await expect(sweep()).resolves.toEqual({
      destroyedCertificateIds: ['cert-1', 'cert-2', 'cert-3'],
      exhaustedBatchBudget: false,
    });
    expect(sweepExpiredPackages).toHaveBeenCalledTimes(2);
    expect(sweepExpiredPackages).toHaveBeenCalledWith(2);
  });

  test('达到批次预算时显式报告，避免无界执行', async () => {
    const sweepExpiredPackages = vi.fn().mockResolvedValue(['cert-1']);
    const sweep = createCertificatePackageSweeper({
      securePackage: { sweepExpiredPackages } as unknown as SecurePackageService,
      batchSize: 1,
      maxBatches: 2,
    });
    await expect(sweep()).resolves.toEqual({
      destroyedCertificateIds: ['cert-1', 'cert-1'],
      exhaustedBatchBudget: true,
    });
  });
});
