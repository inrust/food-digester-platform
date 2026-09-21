/**
 * BE-IOT-02 SQS 批量消费 Handler（partial failure）。
 *
 * 语义：
 * - 每条记录独立经 validateRecord 校验；合法消息交给 onValidated 业务分发（缺省 no-op，
 *   具体业务归 BE-IOT-04 等后续任务）；
 * - QUARANTINE 错误 → 写 Quarantine（原文 + errorType + errorPath + Topic 上下文），
 *   视为已处理（不重试、不阻塞批次）；
 * - 其他异常（DB/AWS 瞬时错误）→ 记入 batchItemFailures 由 SQS 重试，耗尽后进 Ingress DLQ；
 * - 敏感字段不写日志：Quarantine 记录仅含原文与错误元数据，Handler 不输出 Payload 日志。
 */
import type { DbClient } from '@fdp/database';
import { IngestError } from './errors.js';
import { parseEnvelope } from './envelope.js';
import { validateRecord } from './pipeline.js';
import type { IngestPipelineDeps, ValidatedMessage } from './pipeline.js';

export interface SqsRecordLike {
  readonly messageId: string;
  readonly body: string;
}

export interface SqsBatchEventLike {
  readonly Records: readonly SqsRecordLike[];
}

export interface SqsBatchResponseLike {
  readonly batchItemFailures: { readonly itemIdentifier: string }[];
}

/** Quarantine 投递记录（原文 + 错误元数据；供隔离队列消费方/运维排查）。 */
export interface QuarantineRecord {
  readonly rawBody: string;
  readonly errorType: string;
  readonly errorPath: string;
  readonly iotTopic?: string;
  readonly iotDeviceId?: string;
  readonly reason: string;
}

export interface QuarantineSink {
  send(record: QuarantineRecord): Promise<void>;
}

export interface IngestionHandlerDeps extends IngestPipelineDeps {
  readonly client: DbClient;
  readonly quarantine: QuarantineSink;
  /** 业务分发扩展点（BE-IOT-08 createBusinessDispatcher 注入）；缺省 no-op。 */
  readonly onValidated?: (message: ValidatedMessage) => Promise<void>;
}

function envelopeContextOf(rawBody: string): Pick<QuarantineRecord, 'iotTopic' | 'iotDeviceId'> {
  try {
    const envelope = parseEnvelope(rawBody);
    return { iotTopic: envelope.iotTopic, iotDeviceId: envelope.iotDeviceId };
  } catch {
    return {};
  }
}

export function createIngestionHandler(
  deps: IngestionHandlerDeps,
): (event: SqsBatchEventLike) => Promise<SqsBatchResponseLike> {
  return async (event) => {
    const failures: { itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try {
        const message = await validateRecord(deps, record.body);
        await deps.onValidated?.(message);
      } catch (err) {
        if (err instanceof IngestError && err.classification === 'QUARANTINE') {
          console.warn(
            JSON.stringify({
              event: 'ingestion.quarantined',
              messageId: record.messageId,
              errorType: err.errorType,
              errorPath: err.errorPath,
              reason: err.message,
              ...envelopeContextOf(record.body),
            }),
          );
          try {
            await deps.quarantine.send({
              rawBody: record.body,
              errorType: err.errorType,
              errorPath: err.errorPath,
              reason: err.message,
              ...envelopeContextOf(record.body),
            });
          } catch {
            // 隔离投递自身失败属于当前记录的瞬时错误；继续处理同批后续记录。
            failures.push({ itemIdentifier: record.messageId });
          }
          continue; // 已隔离则成功；投递失败时当前记录已加入 partial failure
        }
        if (err instanceof IngestError && err.classification === 'TRANSIENT') {
          failures.push({ itemIdentifier: record.messageId });
          continue;
        }
        // 未知异常按瞬时错误处理（DB/AWS 抖动），交由 SQS 重试
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}
