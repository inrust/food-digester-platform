/**
 * BE-ARC-02 S3 Archive Worker：把 Archive SQS 记录按 topic/customer/小时合并为 NDJSON/GZIP，
 * 使用规定前缀写 S3，并生成 Manifest。
 *
 * - 规定前缀（AWS云端运维任务清单 §归档）：
 *   `raw/topic_type={type}/customer_id={customerId}/year={yyyy}/month={mm}/day={dd}/hour={hh}/part-{hash16}.json.gz`
 *   Manifest 旁挂同前缀 `part-{hash16}.manifest.json`；
 * - 归档范围：Telemetry/Report/Alarm/Event/Tamper 必须归档；ACK/License/OTA 可选（归档）；
 *   Heartbeat 不归档；Media 文件走独立 Bucket（DEC-005，本链路跳过）；
 * - 行格式：每行 = 归档记录 JSON（{eventId, ...outbox 归档载荷}，内嵌原始上行 Payload，
 *   解压后每行是原始可验证 JSON；audit.hash 随行保留，DEC-002）；
 * - 重复事件不产生逻辑重复：批内按 eventId 去重；part Key 由去重后 eventId 集合哈希派生，
 *   同批次重跑产生相同 Key 与相同字节（GZIP 无时间戳），覆盖写不生新对象；
 * - 对象 Hash 可复算：sha256 = GZIP 字节 SHA-256，记入 Manifest。
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { ArchiveEventMessage } from '@fdp/aws-clients';

/** 必须归档的上行类型（技术对接要求）。 */
export const MUST_ARCHIVE_TOPIC_TYPES = ['telemetry', 'report', 'alarm', 'event', 'tamper'] as const;
/** 可选归档（V1 选择归档）。 */
export const OPTIONAL_ARCHIVE_TOPIC_TYPES = ['ack', 'license', 'ota'] as const;
/** 明确不归档：Heartbeat（RDS 只留最新态）；Media（独立 Bucket，DEC-005）。 */
export const NEVER_ARCHIVE_TOPIC_TYPES = ['heartbeat', 'media'] as const;

export const ARCHIVE_WORKER_VERSION = 'archive-worker@1.0.0';
export const MANIFEST_VERSION = '1.0';

/** S3 写入端口（AWS 适配器见 @fdp/aws-clients createS3ArchiveObjectStore）。 */
export interface ArchiveObjectStore {
  putObject(params: { key: string; body: Uint8Array; contentType: string }): Promise<void>;
}

