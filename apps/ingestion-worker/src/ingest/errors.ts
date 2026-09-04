/**
 * BE-IOT-02 Ingestion 管线错误分类。
 *
 * - QUARANTINE：不可重试的契约/身份/时钟错误 → 隔离到 Quarantine 队列（保存原文 + 错误路径），
 *   不进入重试（避免坏消息阻塞批次）；
 * - TRANSIENT：瞬时 AWS/DB 错误 → 交给 SQS 重试（reportBatchItemFailures），耗尽后进 Ingress DLQ。
 */
export type IngestErrorClassification = 'TRANSIENT' | 'QUARANTINE';

export type IngestErrorType =
  | 'INVALID_JSON'
  | 'INVALID_ENVELOPE'
  | 'UNKNOWN_DEVICE'
  | 'IDENTITY_VIOLATION'
  | 'SCHEMA_VIOLATION'
  | 'AUDIT_HASH_MISMATCH'
  | 'CLOCK_SKEW'
  | 'PAYLOAD_CONFLICT'
  | 'INVALID_REPORT'
  | 'UNKNOWN_COMMAND'
  | 'COMMAND_MISMATCH'
  | 'INVALID_COMMAND_STATE'
  | 'UNKNOWN_OTA_TARGET'
  | 'OTA_TARGET_MISMATCH'
  | 'INVALID_OTA_STATE';

export class IngestError extends Error {
  override readonly name = 'IngestError';
  readonly classification: IngestErrorClassification;
  readonly errorType: IngestErrorType;
  /** 稳定点分错误路径（CT-03 校验器语义；Envelope/身份错误为 iot* 字段或 '(root)'）。 */
  readonly errorPath: string;

  constructor(
    classification: IngestErrorClassification,
    errorType: IngestErrorType,
    errorPath: string,
    message: string,
  ) {
    super(message);
    this.classification = classification;
    this.errorType = errorType;
    this.errorPath = errorPath;
  }
}

export function quarantineError(errorType: IngestErrorType, errorPath: string, message: string): IngestError {
  return new IngestError('QUARANTINE', errorType, errorPath, message);
}

export function transientError(message: string): IngestError {
  return new IngestError('TRANSIENT', 'INVALID_ENVELOPE', '(root)', message);
}
