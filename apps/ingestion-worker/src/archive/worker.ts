/**
 * BE-ARC-02 S3 Archive Worker：按 DEC-016 将 MQTT 原文、领域事件和操作记录分流归档。
 *
 * - 规定前缀（AWS云端运维任务清单 §归档）：
 *   `raw/topic_type={type}/customer_id={customerId}/year={yyyy}/month={mm}/day={dd}/hour={hh}/part-{hash16}.json.gz`
 *   Manifest 旁挂同前缀 `part-{hash16}.manifest.json`；
 * - 归档范围：Telemetry/Report/Alarm/Event/Tamper 必须归档；ACK 可选；
 *   Heartbeat 不归档；Media 文件走独立 Bucket（DEC-005，本链路跳过）；
 * - License 以 DOMAIN_EVENT 归档；OTA 发布/结果以 OPERATION_RECORD 归档，均不得进入 raw/；
 * - 行格式：每行 = 归档记录 JSON（{eventId, ...outbox 归档载荷}，内嵌原始上行 Payload，
 *   解压后每行是原始可验证 JSON；audit.hash 随行保留，DEC-002）；
 * - 重复事件不产生逻辑重复：每个 eventId 使用稳定单事件 part Key；批次拆分、部分重试和
 *   并发批次都会覆盖同一个对象，不产生第二份逻辑记录；
 * - 对象 Hash 可复算：sha256 = GZIP 字节 SHA-256，记入 Manifest。
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { ArchiveEventMessage } from '@fdp/aws-clients';

/** 必须归档的上行类型（技术对接要求）。 */
export const MUST_ARCHIVE_TOPIC_TYPES = ['telemetry', 'report', 'alarm', 'event', 'tamper'] as const;
/** 可选归档（V1 选择归档）。License/OTA 不是 MQTT topic，不在此列表。 */
export const OPTIONAL_ARCHIVE_TOPIC_TYPES = ['ack'] as const;
/** 明确不归档：Heartbeat（RDS 只留最新态）；Media（独立 Bucket，DEC-005）。 */
export const NEVER_ARCHIVE_TOPIC_TYPES = ['heartbeat', 'media'] as const;

export const ARCHIVE_WORKER_VERSION = 'archive-worker@2.0.0';
export const MANIFEST_VERSION = '2.0';

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
  readonly archiveClass: ArchiveClass;
  readonly sourceType: string;
  readonly topicType?: string | undefined;
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
  /** 契约损坏或伪装来源：生产 SQS Handler 必须重试并最终进入 Archive DLQ。 */
  readonly rejectedEventIds: string[];
  readonly rejected: Array<{ readonly eventId: string; readonly errorPath: string; readonly reason: string }>;
}

interface ArchiveRecord {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly seq: number | null;
  readonly schemaVer: string | null;
  readonly line: Record<string, unknown>;
}

export type ArchiveClass = 'MQTT_RAW' | 'DOMAIN_EVENT' | 'OPERATION_RECORD';

interface ParsedRecord {
  readonly archiveClass: ArchiveClass;
  readonly sourceType: string;
  readonly customerId: string;
  readonly record: ArchiveRecord;
}

