import { describe, expect, test, vi } from 'vitest';
import type { SecurePackageService } from '@fdp/auth';
import { createCertificatePackageSweeper } from '../src/index.js';

describe('SEC-01 certificate package scheduled sweeper', () => {
  test('持续分批恢复直至不足一批', async () => {
    const findExpiredPackageIds = vi.fn().mockResolvedValueOnce(['cert-1', 'cert-2']).mockResolvedValueOnce(['cert-3']);
    const recoverExpiredPackage = vi.fn().mockResolvedValue(undefined);
    const sweep = createCertificatePackageSweeper({
      securePackage: { findExpiredPackageIds } as unknown as SecurePackageService,
      recoverExpiredPackage,
      batchSize: 2,
      maxBatches: 3,
    });

    await expect(sweep()).resolves.toEqual({
      recoveredCertificateIds: ['cert-1', 'cert-2', 'cert-3'],
      failedCertificateIds: [],
      exhaustedBatchBudget: false,
    });
    expect(findExpiredPackageIds).toHaveBeenCalledTimes(2);
    expect(findExpiredPackageIds).toHaveBeenCalledWith(2);
    expect(recoverExpiredPackage).toHaveBeenCalledTimes(3);
  });

  test('达到批次预算时显式报告，避免无界执行', async () => {
    const findExpiredPackageIds = vi.fn().mockResolvedValue(['cert-1']);
    const sweep = createCertificatePackageSweeper({
      securePackage: { findExpiredPackageIds } as unknown as SecurePackageService,
      recoverExpiredPackage: vi.fn().mockResolvedValue(undefined),
      batchSize: 1,
      maxBatches: 2,
    });
    await expect(sweep()).resolves.toEqual({
      recoveredCertificateIds: ['cert-1', 'cert-1'],
      failedCertificateIds: [],
      exhaustedBatchBudget: true,
    });
  });

  test('单条 AWS 失败被记录且不阻断后续恢复', async () => {
    const recoverExpiredPackage = vi.fn(async (id: string) => {
      if (id === 'cert-1') throw new Error('AWS unavailable');
    });
    const sweep = createCertificatePackageSweeper({
      securePackage: {
        findExpiredPackageIds: vi.fn().mockResolvedValue(['cert-1', 'cert-2']),
      } as unknown as SecurePackageService,
      recoverExpiredPackage,
      batchSize: 3,
    });
    await expect(sweep()).resolves.toEqual({
      recoveredCertificateIds: ['cert-2'],
      failedCertificateIds: ['cert-1'],
      exhaustedBatchBudget: false,
    });
  });
});
