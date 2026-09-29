import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import { processOnboardingProvisioningJobs } from '../src/index.js';
import type { ProvisioningAttemptContext, ProvisioningExecutor } from '../src/index.js';
import { createTestDb } from './helpers.js';

const NOW = new Date('2026-09-07T01:00:00Z');
let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;
let seq = 0;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

async function plantJob(options: { status?: string; attempts?: number; maxAttempts?: number; issued?: string } = {}) {
  seq += 1;
  const serialNumber = `SN-PROVISIONING-JOB-${seq}`;
  const request = await prisma.onboardingRequest.create({
    data: {
      csrPem: 'TEST_CSR',
      publicKeyFingerprint: 'a'.repeat(64),
      serialNumber,
      submittedBy: `DEVICE:${serialNumber}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1.0',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      status: 'APPROVED',
    },
  });
  const job = await prisma.onboardingProvisioningJob.create({
    data: {
      requestId: request.id,
      status: options.status ?? 'PENDING',
      attempts: options.attempts ?? 0,
      maxAttempts: options.maxAttempts ?? 8,
      nextAttemptAt: NOW,
      lastAttemptAt: options.status === 'PROCESSING' ? new Date(NOW.getTime() - 10 * 60_000) : null,
      issuedCertificateId: options.issued ?? null,
    },
  });
  return { request, job };
}

describe('Onboarding Provisioning Job Worker', () => {
  test('恢复过期 PROCESSING 租约，传递 operation/issued 凭证且不重复消耗 attempt', async () => {
    const planted = await plantJob({ status: 'PROCESSING', attempts: 1, issued: 'cert-orphan' });
    let context: ProvisioningAttemptContext | undefined;
    const provisioner: ProvisioningExecutor = {
      async provision(_request, attempt) {
        context = attempt;
        await attempt.onCertificateIssued?.('cert-ready');
        return { deviceId: 'dev-1', certificateId: 'cert-ready', replayed: false };
      },
    };

    const result = await processOnboardingProvisioningJobs({ client: prisma, provisioner, now: () => NOW });

    assert.deepEqual(result, { evaluated: 1, completed: 1, retried: 0, failed: 0, skipped: 0 });
    assert.equal(context?.operationId, planted.job.operationId);
    assert.equal(context?.priorIssuedCertificateId, 'cert-orphan');
    const job = await prisma.onboardingProvisioningJob.findUniqueOrThrow({ where: { id: planted.job.id } });
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.attempts, 1, '租约恢复重放同一次 attempt，不重复消耗重试配额');
    assert.equal(job.issuedCertificateId, 'cert-ready');
    assert.isNotNull(job.completedAt);
  });

  test('最后一次 PROCESSING 租约恢复不越过 maxAttempts', async () => {
    const planted = await plantJob({ status: 'PROCESSING', attempts: 2, maxAttempts: 2 });
    const provisioner: ProvisioningExecutor = {
      async provision() {
        return { deviceId: 'dev-final-lease', certificateId: 'cert-final-lease', replayed: false };
      },
    };

    const result = await processOnboardingProvisioningJobs({ client: prisma, provisioner, now: () => NOW });

    assert.equal(result.completed, 1);
    const job = await prisma.onboardingProvisioningJob.findUniqueOrThrow({ where: { id: planted.job.id } });
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.attempts, 2);
  });

  test('失败按指数退避重试；耗尽后写终态、告警事件和失败审计', async () => {
    const planted = await plantJob({ maxAttempts: 2 });
    const provisioner: ProvisioningExecutor = {
      provision: async () => Promise.reject(new Error('simulated unavailable')),
    };

    const first = await processOnboardingProvisioningJobs({
      client: prisma,
      provisioner,
      now: () => NOW,
      retryBaseSeconds: 30,
    });
    assert.deepEqual(first, { evaluated: 1, completed: 0, retried: 1, failed: 0, skipped: 0 });
    let job = await prisma.onboardingProvisioningJob.findUniqueOrThrow({ where: { id: planted.job.id } });
    assert.equal(job.status, 'RETRY');
    assert.equal(job.attempts, 1);
    assert.equal(job.nextAttemptAt.toISOString(), new Date(NOW.getTime() + 30_000).toISOString());
    assert.include(job.lastError ?? '', 'simulated unavailable');

    const retryAt = new Date(NOW.getTime() + 30_000);
    const second = await processOnboardingProvisioningJobs({ client: prisma, provisioner, now: () => retryAt });
    assert.deepEqual(second, { evaluated: 1, completed: 0, retried: 0, failed: 1, skipped: 0 });
    job = await prisma.onboardingProvisioningJob.findUniqueOrThrow({ where: { id: planted.job.id } });
    assert.equal(job.status, 'FAILED');
    assert.equal(job.attempts, 2);
    assert.equal(
      await prisma.outboxEvent.count({
        where: { eventType: 'ONBOARDING_PROVISIONING_FAILED', aggregateId: planted.request.id },
      }),
      1,
    );
    assert.equal(
      await prisma.auditLog.count({
        where: { objectId: planted.request.id, action: 'onboarding.provisioning.exhausted', result: 'FAILURE' },
      }),
      1,
    );
  });

  test('并发 Worker 对同一 Job 最多执行一次', async () => {
    const planted = await plantJob();
    let calls = 0;
    const provisioner: ProvisioningExecutor = {
      async provision() {
        calls += 1;
        return { deviceId: 'dev-race', certificateId: 'cert-race', replayed: false };
      },
    };
    await Promise.all([
      processOnboardingProvisioningJobs({ client: prisma, provisioner, now: () => NOW }),
      processOnboardingProvisioningJobs({ client: prisma, provisioner, now: () => NOW }),
    ]);
    assert.equal(calls, 1);
    assert.equal(
      (await prisma.onboardingProvisioningJob.findUniqueOrThrow({ where: { id: planted.job.id } })).status,
      'COMPLETED',
    );
  });
});
