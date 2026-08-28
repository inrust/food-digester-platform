/**
 * BE-RPL-01 Replay Worker：从 S3 读取归档原始记录，按 scope 过滤后重新投入 Ingress。
 *
 * - scope：{customerId, deviceId?, topicType?, from, to, seqFrom?, seqTo?}；
 *   记录级过滤独立于前缀（customerId 行内断言、设备/时间/序号范围），范围外记录不进入队列；
 * - 重放沿用原幂等键：重投记录携带原始上行 Payload（meta.id/meta.seq 不变），
 *   BE-IOT-03 receipt 据此去重——已处理消息重放不会复制业务记录；
 * - 状态机：PENDING →（条件领取）RUNNING → COMPLETED/FAILED + resultSummary（成功/跳过/失败统计）；
 *   非 PENDING 重复执行为幂等 no-op；
 * - 每次执行写审计（replay.job.execute，SUCCESS/FAILURE，DOM-03）。
 */
import { gunzipSync } from 'node:zlib';
import type { DbClient } from '@fdp/database';
import { recordAudit } from '@fdp/database';

/** 与 BE-ARC-02 归档范围一致的可重放类型。 */
export const REPLAY_TOPIC_TYPES = ['telemetry', 'report', 'alarm', 'event', 'tamper', 'ack'] as const;

export interface ReplayScopeInput {
  readonly customerId: string;
  readonly deviceId?: string | undefined;
  readonly topicType?: string | undefined;
  readonly from: string;
  readonly to: string;
  readonly seqFrom?: number | undefined;
  readonly seqTo?: number | undefined;
}

/** 重投 Ingress 的记录（iotPrincipal 由部署适配层注入当前 ACTIVE 证书 ARN，见文档）。 */
export interface ReplayIngressRecord {
  readonly iotTopic: string;
  readonly iotDeviceId: string;
  readonly iotType: string;
  readonly iotReceivedAt: number;
  /** 原始上行 Payload（meta.id/meta.seq 原样，幂等键来源）。 */
  readonly payload: unknown;
}

export interface ReplayIngressSink {
  send(record: ReplayIngressRecord): Promise<void>;
}

export interface ReplayArchiveReader {
  /** 列出前缀下全部对象 Key（含分页展开）。 */
  listKeys(prefix: string): Promise<string[]>;
  getObject(key: string): Promise<Uint8Array>;
}

export interface ReplayWorkerDeps {
  readonly client: DbClient;
  readonly reader: ReplayArchiveReader;
  readonly sink: ReplayIngressSink;
  readonly now?: (() => Date) | undefined;
}

export interface ReplayExecutionSummary {
  readonly scannedObjects: number;
  readonly scannedLines: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface ReplayExecutionResult {
  readonly status: 'COMPLETED' | 'FAILED' | 'ALREADY_DONE';
  readonly summary: ReplayExecutionSummary | null;
}

interface ReplayJobRow {
  readonly id: string;
  readonly requestedBy: string;
  readonly scope: unknown;
  readonly status: string;
}

interface ReplayJobDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<ReplayJobRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

const MAX_ERROR_LENGTH = 500;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 枚举 [from, to] 覆盖的 UTC 小时窗口（含端点所在小时）。 */
export function hourWindowsBetween(
  from: string,
  to: string,
): Array<{ year: string; month: string; day: string; hour: string }> {
  const start = new Date(from);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(to);
  const windows: Array<{ year: string; month: string; day: string; hour: string }> = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 3_600_000) {
    const d = new Date(t);
    windows.push({
      year: String(d.getUTCFullYear()),
      month: pad2(d.getUTCMonth() + 1),
      day: pad2(d.getUTCDate()),
      hour: pad2(d.getUTCHours()),
    });
  }
  return windows;
}

interface ArchiveLine {
  readonly customerId: string;
  readonly deviceId: string;
  readonly topicType: string;
  readonly occurredAt: string;
  readonly receivedAtMs: number | null;
  readonly payload: unknown;
}

function parseLine(line: Record<string, unknown>): ArchiveLine | null {
  const customerId = typeof line.customerId === 'string' ? line.customerId : null;
  const deviceId = typeof line.deviceId === 'string' ? line.deviceId : null;
  const topicType = typeof line.topicType === 'string' ? line.topicType : null;
  const occurredAt = typeof line.occurredAt === 'string' ? line.occurredAt : null;
  if (!customerId || !deviceId || !topicType || !occurredAt) return null;
  return {
    customerId,
    deviceId,
    topicType,
    occurredAt,
    receivedAtMs: typeof line.receivedAtMs === 'number' ? line.receivedAtMs : null,
    payload: line.payload,
  };
}

