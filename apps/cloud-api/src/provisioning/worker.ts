/** APPROVED Onboarding 的持久化证书发放 Worker。 */
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';
import type { ProvisioningAttemptContext, ProvisioningResult } from './service.js';

export interface ProvisioningJobRow {
  readonly id: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly status: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly issuedCertificateId: string | null;
  readonly lastError: string | null;
  readonly request: { readonly id: string; readonly serialNumber: string; readonly status: string };
}

interface ProvisioningJobDelegate {
  findMany(args: Record<string, unknown>): Promise<ProvisioningJobRow[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

interface OutboxDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

export interface ProvisioningExecutor {
  provision(
    request: { readonly id: string; readonly serialNumber: string },
    attempt: ProvisioningAttemptContext,
  ): Promise<ProvisioningResult>;
}

export interface ProvisioningWorkerDeps {
  readonly client: DbClient;
  readonly provisioner: ProvisioningExecutor;
  readonly now?: () => Date;
  readonly batchSize?: number;
  readonly retryBaseSeconds?: number;
  readonly leaseSeconds?: number;
}

export interface ProvisioningWorkerResult {
  readonly evaluated: number;
  readonly completed: number;
  readonly retried: number;
  readonly failed: number;
  readonly skipped: number;
}

function jobs(client: DbClient): ProvisioningJobDelegate {
  return (client as unknown as Record<string, unknown>).onboardingProvisioningJob as ProvisioningJobDelegate;
}

function safeError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UNKNOWN';
  const message = error instanceof Error ? error.message : 'Unknown failure';
  const redacted = /(private|secret|token|certificatePem|BEGIN|arn:aws|access.?key)/i.test(message)
    ? 'redacted'
    : message;
  return `${name}: ${redacted}`.slice(0, 500);
}

/** 条件认领保证并发 Worker 最多一个执行；PROCESSING 超过租约可恢复。 */
export async function processOnboardingProvisioningJobs(
  deps: ProvisioningWorkerDeps,
): Promise<ProvisioningWorkerResult> {
  const now = deps.now?.() ?? new Date();
  const batchSize = deps.batchSize ?? 25;
  const retryBaseSeconds = deps.retryBaseSeconds ?? 30;
  const leaseSeconds = deps.leaseSeconds ?? 300;
  const staleBefore = new Date(now.getTime() - leaseSeconds * 1000);
  const candidates = await jobs(deps.client).findMany({
    where: {
      request: { status: 'APPROVED', onboardingDeadlineAt: null },
      OR: [
        { status: { in: ['PENDING', 'RETRY'] }, nextAttemptAt: { lte: now } },
        { status: 'PROCESSING', lastAttemptAt: { lte: staleBefore } },
      ],
    },
    include: { request: { select: { id: true, serialNumber: true, status: true } } },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    take: batchSize,
  });

  const result = { evaluated: candidates.length, completed: 0, retried: 0, failed: 0, skipped: 0 };
  for (const job of candidates) {
    // 防御历史/人工数据：已耗尽的待重试 Job 直接收敛 FAILED，不能违反 attempts 上限约束。
    if (job.status !== 'PROCESSING' && job.attempts >= job.maxAttempts) {
      const lastError = job.lastError ?? 'ProvisioningError: retry attempts exhausted';
      await withTransaction(deps.client, async (tx) => {
        const finalized = await jobs(tx).updateMany({
          where: { id: job.id, status: job.status, attempts: job.attempts },
          data: { status: 'FAILED', lastError },
        });
        if (finalized.count !== 1) return;
        const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
        await outbox.create({
          data: {
            eventType: 'ONBOARDING_PROVISIONING_FAILED',
            aggregateType: 'onboarding_request',
            aggregateId: job.requestId,
            payload: {
              requestId: job.requestId,
              operationId: job.operationId,
              attempts: job.attempts,
              error: lastError,
            },
            status: 'PENDING',
          },
        });
        await recordAudit(tx, {
          objectType: 'onboarding_request',
          objectId: job.requestId,
          action: 'onboarding.provisioning.exhausted',
          result: 'FAILURE',
          reason: lastError,
          afterValue: { operationId: job.operationId, attempts: job.attempts },
        });
        result.failed += 1;
      });
      continue;
    }
    // 租约恢复重放的是已计数的那一次 attempt，不能再次递增，否则会越过 maxAttempts。
    const recoveringLease = job.status === 'PROCESSING';
    const claimed = await jobs(deps.client).updateMany({
      where: {
        id: job.id,
        status: job.status,
        ...(job.status === 'PROCESSING' ? { lastAttemptAt: { lte: staleBefore } } : { nextAttemptAt: { lte: now } }),
      },
      data: {
        status: 'PROCESSING',
        ...(!recoveringLease ? { attempts: { increment: 1 } } : {}),
        lastAttemptAt: now,
        lastError: null,
      },
    });
    if (claimed.count !== 1) {
      result.skipped += 1;
      continue;
    }

    const attemptNumber = job.attempts + (recoveringLease ? 0 : 1);
    try {
      const provisioned = await deps.provisioner.provision(
        { id: job.request.id, serialNumber: job.request.serialNumber },
        {
          operationId: job.operationId,
          priorIssuedCertificateId: job.issuedCertificateId,
          onCertificateIssued: async (certificateId) => {
            await jobs(deps.client).updateMany({
              where: { id: job.id, status: 'PROCESSING' },
              data: { issuedCertificateId: certificateId },
            });
          },
        },
      );
      await jobs(deps.client).updateMany({
        where: { id: job.id, status: 'PROCESSING' },
        data: {
          status: 'COMPLETED',
          issuedCertificateId: provisioned.certificateId,
          lastError: null,
          completedAt: deps.now?.() ?? new Date(),
        },
      });
      result.completed += 1;
    } catch (error) {
      const terminal = attemptNumber >= job.maxAttempts;
      const lastError = safeError(error);
      const nextAttemptAt = new Date(
        now.getTime() + Math.min(retryBaseSeconds * 2 ** Math.max(0, attemptNumber - 1), 3600) * 1000,
      );
      await withTransaction(deps.client, async (tx) => {
        await jobs(tx).updateMany({
          where: { id: job.id, status: 'PROCESSING' },
          data: { status: terminal ? 'FAILED' : 'RETRY', lastError, nextAttemptAt },
        });
        if (terminal) {
          const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
          await outbox.create({
            data: {
              eventType: 'ONBOARDING_PROVISIONING_FAILED',
              aggregateType: 'onboarding_request',
              aggregateId: job.requestId,
              payload: {
                requestId: job.requestId,
                operationId: job.operationId,
                attempts: attemptNumber,
                error: lastError,
              },
              status: 'PENDING',
            },
          });
          await recordAudit(tx, {
            objectType: 'onboarding_request',
            objectId: job.requestId,
            action: 'onboarding.provisioning.exhausted',
            result: 'FAILURE',
            reason: lastError,
            afterValue: { operationId: job.operationId, attempts: attemptNumber },
          });
        }
      });
      if (terminal) result.failed += 1;
      else result.retried += 1;
    }
  }
  return result;
}