interface ArchiveGroup {
  readonly archiveClass: ArchiveClass;
  readonly sourceType: string;
  readonly customerId: string;
  readonly records: ArchiveRecord[];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 从归档载荷提取分组与行内容；无法识别（缺 topicType/customerId）返回 null。 */
function recordOf(message: ArchiveEventMessage): ParsedRecord | null {
  const payload = message.payload as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return null;
  const customerId = asString(payload.customerId);
  if (!customerId) return null;

  // 兼容 DEC-016 冻结前已入队的 MQTT 原文：无 archiveClass 时按 MQTT_RAW 解释。
  const explicitArchiveClass = asString(payload.archiveClass);
  const archiveClass = (explicitArchiveClass ?? 'MQTT_RAW') as ArchiveClass;
  if (explicitArchiveClass && payload.envelopeVersion !== '1.0') return null;
  let sourceType: string | null = null;
  if (
    archiveClass === 'MQTT_RAW' &&
    payload.entityType === undefined &&
    payload.operationType === undefined &&
    (!explicitArchiveClass || (payload.payload !== null && typeof payload.payload === 'object'))
  ) {
    sourceType = asString(payload.topicType);
  }
  if (
    archiveClass === 'DOMAIN_EVENT' &&
    payload.topicType === undefined &&
    payload.operationType === undefined &&
    payload.entityType === 'license' &&
    payload.domainEventType === 'LICENSE_STATUS_CHANGED' &&
    payload.data !== null &&
    typeof payload.data === 'object'
  ) {
    sourceType = 'license';
  }
  if (
    archiveClass === 'OPERATION_RECORD' &&
    payload.topicType === undefined &&
    payload.entityType === undefined &&
    payload.operationType === 'ota' &&
    payload.data !== null &&
    typeof payload.data === 'object'
  ) {
    const recordType = asString(payload.recordType);
    if (recordType === 'PUBLICATION' || recordType === 'RESULT') sourceType = `ota/${recordType.toLowerCase()}`;
  }
  if (!sourceType) return null;

  const occurredAt =
    asString(payload.occurredAt) ??
    (typeof payload.receivedAtMs === 'number' ? new Date(payload.receivedAtMs).toISOString() : null) ??
    message.createdAt;
  const rawPayload = archiveClass === 'MQTT_RAW' ? (payload.payload as Record<string, unknown> | null) : null;
  const meta = (rawPayload?.meta ?? null) as Record<string, unknown> | null;
  const seq = meta && typeof meta.seq === 'number' ? meta.seq : null;
  const schemaVer = meta ? asString(meta.schemaVer) : null;

  return {
    archiveClass,
    sourceType,
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
      const groups = new Map<string, ArchiveGroup>();
      const seen = new Set<string>();
      const skipped: Record<string, number> = {};
      let deduplicated = 0;
      const rejectedEventIds: string[] = [];
      const rejected: Array<{ eventId: string; errorPath: string; reason: string }> = [];

      for (const message of messages) {
        // 批内去重（重复投递）
        if (seen.has(message.eventId)) {
          deduplicated += 1;
          continue;
        }
        seen.add(message.eventId);

        const parsed = recordOf(message);
        const accepted = parsed && (parsed.archiveClass !== 'MQTT_RAW' || archivable.has(parsed.sourceType));
        if (!accepted || !parsed) {
          const key = parsed?.sourceType ?? 'unknown';
          skipped[key] = (skipped[key] ?? 0) + 1;
          if (!parsed || !(NEVER_ARCHIVE_TOPIC_TYPES as readonly string[]).includes(parsed.sourceType)) {
            rejectedEventIds.push(message.eventId);
            rejected.push({
              eventId: message.eventId,
              errorPath: parsed ? 'payload.topicType' : 'payload',
              reason: parsed
                ? `unsupported mandatory archive source: ${parsed.sourceType}`
                : 'invalid archive envelope',
            });
          }
          continue;
        }
        const window = hourWindowOf(parsed.record.occurredAt);
        // 稳定单事件对象：跨批 `[A,B]` → `[A]`、部分重试和并发执行均命中同一个 Key。
        const groupKey = `${parsed.archiveClass}|${parsed.sourceType}|${parsed.customerId}|${window.windowStartUtc}|${message.eventId}`;
        const group = groups.get(groupKey) ?? {
          archiveClass: parsed.archiveClass,
          sourceType: parsed.sourceType,
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
        // 单事件 part Key 只依赖 eventId，与批次边界无关。
        const partHash = createHash('sha256')
          .update(
            records
              .map((r) => r.eventId)
              .sort()
              .join(','),
          )
          .digest('hex')
          .slice(0, 16);
        const partition =
          `/customer_id=${group.customerId}/year=${window.year}/month=${window.month}` +
          `/day=${window.day}/hour=${window.hour}`;
        const prefix =
          group.archiveClass === 'MQTT_RAW'
            ? `raw/topic_type=${group.sourceType}${partition}`
            : group.archiveClass === 'DOMAIN_EVENT'
              ? `domain/entity_type=${group.sourceType}${partition}`
              : `operations/operation_type=ota/record_type=${group.sourceType.split('/')[1]}${partition}`;
        const key = `${prefix}/part-${partHash}.json.gz`;
        const manifestKey = `${prefix}/part-${partHash}.manifest.json`;

        const seqs = records.map((r) => r.seq).filter((s): s is number => s !== null);
        const manifest = {
          manifestVersion: MANIFEST_VERSION,
          archiveClass: group.archiveClass,
          sourceType: group.sourceType,
          bucket: deps.bucket,
          key,
          ...(group.archiveClass === 'MQTT_RAW' ? { topicType: group.sourceType } : {}),
          customerId: group.customerId,
          windowStartUtc: window.windowStartUtc,
          recordCount: records.length,
          occurredAtMin: first.occurredAt,
          occurredAtMax: records[records.length - 1]?.occurredAt ?? first.occurredAt,
          ...(group.archiveClass === 'MQTT_RAW'
            ? {
                seqMin: seqs.length > 0 ? Math.min(...seqs) : null,
                seqMax: seqs.length > 0 ? Math.max(...seqs) : null,
              }
            : {}),
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
          archiveClass: group.archiveClass,
          sourceType: group.sourceType,
          ...(group.archiveClass === 'MQTT_RAW' ? { topicType: group.sourceType } : {}),
          customerId: group.customerId,
          recordCount: records.length,
          sha256,
        });
      }

      return { objects, skipped, deduplicated, rejectedEventIds, rejected };
    },
  };
}
