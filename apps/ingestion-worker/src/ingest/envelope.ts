/**
 * BE-IOT-02 Envelope 解析与结构校验（契约：contracts/iot/ingress-envelope.schema.json，BE-IOT-01）。
 *
 * 仅做 Envelope 结构判定（五个 iot* 上下文字段）；Payload 业务 Schema 校验由 schema.ts 负责。
 * 所有失败均为不可重试（QUARANTINE）并保留原文。
 */
import { quarantineError } from './errors.js';

export interface IngressEnvelope {
  readonly iotTopic: string;
  readonly iotDeviceId: string;
  readonly iotType: string;
  /** Broker 接收时间（epoch 毫秒）。 */
  readonly iotReceivedAt: number;
  /** 发布者证书 ARN。 */
  readonly iotPrincipal: string;
  /** 原始 Payload（顶层平铺字段，不含 iot* 保留字段）。 */
  readonly payload: Record<string, unknown>;
}

const TOPIC_PATTERN = /^bnx\/device\/[^/]+\/(heartbeat|telemetry|report|alarm|event|ack|tamper|media)$/;

export function parseEnvelope(rawBody: string): IngressEnvelope {
  let doc: unknown;
  try {
    doc = JSON.parse(rawBody);
  } catch {
    throw quarantineError('INVALID_JSON', '(root)', 'message body is not valid JSON');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw quarantineError('INVALID_ENVELOPE', '(root)', 'message body must be a JSON object');
  }
  const record = doc as Record<string, unknown>;

  const iotTopic = record.iotTopic;
  if (typeof iotTopic !== 'string' || !TOPIC_PATTERN.test(iotTopic)) {
    throw quarantineError('INVALID_ENVELOPE', 'iotTopic', 'iotTopic missing or not an uplink topic');
  }
  const iotDeviceId = record.iotDeviceId;
  if (typeof iotDeviceId !== 'string' || iotDeviceId.length === 0 || iotDeviceId.includes('/')) {
    throw quarantineError('INVALID_ENVELOPE', 'iotDeviceId', 'iotDeviceId missing or malformed');
  }
  const iotType = record.iotType;
  if (typeof iotType !== 'string' || iotTopic.split('/')[3] !== iotType) {
    throw quarantineError('INVALID_ENVELOPE', 'iotType', 'iotType missing or inconsistent with iotTopic');
  }
  const iotReceivedAt = record.iotReceivedAt;
  if (typeof iotReceivedAt !== 'number' || !Number.isInteger(iotReceivedAt) || iotReceivedAt < 0) {
    throw quarantineError('INVALID_ENVELOPE', 'iotReceivedAt', 'iotReceivedAt must be a non-negative epoch ms');
  }
  const iotPrincipal = record.iotPrincipal;
  if (typeof iotPrincipal !== 'string' || iotPrincipal.length === 0) {
    throw quarantineError('INVALID_ENVELOPE', 'iotPrincipal', 'iotPrincipal missing');
  }

  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!key.startsWith('iot')) payload[key] = value;
  }
  return { iotTopic, iotDeviceId, iotType, iotReceivedAt, iotPrincipal, payload };
}
