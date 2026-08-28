/**
 * BE-IOT-02 Ingestion 通用校验管线（框架无关核心）。
 *
 * 处理链（按序）：Envelope 结构 → 身份/台账解析 → CT-03 Schema（含字段范围）→ 时钟偏差。
 * 输出 ValidatedMessage 供业务分发（BE-IOT-04 等；本任务不处理具体消息业务）。
 */
import type { DbClient } from '@fdp/database';
import { parseEnvelope } from './envelope.js';
import type { IngressEnvelope } from './envelope.js';
import { resolveDeviceContext } from './identity.js';
import type { DeviceContext } from './identity.js';
import { assertClockSkew, createSchemaValidator } from './schema.js';
import type { SchemaValidator } from './schema.js';

export interface ValidatedMessage {
  readonly envelope: IngressEnvelope;
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

export async function validateRecord(deps: IngestPipelineDeps, rawBody: string): Promise<ValidatedMessage> {
  const envelope = parseEnvelope(rawBody);
  const device = await resolveDeviceContext(deps.client, envelope);
  const validator = deps.schemaValidator ?? createSchemaValidator();
  validator.validatePayload(envelope);
  assertClockSkew(envelope, deps.clockSkewToleranceSeconds ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS);

  const meta = envelope.payload.meta as Record<string, unknown>;
  return {
    envelope,
    device,
    messageId: String(meta.id),
    occurredAt: String(meta.ts),
    data: (envelope.payload.data ?? {}) as Record<string, unknown>,
    audit: (envelope.payload.audit ?? null) as Record<string, unknown> | null,
  };
}
