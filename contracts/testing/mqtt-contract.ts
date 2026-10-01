import { readFileSync } from 'node:fs';
import { createAjv } from './device-contract.js';
import { verifyAuditHash } from '../mqtt/payload-normalization.js';
import { TOPIC_CATALOG } from '../mqtt/topics.js';
const ajv = createAjv();
const base = 'https://fdp.test/qa02/mqtt/';
for (const type of ['common', ...Object.keys(TOPIC_CATALOG)]) {
  const schema = JSON.parse(readFileSync(new URL(`../mqtt/schemas/${type}.schema.json`, import.meta.url), 'utf8'));
  schema.$id = `${base}${type}.schema.json`;
  ajv.addSchema(schema);
}
export function assertMqttPayload(type: string, payload: unknown): void {
  if (!Object.hasOwn(TOPIC_CATALOG, type)) throw new Error('UNKNOWN_MQTT_TYPE');
  const validate = ajv.getSchema(`${base}${type}.schema.json`)!;
  if (!validate(payload)) throw new Error(`${type}: ${ajv.errorsText(validate.errors)}`);
  const envelope = payload as { meta: unknown; data: Record<string, unknown>; audit?: unknown };
  if (['telemetry', 'report', 'tamper'].includes(type) && !verifyAuditHash(envelope))
    throw new Error('AUDIT_HASH_MISMATCH');
  if (type === 'ack') {
    const data = envelope.data;
    const command = data.objectType === 'COMMAND';
    const required = command ? ['commandId', 'command', 'result', 'executeTimeMs'] : ['otaTargetId', 'status'];
    const forbidden = command ? ['otaTargetId', 'status'] : ['commandId', 'command', 'result', 'executeTimeMs'];
    if (required.some((key) => data[key] === undefined) || forbidden.some((key) => data[key] !== undefined))
      throw new Error('ACK_DISCRIMINATOR_VIOLATION');
  }
}
