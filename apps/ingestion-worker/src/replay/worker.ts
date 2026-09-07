/** BE-RPL-01 Replay Worker：可回收租约、逐对象/逐行容错和事务终态审计。 */
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';

export const REPLAY_TOPIC_TYPES = ['telemetry', 'report', 'alarm', 'event', 'tamper', 'ack'] as const;
export interface ReplayScopeInput {
  readonly customerId: string;
  readonly deviceId?: string;
  readonly topicType?: string;
  readonly from: string;
  readonly to: string;
  readonly seqFrom?: number;
  readonly seqTo?: number;
}
export interface ReplayIngressRecord {
  readonly iotTopic: string;
  readonly iotDeviceId: string;
  readonly iotType: string;
  readonly iotReceivedAt: number;
  readonly payload: unknown;
}
export interface ReplayIngressSink {
  send(record: ReplayIngressRecord): Promise<void>;
}
export interface ReplayArchiveReader {
  listKeys(prefix: string): Promise<string[]>;
  getObject(key: string): Promise<Uint8Array>;
}
export interface ReplayWorkerDeps {
  readonly client: DbClient;
  readonly reader: ReplayArchiveReader;
  readonly sink: ReplayIngressSink;
  readonly now?: () => Date;
  readonly leaseDurationMs?: number;
}
export interface ReplayExecutionSummary {
  readonly scannedObjects: number;
  readonly scannedLines: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly failedObjects: number;
  readonly failedLines: number;
  readonly sendFailures: number;
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
const DEFAULT_LEASE_MS = 15 * 60 * 1000;
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
export function hourWindowsBetween(from: string, to: string) {
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
  const occurredAt =
    typeof line.occurredAt === 'string' && !Number.isNaN(Date.parse(line.occurredAt)) ? line.occurredAt : null;
  if (
    !customerId ||
    !deviceId ||
    !topicType ||
    !occurredAt ||
    !REPLAY_TOPIC_TYPES.includes(topicType as (typeof REPLAY_TOPIC_TYPES)[number])
  )
    return null;
  if (!line.payload || typeof line.payload !== 'object' || Array.isArray(line.payload)) return null;
  return {
    customerId,
    deviceId,
    topicType,
    occurredAt,
    receivedAtMs: typeof line.receivedAtMs === 'number' ? line.receivedAtMs : null,
    payload: line.payload,
  };
}
export function inScope(line: ArchiveLine, scope: ReplayScopeInput): boolean {
  if (line.customerId !== scope.customerId || (scope.deviceId && line.deviceId !== scope.deviceId)) return false;
  const occurred = Date.parse(line.occurredAt);
  if (occurred < Date.parse(scope.from) || occurred > Date.parse(scope.to)) return false;
  if (scope.seqFrom !== undefined || scope.seqTo !== undefined) {
    const meta = (line.payload as Record<string, unknown>).meta as Record<string, unknown> | undefined;
    const seq = typeof meta?.seq === 'number' ? meta.seq : null;
    if (
      seq === null ||
      (scope.seqFrom !== undefined && seq < scope.seqFrom) ||
      (scope.seqTo !== undefined && seq > scope.seqTo)
    )
      return false;
  }
  return true;
}
function manifestKeyOf(key: string): string {
  return key.replace(/\.json\.gz$/, '.manifest.json');
}
function validatedLines(key: string, body: Uint8Array, manifestBytes: Uint8Array): string[] {
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as Record<string, unknown>;
  const digest = createHash('sha256').update(body).digest('hex');
  if (
    manifest.key !== key ||
    manifest.sha256 !== digest ||
    manifest.archiveClass !== 'MQTT_RAW' ||
    manifest.manifestVersion !== '2.0'
  ) {
    throw new Error(`invalid archive manifest: ${key}`);
  }
  const lines = gunzipSync(Buffer.from(body)).toString('utf8').split('\n').filter(Boolean);
  if (!Number.isInteger(manifest.recordCount) || manifest.recordCount !== lines.length)
    throw new Error(`manifest recordCount mismatch: ${key}`);
  return lines;
}

export function createReplayWorker(deps: ReplayWorkerDeps) {
  const now = deps.now ?? (() => new Date());
  const leaseMs = deps.leaseDurationMs ?? DEFAULT_LEASE_MS;
  const jobs = (deps.client as unknown as Record<string, unknown>).replayJob as ReplayJobDelegate;
  return {
    async executeJob(jobId: string): Promise<ReplayExecutionResult> {
      const job = await jobs.findFirst({ where: { id: jobId } });
      if (!job) throw new Error(`replay job not found: ${jobId}`);
      const claimedAt = now();
      const leaseToken = randomUUID();
      const leaseUntil = new Date(claimedAt.getTime() + leaseMs);
      const claim = await jobs.updateMany({
        where: { id: job.id, OR: [{ status: 'PENDING' }, { status: 'RUNNING', leaseUntil: { lt: claimedAt } }] },
        data: {
          status: 'RUNNING',
          startedAt: claimedAt,
          lastHeartbeatAt: claimedAt,
          leaseUntil,
          leaseToken,
          attemptCount: { increment: 1 },
          completedAt: null,
        },
      });
      if (claim.count !== 1) return { status: 'ALREADY_DONE', summary: null };

      let heartbeatDueAt = claimedAt.getTime() + Math.max(1, Math.floor(leaseMs / 3));
      const heartbeat = async (force = false): Promise<void> => {
        const at = now();
        if (!force && at.getTime() < heartbeatDueAt) return;
        const renewed = await jobs.updateMany({
          where: { id: job.id, status: 'RUNNING', leaseToken },
          data: { lastHeartbeatAt: at, leaseUntil: new Date(at.getTime() + leaseMs) },
        });
        if (renewed.count !== 1) throw new Error('replay lease lost');
        heartbeatDueAt = at.getTime() + Math.max(1, Math.floor(leaseMs / 3));
      };
      const finish = async (status: 'COMPLETED' | 'FAILED', resultSummary: Record<string, unknown>): Promise<void> => {
        await withTransaction(deps.client, async (tx) => {
          const txJobs = (tx as unknown as Record<string, unknown>).replayJob as ReplayJobDelegate;
          const updated = await txJobs.updateMany({
            where: { id: job.id, status: 'RUNNING', leaseToken },
            data: {
              status,
              resultSummary,
              completedAt: now(),
              leaseUntil: null,
              lastHeartbeatAt: now(),
              leaseToken: null,
            },
          });
          if (updated.count !== 1) throw new Error('replay lease lost before terminal commit');
          await recordAudit(tx, {
            objectType: 'replayJob',
            objectId: job.id,
            action: 'replay.job.execute',
            actorId: 'system:replay-worker',
            reason: `job requestedBy ${job.requestedBy}`,
            result: status === 'COMPLETED' ? 'SUCCESS' : 'FAILURE',
            afterValue: resultSummary,
          });
        });
      };

      const scope = job.scope as ReplayScopeInput;
      const summary = {
        scannedObjects: 0,
        scannedLines: 0,
        sent: 0,
        skipped: 0,
        failed: 0,
        failedObjects: 0,
        failedLines: 0,
        sendFailures: 0,
      };
      try {
        for (const topicType of scope.topicType ? [scope.topicType] : [...REPLAY_TOPIC_TYPES]) {
          for (const window of hourWindowsBetween(scope.from, scope.to)) {
            const prefix = `raw/topic_type=${topicType}/customer_id=${scope.customerId}/year=${window.year}/month=${window.month}/day=${window.day}/hour=${window.hour}/`;
            const keys = (await deps.reader.listKeys(prefix)).filter((key) => key.endsWith('.json.gz'));
            for (const key of keys) {
              await heartbeat(true);
              summary.scannedObjects += 1;
              let lines: string[];
              try {
                const body = await deps.reader.getObject(key);
                lines = validatedLines(key, body, await deps.reader.getObject(manifestKeyOf(key)));
              } catch {
                summary.failedObjects += 1;
                summary.failed += 1;
                continue;
              }
              for (const raw of lines) {
                await heartbeat();
                summary.scannedLines += 1;
                let line: ArchiveLine | null;
                try {
                  const parsed = JSON.parse(raw) as unknown;
                  line =
                    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                      ? parseLine(parsed as Record<string, unknown>)
                      : null;
                } catch {
                  line = null;
                }
                if (!line) {
                  summary.failedLines += 1;
                  summary.failed += 1;
                  continue;
                }
                if (line.topicType !== topicType || !inScope(line, scope)) {
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
                  summary.sendFailures += 1;
                  summary.failed += 1;
                }
              }
            }
          }
        }
        await finish('COMPLETED', { ...summary, scope });
        return { status: 'COMPLETED', summary };
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
        await finish('FAILED', { ...summary, scope, error: message });
        return { status: 'FAILED', summary };
      }
    },
  };
}
