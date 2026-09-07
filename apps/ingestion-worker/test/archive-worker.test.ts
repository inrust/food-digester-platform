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
  options: {
    customerId?: string;
    seq?: number;
    occurredAt?: string;
    eventId?: string;
    withAudit?: boolean;
    rawBody?: string;
  } = {},
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
      archiveClass: 'MQTT_RAW',
      envelopeVersion: '1.0',
      aggregateId: 'dev-arc-1',
      topicType,
      messageId: (payload.meta as Record<string, unknown>).id,
      deviceId: 'dev-arc-1',
      customerId: options.customerId ?? 'cust-1',
      occurredAt,
      receivedAtMs: Date.parse(occurredAt),
      payloadHash: 'd'.repeat(64),
      auditHash: options.withAudit ? 'c'.repeat(64) : null,
      rawBody: options.rawBody ?? JSON.stringify(payload),
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
    const originalBody = ' { "meta": { "id": "raw-spacing" }, "data": { "sample": true } } ';
    const source = archiveMessage('tamper', { withAudit: true, rawBody: originalBody });
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
    assert.equal(line.rawBody, originalBody, 'S3 NDJSON 必须逐字符保留 IoT Rule 原始 Body');
  });

  test('Manifest 字段完整：记录数/时间范围/序号范围/SHA-256/Schema 版本/Worker 版本/eventIds', async () => {
    const store = new MemoryObjectStore();
    const messages = [
      archiveMessage('telemetry', { seq: 100, occurredAt: '2026-08-28T10:01:00.000Z', eventId: 'evt-m-1' }),
      archiveMessage('telemetry', { seq: 102, occurredAt: '2026-08-28T10:59:00.000Z', eventId: 'evt-m-2' }),
      archiveMessage('telemetry', { seq: 101, occurredAt: '2026-08-28T10:30:00.000Z', eventId: 'evt-m-3' }),
    ];
    const result = await worker(store).archiveBatch(messages);
    assert.equal(result.objects.length, 3, '每个 eventId 使用稳定单事件对象');
    const object = result.objects.find((item) =>
      item.key.includes(createHash('sha256').update('evt-m-1').digest('hex').slice(0, 16)),
    );
    assert.ok(object);
    assert.equal(object.recordCount, 1);

    const manifest = store.json(object.manifestKey);
    assert.equal(manifest.manifestVersion, '2.0');
    assert.equal(manifest.archiveClass, 'MQTT_RAW');
    assert.equal(manifest.sourceType, 'telemetry');
    assert.equal(manifest.bucket, BUCKET);
    assert.equal(manifest.key, object.key);
    assert.equal(manifest.topicType, 'telemetry');
    assert.equal(manifest.customerId, 'cust-1');
    assert.equal(manifest.windowStartUtc, '2026-08-28T10:00:00Z');
    assert.equal(manifest.recordCount, 1);
    assert.equal(manifest.occurredAtMin, '2026-08-28T10:01:00.000Z', '时间范围最小值');
    assert.equal(manifest.occurredAtMax, '2026-08-28T10:01:00.000Z', '单事件时间范围最大值');
    assert.equal(manifest.seqMin, 100, '序号范围最小值');
    assert.equal(manifest.seqMax, 100, '单事件序号范围最大值');
    assert.deepEqual(manifest.schemaVersions, ['1.0'], 'Schema 版本');
    assert.equal(manifest.workerVersion, 'archive-worker@2.0.0', 'Worker 版本');
    assert.deepEqual(manifest.eventIds, ['evt-m-1']);
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
    assert.equal(first.objects.length, 2);
    const object = first.objects.find((item) => store.ndjsonLines(item.key)[0]?.eventId === 'evt-dup-1');
    assert.ok(object);
    assert.equal(object.recordCount, 1);
    assert.equal(store.ndjsonLines(object.key).length, 1, '重复事件不产生重复行');
    const bytesAfterFirst = Buffer.from(store.objects.get(object.key) as Uint8Array).toString('base64');

    // 同批次重跑（进程中断恢复）：相同 Key 相同字节覆盖写
    const rerun = await worker(store).archiveBatch(batch);
    assert.equal(rerun.deduplicated, 1);
    assert.deepEqual(
      rerun.objects.map((o) => o.key),
      first.objects.map((item) => item.key),
      '重跑派生相同 part Key（覆盖写，不生新对象）',
    );
    assert.equal(
      Buffer.from(store.objects.get(object.key) as Uint8Array).toString('base64'),
      bytesAfterFirst,
      '重跑字节一致',
    );
    assert.equal(rerun.objects[0]?.sha256, object.sha256, '重跑 Hash 一致');
    assert.equal(store.keys().filter((k) => k.endsWith('.json.gz')).length, 2, '两个 eventId 各一个稳定对象');
  });

  test('跨批与并发幂等：[A,B] 后重试 [A] 仍只保留 A/B 两个稳定对象', async () => {
    const store = new MemoryObjectStore();
    const a = archiveMessage('telemetry', { eventId: 'evt-cross-a' });
    const b = archiveMessage('telemetry', { eventId: 'evt-cross-b' });
    const first = await worker(store).archiveBatch([a, b]);
    const [retry, concurrent] = await Promise.all([
      worker(store).archiveBatch([a]),
      worker(store).archiveBatch([b, a]),
    ]);
    assert.deepEqual(
      retry.objects.map((item) => item.key),
      [first.objects[0]?.key],
    );
    assert.deepEqual(concurrent.objects.map((item) => item.key).sort(), first.objects.map((item) => item.key).sort());
    assert.equal(store.keys().filter((key) => key.endsWith('.json.gz')).length, 2);
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

  test('DEC-016：License 领域事件与 OTA 发布/结果使用独立前缀，不进入 raw 分区', async () => {
    const store = new MemoryObjectStore();
    const base = {
      eventType: 'ARCHIVE',
      createdAt: '2026-09-04T10:58:43.000Z',
    };
    const messages: ArchiveEventMessage[] = [
      {
        ...base,
        eventId: 'evt-license-1',
        aggregateType: 'license',
        aggregateId: 'lic-1',
        payload: {
          archiveClass: 'DOMAIN_EVENT',
          envelopeVersion: '1.0',
          entityType: 'license',
          domainEventType: 'LICENSE_STATUS_CHANGED',
          aggregateId: 'lic-1',
          customerId: 'cust-1',
          occurredAt: '2026-09-04T10:10:00.000Z',
          data: { fromStatus: 'Draft', toStatus: 'Issued' },
        },
      },
      ...(['PUBLICATION', 'RESULT'] as const).map((recordType) => ({
        ...base,
        eventId: `evt-ota-${recordType.toLowerCase()}`,
        aggregateType: 'ota_target',
        aggregateId: 'target-1',
        payload: {
          archiveClass: 'OPERATION_RECORD',
          envelopeVersion: '1.0',
          operationType: 'ota',
          recordType,
          aggregateId: 'target-1',
          customerId: 'cust-1',
          occurredAt: '2026-09-04T10:20:00.000Z',
          data: { otaTargetId: 'target-1' },
        },
      })),
    ];
    const result = await worker(store).archiveBatch(messages);

    assert.equal(result.objects.length, 3);
    assert.ok(result.objects.some((item) => item.key.startsWith('domain/entity_type=license/')));
    assert.ok(
      result.objects.some((item) => item.key.startsWith('operations/operation_type=ota/record_type=publication/')),
    );
    assert.ok(result.objects.some((item) => item.key.startsWith('operations/operation_type=ota/record_type=result/')));
    assert.ok(result.objects.every((item) => !item.key.startsWith('raw/')));
    for (const item of result.objects) {
      assert.equal(store.json(item.manifestKey).archiveClass, item.archiveClass);
      assert.equal(store.ndjsonLines(item.key).length, 1);
    }
  });

  test('License/OTA 即使伪装为 topicType 也拒绝进入 MQTT_RAW', async () => {
    const store = new MemoryObjectStore();
    const result = await worker(store).archiveBatch([archiveMessage('license'), archiveMessage('ota')]);
    assert.deepEqual(result.objects, []);
    assert.deepEqual(result.skipped, { license: 1, ota: 1 });
  });

  test('DEC-016 Envelope 版本错误或跨类型字段混用时失败关闭', async () => {
    const store = new MemoryObjectStore();
    const wrongVersion = archiveMessage('telemetry');
    (wrongVersion.payload as Record<string, unknown>).envelopeVersion = '2.0';
    const mixed = archiveMessage('event');
    (mixed.payload as Record<string, unknown>).entityType = 'license';
    const result = await worker(store).archiveBatch([wrongVersion, mixed]);
    assert.deepEqual(result.objects, []);
    assert.deepEqual(result.skipped, { unknown: 2 });
  });
});
