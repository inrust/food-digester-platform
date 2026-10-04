import { observeDataPathPhase, setDataPathMessage } from '@fdp/observability';
/**
 * BE-IOT-02 Ingestion 通用校验管线（框架无关核心）。
 *
 * 处理链（按序）：Envelope 结构 → 身份/台账解析 → DEC-013 audit.hash → 兼容格式规范化
 * → CT-03 正式 Schema（含字段范围）→ 时钟偏差。
 * 输出 ValidatedMessage 供业务分发（BE-IOT-04 等；本任务不处理具体消息业务）。
 */
import type { DbClient } from '@fdp/database';
import {
  PayloadNormalizationError,
  normalizeMqttPayload,
  verifyAuditHash,
} from '@fdp/contracts/mqtt/payload-normalization.js';
import { parseEnvelope } from './envelope.js';
import type { IngressEnvelope } from './envelope.js';
import { resolveDeviceContext } from './identity.js';
import type { DeviceContext } from './identity.js';
import { assertClockSkew, createSchemaValidator } from './schema.js';
import type { SchemaValidator } from './schema.js';
import { quarantineError } from './errors.js';

export interface ValidatedMessage {
  readonly envelope: IngressEnvelope;
  /** SQS 记录中的原始 JSON 文本；Raw Archive 原样保存，不参与业务字段映射。 */
  readonly rawBody: string;
  /** 仅剥离五个 Envelope 字段后的原始 Payload，不受 DEC-013 规范化修改。 */
  readonly rawPayload: Readonly<Record<string, unknown>>;
  /** 业务 Schema 校验、receipt Hash 与 Handler 映射使用的规范化 Payload。 */
  readonly normalizedPayload: Readonly<Record<string, unknown>>;
  readonly device: DeviceContext;
  /** CT-03 meta.id（全局唯一消息 ID，BE-IOT-03 幂等键组成部分）。 */
  readonly messageId: string;
  /** CT-03 meta.ts（设备自报时间，已过时钟偏差校验）。 */
  readonly occurredAt: string;
  readonly data: Record<string, unknown>;
  readonly audit: Record<string, unknown> | null;
}

export interface IngestPipelineDeps {
  readonly client: DbClient;
  /** 时钟偏差容忍秒数（缺省 300）。 */
  readonly clockSkewToleranceSeconds?: number;
  readonly schemaValidator?: SchemaValidator;
}

const DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS = 300;
const AUDITED_TOPIC_TYPES = new Set(['telemetry', 'report', 'tamper']);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function normalizeContractPayload(envelope: IngressEnvelope): IngressEnvelope {
  try {
    if (AUDITED_TOPIC_TYPES.has(envelope.iotType) && !verifyAuditHash(envelope.payload)) {
      throw quarantineError('AUDIT_HASH_MISMATCH', 'audit.hash', 'audit.hash must equal SHA-256(RFC8785({meta,data}))');
    }
    return {
      ...envelope,
      payload: normalizeMqttPayload(envelope.iotType, envelope.payload, envelope.iotReceivedAt),
    };
  } catch (error) {
    if (error instanceof PayloadNormalizationError) {
      throw quarantineError('SCHEMA_VIOLATION', error.path, `${error.code}: ${error.message}`);
    }
    throw error;
  }
}

export async function validateRecord(deps: IngestPipelineDeps, rawBody: string): Promise<ValidatedMessage> {
  const parsed = await observeDataPathPhase('envelope', async () => parseEnvelope(rawBody));
  const rawPayload = deepFreeze(structuredClone(parsed.payload));
  const device = await observeDataPathPhase('identity', () => resolveDeviceContext(deps.client, parsed));
  const envelope = await observeDataPathPhase('payload-validation', async () => {
    const envelope = normalizeContractPayload(parsed);
    const validator = deps.schemaValidator ?? createSchemaValidator();
    validator.validatePayload(envelope);
    assertClockSkew(envelope, deps.clockSkewToleranceSeconds ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS);
    return envelope;
  });
  const normalizedPayload = deepFreeze(envelope.payload);

  const meta = envelope.payload.meta as Record<string, unknown>;
  setDataPathMessage({
    deviceId: device.deviceId,
    messageId: String(meta.id),
    topicType: envelope.iotType,
    seq: Number(meta.seq),
    receivedAtMs: envelope.iotReceivedAt,
    occurredAtMs: Date.parse(String(meta.ts)),
  });
  return {
    envelope,
    rawBody,
    rawPayload,
    normalizedPayload,
    device,
    messageId: String(meta.id),
    occurredAt: String(meta.ts),
    data: (envelope.payload.data ?? {}) as Record<string, unknown>,
    audit: (envelope.payload.audit ?? null) as Record<string, unknown> | null,
  };
}
