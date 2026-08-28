/**
 * BE-ARC-02 S3 Archive Worker 与 Manifest 验收（内存 ObjectStore 集成测试）。
 *
 * 验收基准覆盖：
 * - 解压后每行是原始可验证 JSON（NDJSON 逐行解析，原始 Payload 完整内嵌，audit.hash 保留）；
 * - 前缀 customerId 正确（规定前缀 raw/topic_type=/customer_id=/year=/month=/day=/hour=）；
 * - 重复事件不产生逻辑重复（批内 eventId 去重；同批次重跑同 Key 同字节覆盖）；
 * - 对象 Hash 可复算（manifest.sha256 == 对存储字节重算 SHA-256）；
 * - Heartbeat 不归档；Telemetry/Report/Alarm/Event/Tamper 必须归档；Media 跳过（独立 Bucket）。
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, test } from 'vitest';
import { assert } from 'vitest';
import type { ArchiveEventMessage } from '@fdp/aws-clients';
import { createArchiveWorker } from '../src/index.js';
import type { ArchiveObjectStore } from '../src/index.js';

class MemoryObjectStore implements ArchiveObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async putObject(params: { key: string; body: Uint8Array; contentType: string }): Promise<void> {
    this.objects.set(params.key, params.body);
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  json(key: string): Record<string, unknown> {
    const body = this.objects.get(key);
    assert.ok(body, `对象不存在: ${key}`);
    return JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
  }

  ndjsonLines(key: string): Record<string, unknown>[] {
    const body = this.objects.get(key);
    assert.ok(body, `对象不存在: ${key}`);
    return gunzipSync(Buffer.from(body))
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

const BUCKET = 'fdp-test-archive-123456789012';
const FIXED_NOW = new Date('2026-08-28T11:00:05.000Z');

let seqCounter = 0;
function archiveMessage(
  topicType: string,
  options: { customerId?: string; seq?: number; occurredAt?: string; eventId?: string; withAudit?: boolean } = {},
): ArchiveEventMessage {
  seqCounter += 1;
  const seq = options.seq ?? seqCounter;
  const occurredAt = options.occurredAt ?? '2026-08-28T10:30:00.000Z';
  const payload: Record<string, unknown> = {
    meta: { id: `${topicType.toUpperCase()}-DEV-ARC-${seq}`, ts: occurredAt, seq, schemaVer: '1.0' },
    data: { sample: true },
  };
  if (options.withAudit) payload.audit = { hash: 'c'.repeat(64) };
  return {
    eventId: options.eventId ?? `evt-${topicType}-${seqCounter}`,
    eventType: 'ARCHIVE',
    aggregateType: 'device',
    aggregateId: 'dev-arc-1',
    payload: {
      topicType,
      messageId: (payload.meta as Record<string, unknown>).id,
      deviceId: 'dev-arc-1',
      customerId: options.customerId ?? 'cust-1',
      occurredAt,
      receivedAtMs: Date.parse(occurredAt),
      payloadHash: 'd'.repeat(64),
      auditHash: options.withAudit ? 'c'.repeat(64) : null,
      payload,
    },
    createdAt: '2026-08-28T10:30:01.000Z',
  };
}

function worker(store: ArchiveObjectStore) {
  return createArchiveWorker({ bucket: BUCKET, store, now: () => FIXED_NOW });
}

describe('createArchiveWorker（BE-ARC-02）', () => {
  test('五类必须归档 + ack 可选归档；Heartbeat/Media 不归档', async () => {
    const store = new MemoryObjectStore();
    const messages = [
      archiveMessage('telemetry'),
      archiveMessage('report'),
      archiveMessage('alarm'),
      archiveMessage('event'),
      archiveMessage('tamper', { withAudit: true }),
      archiveMessage('ack'),
      archiveMessage('heartbeat'),
      archiveMessage('media'),
    ];
    const result = await worker(store).archiveBatch(messages);

    const topicTypes = result.objects.map((o) => o.topicType).sort();
    assert.deepEqual(topicTypes, ['ack', 'alarm', 'event', 'report', 'tamper', 'telemetry']);
    assert.deepEqual(result.skipped, { heartbeat: 1, media: 1 }, 'Heartbeat 不归档、Media 走独立 Bucket');
    // 每个对象一个 manifest 旁挂
    assert.equal(store.keys().length, 12, '6 个数据对象 + 6 个 Manifest');
  });

  test('规定前缀：topic/customer/小时分区 + customerId 正确', async () => {
    const store = new MemoryObjectStore();
    const result = await worker(store).archiveBatch([
      archiveMessage('telemetry', { customerId: 'cust-42', occurredAt: '2026-08-28T10:45:00.000Z' }),
    ]);
    const [object] = result.objects;
    assert.match(
      object.key,
      /^raw\/topic_type=telemetry\/customer_id=cust-42\/year=2026\/month=08\/day=28\/hour=10\/part-[0-9a-f]{16}\.json\.gz$/,
      '规定前缀（customerId 正确）',
    );
    assert.equal(object.manifestKey, object.key.replace(/\.json\.gz$/, '.manifest.json'));
  });

  test('解压后每行是原始可验证 JSON（原始 Payload + audit.hash 完整内嵌）', async () => {
    const store = new MemoryObjectStore();
    const source = archiveMessage('tamper', { withAudit: true });
    const result = await worker(store).archiveBatch([source]);
    const [object] = result.objects;

    const lines = store.ndjsonLines(object.key);
    assert.equal(lines.length, 1);
    const line = lines[0] as Record<string, unknown>;
    assert.equal(line.eventId, source.eventId);
    const raw = line.payload as Record<string, unknown>;
    assert.deepEqual(raw, (source.payload as Record<string, unknown>).payload, '原始上行 Payload 完整内嵌');
    assert.equal((raw.audit as Record<string, unknown>).hash, 'c'.repeat(64), 'audit.hash 随行保留（可验证）');
    assert.equal(line.auditHash, 'c'.repeat(64));
  });

  test('Manifest 字段完整：记录数/时间范围/序号范围/SHA-256/Schema 版本/Worker 版本/eventIds', async () => {
    const store = new MemoryObjectStore();
    const messages = [
      archiveMessage('telemetry', { seq: 100, occurredAt: '2026-08-28T10:01:00.000Z', eventId: 'evt-m-1' }),
      archiveMessage('telemetry', { seq: 102, occurredAt: '2026-08-28T10:59:00.000Z', eventId: 'evt-m-2' }),
      archiveMessage('telemetry', { seq: 101, occurredAt: '2026-08-28T10:30:00.000Z', eventId: 'evt-m-3' }),
    ];
    const result = await worker(store).archiveBatch(messages);
    const [object] = result.objects;
    assert.equal(object.recordCount, 3);

    const manifest = store.json(object.manifestKey);
    assert.equal(manifest.manifestVersion, '1.0');
    assert.equal(manifest.bucket, BUCKET);
    assert.equal(manifest.key, object.key);
    assert.equal(manifest.topicType, 'telemetry');
    assert.equal(manifest.customerId, 'cust-1');
    assert.equal(manifest.windowStartUtc, '2026-08-28T10:00:00Z');
    assert.equal(manifest.recordCount, 3);
    assert.equal(manifest.occurredAtMin, '2026-08-28T10:01:00.000Z', '时间范围最小值');
    assert.equal(manifest.occurredAtMax, '2026-08-28T10:59:00.000Z', '时间范围最大值');
    assert.equal(manifest.seqMin, 100, '序号范围最小值');
    assert.equal(manifest.seqMax, 102, '序号范围最大值');
    assert.deepEqual(manifest.schemaVersions, ['1.0'], 'Schema 版本');
    assert.equal(manifest.workerVersion, 'archive-worker@1.0.0', 'Worker 版本');
    assert.deepEqual(manifest.eventIds, ['evt-m-1', 'evt-m-3', 'evt-m-2'], '按 occurredAt 稳定排序');
    assert.equal(manifest.createdAt, FIXED_NOW.toISOString());
  });

  test('对象 Hash 可复算：manifest.sha256 == 对存储 GZIP 字节重算', async () => {
    const store = new MemoryObjectStore();
    const result = await worker(store).archiveBatch([archiveMessage('report')]);
    const [object] = result.objects;
    const bytes = store.objects.get(object.key);
    assert.ok(bytes);
    const recomputed = createHash('sha256')
      .update(bytes as Uint8Array)
      .digest('hex');
    assert.equal(recomputed, object.sha256, '对象 Hash 可复算');
    assert.equal(store.json(object.manifestKey).sha256, recomputed);
  });

  test('重复事件不产生逻辑重复：批内去重一行；同批次重跑同 Key 同字节覆盖', async () => {
    const store = new MemoryObjectStore();
    const duplicate = archiveMessage('event', { eventId: 'evt-dup-1' });
    const batch = [duplicate, archiveMessage('event', { eventId: 'evt-dup-2' }), duplicate];

    const first = await worker(store).archiveBatch(batch);
    assert.equal(first.deduplicated, 1, '批内重复投递去重');
    const [object] = first.objects;
    assert.equal(object.recordCount, 2);
    assert.equal(store.ndjsonLines(object.key).length, 2, '重复事件不产生重复行');
    const bytesAfterFirst = Buffer.from(store.objects.get(object.key) as Uint8Array).toString('base64');

    // 同批次重跑（进程中断恢复）：相同 Key 相同字节覆盖写
    const rerun = await worker(store).archiveBatch(batch);
    assert.equal(rerun.deduplicated, 1);
    assert.deepEqual(
      rerun.objects.map((o) => o.key),
      [object.key],
      '重跑派生相同 part Key（覆盖写，不生新对象）',
    );
    assert.equal(
      Buffer.from(store.objects.get(object.key) as Uint8Array).toString('base64'),
      bytesAfterFirst,
      '重跑字节一致',
    );
    assert.equal(rerun.objects[0]?.sha256, object.sha256, '重跑 Hash 一致');
    assert.equal(store.keys().filter((k) => k.endsWith('.json.gz')).length, 1, '逻辑上仍只有一个归档对象');
  });

  test('跨 customer/小时/topic 正确分组为独立对象', async () => {
    const store = new MemoryObjectStore();
    const result = await worker(store).archiveBatch([
      archiveMessage('telemetry', { customerId: 'cust-a', occurredAt: '2026-08-28T10:10:00.000Z' }),
      archiveMessage('telemetry', { customerId: 'cust-a', occurredAt: '2026-08-28T11:10:00.000Z' }),
      archiveMessage('telemetry', { customerId: 'cust-b', occurredAt: '2026-08-28T10:20:00.000Z' }),
      archiveMessage('alarm', { customerId: 'cust-a', occurredAt: '2026-08-28T10:30:00.000Z' }),
    ]);
    assert.equal(result.objects.length, 4, 'topic×customer×小时 四个分组');
    for (const object of result.objects) {
      assert.equal(store.ndjsonLines(object.key).length, 1);
    }
  });
});