export interface ArchiveWorkerDeps {
  readonly bucket: string;
  readonly store: ArchiveObjectStore;
  readonly workerVersion?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface ArchivedObject {
  readonly key: string;
  readonly manifestKey: string;
  readonly topicType: string;
  readonly customerId: string;
  readonly recordCount: number;
  readonly sha256: string;
}

export interface ArchiveBatchResult {
  readonly objects: ArchivedObject[];
  /** 未归档计数（heartbeat/media/未知类型）。 */
  readonly skipped: Record<string, number>;
  /** 批内 eventId 重复被去重的条数。 */
  readonly deduplicated: number;
}

interface ArchiveRecord {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly seq: number | null;
  readonly schemaVer: string | null;
  readonly line: Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 从归档载荷提取分组与行内容；无法识别（缺 topicType/customerId）返回 null。 */
function recordOf(
  message: ArchiveEventMessage,
): { topicType: string; customerId: string; record: ArchiveRecord } | null {
  const payload = message.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return null;
  const topicType = asString(payload.topicType);
  const customerId = asString(payload.customerId);
  if (!topicType || !customerId) return null;

  const occurredAt =
    asString(payload.occurredAt) ??
    (typeof payload.receivedAtMs === 'number' ? new Date(payload.receivedAtMs).toISOString() : null) ??
    message.createdAt;
  const rawPayload = payload.payload as Record<string, unknown> | null;
  const meta = (rawPayload?.meta ?? null) as Record<string, unknown> | null;
  const seq = meta && typeof meta.seq === 'number' ? meta.seq : null;
  const schemaVer = meta ? asString(meta.schemaVer) : null;

  return {
    topicType,
    customerId,
    record: {
      eventId: message.eventId,
      occurredAt,
      seq,
      schemaVer,
      // 行 = 归档载荷 + 稳定 eventId（原始 Payload 完整内嵌，解压后每行可验证）
      line: { eventId: message.eventId, ...payload },
    },
  };
}

function hourWindowOf(occurredAt: string): {
  year: string;
  month: string;
  day: string;
  hour: string;
  windowStartUtc: string;
} {
  const date = new Date(occurredAt);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const year = String(date.getUTCFullYear());
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hour = pad(date.getUTCHours());
  return { year, month, day, hour, windowStartUtc: `${year}-${month}-${day}T${hour}:00:00Z` };
}

export function createArchiveWorker(deps: ArchiveWorkerDeps): {
  archiveBatch(messages: ArchiveEventMessage[]): Promise<ArchiveBatchResult>;
} {
  const workerVersion = deps.workerVersion ?? ARCHIVE_WORKER_VERSION;
  const now = deps.now ?? (() => new Date());
  const archivable = new Set<string>([...MUST_ARCHIVE_TOPIC_TYPES, ...OPTIONAL_ARCHIVE_TOPIC_TYPES]);

  return {
    async archiveBatch(messages) {
      const groups = new Map<string, { topicType: string; customerId: string; records: ArchiveRecord[] }>();
      const seen = new Set<string>();
      const skipped: Record<string, number> = {};
      let deduplicated = 0;

      for (const message of messages) {
        // 批内去重（重复投递）
        if (seen.has(message.eventId)) {
          deduplicated += 1;
          continue;
        }
        seen.add(message.eventId);

        const parsed = recordOf(message);
        if (!parsed || !archivable.has(parsed.topicType)) {
          const key = parsed?.topicType ?? 'unknown';
          skipped[key] = (skipped[key] ?? 0) + 1;
          continue;
        }
        const window = hourWindowOf(parsed.record.occurredAt);
        const groupKey = `${parsed.topicType}|${parsed.customerId}|${window.windowStartUtc}`;
        const group = groups.get(groupKey) ?? {
          topicType: parsed.topicType,
          customerId: parsed.customerId,
          records: [],
        };
        group.records.push(parsed.record);
        groups.set(groupKey, group);
      }

      const objects: ArchivedObject[] = [];
      for (const group of groups.values()) {
        // 稳定排序：occurredAt → eventId（同批次重跑产生相同字节）
        const records = [...group.records].sort((a, b) =>
          a.occurredAt === b.occurredAt ? a.eventId.localeCompare(b.eventId) : a.occurredAt.localeCompare(b.occurredAt),
        );
        const ndjson = records.map((r) => JSON.stringify(r.line)).join('\n') + '\n';
        const gzipped = gzipSync(Buffer.from(ndjson, 'utf8'), { level: 9 });
        const sha256 = createHash('sha256').update(gzipped).digest('hex');

        const first = records[0] as ArchiveRecord;
        const window = hourWindowOf(first.occurredAt);
        // part Key 由去重后 eventId 集合哈希派生：同批次重跑同 Key 覆盖，不产生逻辑重复
        const partHash = createHash('sha256')
          .update(
            records
              .map((r) => r.eventId)
              .sort()
              .join(','),
          )
          .digest('hex')
          .slice(0, 16);
        const prefix =
          `raw/topic_type=${group.topicType}/customer_id=${group.customerId}` +
          `/year=${window.year}/month=${window.month}/day=${window.day}/hour=${window.hour}`;
        const key = `${prefix}/part-${partHash}.json.gz`;
        const manifestKey = `${prefix}/part-${partHash}.manifest.json`;

        const seqs = records.map((r) => r.seq).filter((s): s is number => s !== null);
        const manifest = {
          manifestVersion: MANIFEST_VERSION,
          bucket: deps.bucket,
          key,
          topicType: group.topicType,
          customerId: group.customerId,
          windowStartUtc: window.windowStartUtc,
          recordCount: records.length,
          occurredAtMin: first.occurredAt,
          occurredAtMax: records[records.length - 1]?.occurredAt ?? first.occurredAt,
          seqMin: seqs.length > 0 ? Math.min(...seqs) : null,
          seqMax: seqs.length > 0 ? Math.max(...seqs) : null,
          sha256,
          schemaVersions: [...new Set(records.map((r) => r.schemaVer).filter((v): v is string => v !== null))].sort(),
          workerVersion,
          eventIds: records.map((r) => r.eventId),
          createdAt: now().toISOString(),
        };

        await deps.store.putObject({ key, body: gzipped, contentType: 'application/x-ndjson+gzip' });
        await deps.store.putObject({
          key: manifestKey,
          body: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
          contentType: 'application/json',
        });
        objects.push({
          key,
          manifestKey,
          topicType: group.topicType,
          customerId: group.customerId,
          recordCount: records.length,
          sha256,
        });
      }

      return { objects, skipped, deduplicated };
    },
  };
}