/** 记录级范围判定（独立于前缀；范围外记录不进入队列）。 */
export function inScope(line: ArchiveLine, scope: ReplayScopeInput): boolean {
  if (line.customerId !== scope.customerId) return false;
  if (scope.deviceId && line.deviceId !== scope.deviceId) return false;
  const occurred = Date.parse(line.occurredAt);
  if (occurred < Date.parse(scope.from) || occurred > Date.parse(scope.to)) return false;
  if (scope.seqFrom !== undefined || scope.seqTo !== undefined) {
    const meta = (line.payload as Record<string, unknown> | null)?.meta as Record<string, unknown> | undefined;
    const seq = typeof meta?.seq === 'number' ? meta.seq : null;
    if (seq === null) return false; // 有序号过滤但记录无 seq：无法证明在范围内
    if (scope.seqFrom !== undefined && seq < scope.seqFrom) return false;
    if (scope.seqTo !== undefined && seq > scope.seqTo) return false;
  }
  return true;
}

export function createReplayWorker(deps: ReplayWorkerDeps): {
  executeJob(jobId: string): Promise<ReplayExecutionResult>;
} {
  const now = deps.now ?? (() => new Date());
  const jobs = (deps.client as unknown as Record<string, unknown>).replayJob as ReplayJobDelegate;

  async function finish(
    job: ReplayJobRow,
    status: 'COMPLETED' | 'FAILED',
    resultSummary: Record<string, unknown>,
  ): Promise<void> {
    await jobs.updateMany({
      where: { id: job.id, status: 'RUNNING' },
      data: { status, resultSummary, completedAt: now() },
    });
    await recordAudit(deps.client, {
      objectType: 'replayJob',
      objectId: job.id,
      action: 'replay.job.execute',
      actorId: 'system:replay-worker',
      reason: `job requestedBy ${job.requestedBy}`,
      result: status === 'COMPLETED' ? 'SUCCESS' : 'FAILURE',
      afterValue: resultSummary,
    });
  }

  return {
    async executeJob(jobId) {
      const job = await jobs.findFirst({ where: { id: jobId } });
      if (!job) throw new Error(`replay job not found: ${jobId}`);
      if (job.status !== 'PENDING') return { status: 'ALREADY_DONE', summary: null }; // 幂等：不重复执行

      // 条件领取：仅一个执行者进入 RUNNING
      const { count } = await jobs.updateMany({
        where: { id: job.id, status: 'PENDING' },
        data: { status: 'RUNNING' },
      });
      if (count !== 1) return { status: 'ALREADY_DONE', summary: null };

      const scope = job.scope as ReplayScopeInput;
      type MutableSummary = { -readonly [K in keyof ReplayExecutionSummary]: ReplayExecutionSummary[K] };
      const summary: MutableSummary = { scannedObjects: 0, scannedLines: 0, sent: 0, skipped: 0, failed: 0 };
      try {
        const topicTypes = scope.topicType ? [scope.topicType] : [...REPLAY_TOPIC_TYPES];
        const windows = hourWindowsBetween(scope.from, scope.to);
        for (const topicType of topicTypes) {
          for (const window of windows) {
            const prefix =
              `raw/topic_type=${topicType}/customer_id=${scope.customerId}` +
              `/year=${window.year}/month=${window.month}/day=${window.day}/hour=${window.hour}/`;
            const keys = (await deps.reader.listKeys(prefix)).filter((k) => k.endsWith('.json.gz'));
            for (const key of keys) {
              summary.scannedObjects += 1;
              const body = await deps.reader.getObject(key);
              const lines = gunzipSync(Buffer.from(body))
                .toString('utf8')
                .split('\n')
                .filter((l) => l.length > 0);
              for (const raw of lines) {
                summary.scannedLines += 1;
                const line = parseLine(JSON.parse(raw) as Record<string, unknown>);
                if (!line || !inScope(line, scope)) {
                  summary.skipped += 1;
                  continue;
                }
                try {
                  await deps.sink.send({
                    iotTopic: `bnx/device/${line.deviceId}/${line.topicType}`,
                    iotDeviceId: line.deviceId,
                    iotType: line.topicType,
                    iotReceivedAt: line.receivedAtMs ?? Date.parse(line.occurredAt),
                    payload: line.payload,
                  });
                  summary.sent += 1;
                } catch {
                  summary.failed += 1; // 单条重投失败不中断任务，计入统计
                }
              }
            }
          }
        }
        await finish(job, 'COMPLETED', { ...summary, scope });
        return { status: 'COMPLETED', summary };
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
        await finish(job, 'FAILED', { ...summary, scope, error: message });
        return { status: 'FAILED', summary };
      }
    },
  };
}
