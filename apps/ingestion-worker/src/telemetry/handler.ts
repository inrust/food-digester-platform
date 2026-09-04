/**
 * BE-IOT-05 Telemetry Handler：13 项指标的聚合输入/增量摘要 + S3 归档链路 outbox。
 *
 * 处理链（输入为 BE-IOT-02 已校验消息；字段单位与范围由 CT-03 Schema 把关，违规在管线即隔离）：
 * 1. BE-IOT-03 receipt 幂等：重复消息跳过（合法记录恰好一个归档事件由幂等键保证）；
 * 2. 业务写入（同事务）：
 *    - 聚合输入：telemetry_hourly 整点窗口增量合并（最小窗口状态；原始 Telemetry 不长期写 RDS）；
 *    - 归档 outbox：恰好一个 ARCHIVE 事件携带原始 Payload + payloadHash + audit.hash，
 *      由归档分发器写入 S3（本任务不直接写 S3）；
 * 3. 耗材边界（DEC-008）：冻结后的 Telemetry Schema 未定义任何耗材字段
 *    （contracts/mqtt/schemas/telemetry.schema.json 仅 13 项指标），故不更新耗材投影；
 *    不得根据时间、设备运行次数或原型示例值自行推算耗材百分比。
 *
 * 功能边界：不定义设备传感器算法和 ESG 核证口径。
 */
import type { DbClient } from '@fdp/database';
import { quarantineError } from '../ingest/errors.js';
import { hashPayload, processWithReceipt } from '../ingest/receipt.js';
import type { ReceiptOutcome } from '../ingest/receipt.js';
import type { ValidatedMessage } from '../ingest/pipeline.js';
import { extractSamples, mergeHourlyAggregate } from './repository.js';

export interface TelemetryHandlerDeps {
  readonly client: DbClient;
}

export interface TelemetryHandleResult {
  /** false 表示非 telemetry 类型消息（分发器不应路由到此）。 */
  readonly handled: boolean;
  readonly outcome: ReceiptOutcome | undefined;
  /** 聚合窗口起点（整点 UTC）。 */
  readonly bucketStart: Date | undefined;
  /** 合并后窗口样本数（重复消息为 undefined）。 */
  readonly sampleCount: number | undefined;
  /** 本次是否写入归档 outbox 事件。 */
  readonly archived: boolean;
}

const NOT_HANDLED: TelemetryHandleResult = {
  handled: false,
  outcome: undefined,
  bucketStart: undefined,
  sampleCount: undefined,
  archived: false,
};

/** UTC 整点向下取整。 */
export function hourlyBucketStart(occurredAt: Date): Date {
  const bucket = new Date(occurredAt);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
}

interface OutboxDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

export function createTelemetryHandler(
  deps: TelemetryHandlerDeps,
): (message: ValidatedMessage) => Promise<TelemetryHandleResult> {
  return async (message) => {
    if (message.envelope.iotType !== 'telemetry') return NOT_HANDLED;

    const meta = message.envelope.payload.meta as Record<string, unknown>;
    const seq = Number(meta.seq);
    const occurredAt = new Date(message.occurredAt);
    const bucketStart = hourlyBucketStart(occurredAt);
    const deviceId = message.device.deviceId;
    const payloadHash = hashPayload(message.envelope.payload);

    const processed = await processWithReceipt(deps.client, {
      key: { deviceId, topicType: 'telemetry', seq },
      payloadHash,
      receivedAtMs: message.envelope.iotReceivedAt,
      business: async (tx) => {
        // 聚合输入要求 customerId（DB-01 telemetry_hourly 非空）；未分配客户的设备遥测
        // 隔离保留原文，待分配后可由 Replay 重建（不静默丢聚合）
        if (!message.device.customerId) {
          throw quarantineError(
            'UNKNOWN_DEVICE',
            'device.customerId',
            'device has no customer assignment; hourly aggregate requires customerId',
          );
        }
        const aggregate = await mergeHourlyAggregate(tx, {
          deviceId,
          customerId: message.device.customerId,
          bucketStart,
          samples: extractSamples(message.data),
        });
        // 归档 outbox：原始 Payload 进入 S3 归档链路（含 audit.hash 供核对，DEC-002）
        const outbox = (tx as unknown as Record<string, unknown>).outboxEvent as OutboxDelegate;
        await outbox.create({
          data: {
            eventType: 'ARCHIVE',
            aggregateType: 'device',
            aggregateId: deviceId,
            payload: {
              archiveClass: 'MQTT_RAW',
              envelopeVersion: '1.0',
              aggregateId: deviceId,
              topicType: 'telemetry',
              messageId: message.messageId,
              deviceId,
              customerId: message.device.customerId,
              occurredAt: message.occurredAt,
              receivedAtMs: message.envelope.iotReceivedAt,
              payloadHash,
              auditHash: (message.audit as Record<string, unknown> | null)?.hash ?? null,
              payload: message.envelope.payload,
            },
          },
        });
        return aggregate;
      },
    });

    if (processed.outcome === 'DUPLICATE_SKIPPED') {
      return { handled: true, outcome: processed.outcome, bucketStart, sampleCount: undefined, archived: false };
    }
    return {
      handled: true,
      outcome: processed.outcome,
      bucketStart,
      sampleCount: processed.result?.sampleCount,
      archived: true,
    };
  };
}
