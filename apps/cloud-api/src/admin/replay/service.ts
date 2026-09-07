/**
 * BE-RPL-01 消息重放 Service：按 Customer/设备/时间/序号范围创建 replay job。
 *
 * 校验：customerId 必须存在（404）；deviceId 可选但须属于该 Customer（跨 Customer 拒绝 400）；
 * from/to 必填且 from<=to；topicType 限可归档上行类型；seqFrom<=seqTo。
 * 创建、触发 Outbox 与 DOM-03 审计（replay.job.create）同一事务；执行由 BE-RPL-01 Replay Worker 异步完成。
 */
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';
import type { ActorContext } from '@fdp/auth';
import { AdminOnboardingError } from '../onboarding/errors.js';

/** 可重放的归档上行类型（与 BE-ARC-02 归档范围一致）。 */
export const REPLAYABLE_TOPIC_TYPES = ['telemetry', 'report', 'alarm', 'event', 'tamper', 'ack'] as const;
export type ReplayableTopicType = (typeof REPLAYABLE_TOPIC_TYPES)[number];

export interface ReplayScope {
  readonly customerId: string;
  readonly deviceId?: string | undefined;
  readonly topicType?: ReplayableTopicType | undefined;
  readonly from: string;
  readonly to: string;
  readonly seqFrom?: number | undefined;
  readonly seqTo?: number | undefined;
}

export interface ReplayJobView {
  readonly jobId: string;
  readonly scope: ReplayScope;
  readonly status: string;
  readonly resultSummary: unknown;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function parseUtc(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new AdminOnboardingError('VALIDATION_FAILED', `${field} must be a UTC ISO-8601 timestamp (Z suffix)`);
  }
  return value;
}

function parseSeq(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AdminOnboardingError('VALIDATION_FAILED', `${field} must be a non-negative integer`);
  }
  return value;
}

/** 解析并校验创建请求体为 ReplayScope（跨 Customer 设备引用在此拒绝）。 */
export async function parseReplayScope(client: DbClient, body: unknown): Promise<ReplayScope> {
  const input = (body ?? {}) as Record<string, unknown>;
  const customerId = typeof input.customerId === 'string' && input.customerId.length > 0 ? input.customerId : null;
  if (!customerId) throw new AdminOnboardingError('VALIDATION_FAILED', 'customerId is required');

  const customers = (client as unknown as Record<string, unknown>).customer as {
    findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string } | null>;
  };
  const customer = await customers.findFirst({ where: { id: customerId } });
  if (!customer) throw new AdminOnboardingError('NOT_FOUND', `Customer 不存在: ${customerId}`);

  let deviceId: string | undefined;
  if (input.deviceId !== undefined && input.deviceId !== null) {
    if (typeof input.deviceId !== 'string' || input.deviceId.length === 0) {
      throw new AdminOnboardingError('VALIDATION_FAILED', 'deviceId must be a non-empty string');
    }
    const devices = (client as unknown as Record<string, unknown>).device as {
      findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string; customerId: string | null } | null>;
    };
    const device = await devices.findFirst({ where: { id: input.deviceId } });
    if (!device) throw new AdminOnboardingError('NOT_FOUND', `设备不存在: ${input.deviceId}`);
    if (device.customerId !== customerId) {
      // 跨 Customer 请求被拒绝
      throw new AdminOnboardingError('VALIDATION_FAILED', 'deviceId does not belong to the given customerId');
    }
    deviceId = input.deviceId;
  }

  let topicType: ReplayableTopicType | undefined;
  if (input.topicType !== undefined && input.topicType !== null) {
    if (
      typeof input.topicType !== 'string' ||
      !(REPLAYABLE_TOPIC_TYPES as readonly string[]).includes(input.topicType)
    ) {
      throw new AdminOnboardingError(
        'VALIDATION_FAILED',
        `topicType must be one of: ${REPLAYABLE_TOPIC_TYPES.join(', ')}`,
      );
    }
    topicType = input.topicType as ReplayableTopicType;
  }

  const from = parseUtc(input.from, 'from');
  const to = parseUtc(input.to, 'to');
  if (Date.parse(from) > Date.parse(to)) {
    throw new AdminOnboardingError('VALIDATION_FAILED', 'from must be earlier than or equal to to');
  }
  const seqFrom = parseSeq(input.seqFrom, 'seqFrom');
  const seqTo = parseSeq(input.seqTo, 'seqTo');
  if (seqFrom !== undefined && seqTo !== undefined && seqFrom > seqTo) {
    throw new AdminOnboardingError('VALIDATION_FAILED', 'seqFrom must be less than or equal to seqTo');
  }

  return { customerId, deviceId, topicType, from, to, seqFrom, seqTo };
}

export async function createReplayJob(
  client: DbClient,
  scope: ReplayScope,
  actor: ActorContext,
): Promise<ReplayJobView> {
  return withTransaction(client, async (tx) => {
    const jobs = (tx as unknown as Record<string, unknown>).replayJob as {
      create(args: { data: Record<string, unknown> }): Promise<{
        id: string;
        scope: unknown;
        status: string;
        resultSummary: unknown;
        requestedBy: string;
        createdAt: Date;
        completedAt: Date | null;
      }>;
    };
    const job = await jobs.create({
      data: { requestedBy: actor.actorId, scope: scope as unknown as Record<string, unknown>, status: 'PENDING' },
    });
    const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as {
      create(args: { data: Record<string, unknown> }): Promise<unknown>;
    };
    await outbox.create({
      data: {
        eventType: 'REPLAY_JOB_REQUESTED',
        aggregateType: 'replayJob',
        aggregateId: job.id,
        payload: { jobId: job.id },
      },
    });
    await recordAudit(tx, {
      objectType: 'replayJob',
      objectId: job.id,
      action: 'replay.job.create',
      actorId: actor.actorId,
      actorRole: actor.roles[0],
      customerId: scope.customerId,
      result: 'SUCCESS',
      afterValue: { scope },
    });
    return {
      jobId: job.id,
      scope,
      status: job.status,
      resultSummary: job.resultSummary,
      requestedBy: job.requestedBy,
      createdAt: job.createdAt.toISOString(),
      completedAt: null,
    };
  });
}
