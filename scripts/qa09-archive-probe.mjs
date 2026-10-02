import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const hash = (b) => createHash('sha256').update(b).digest('hex');
function demand(ok, code) {
  if (!ok) throw Error(code);
}
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') +
    '}'
  );
}
export function validateArchivePlan(p) {
  demand(
    /^qa09-[a-f0-9]{16}$/.test(p.prefix) &&
      p.devices?.length === 10 &&
      new Set(p.devices).size === 10 &&
      p.devices.every((d) => new RegExp('^' + p.prefix + '-[0-9]{2}$').test(d)),
    'INVALID_ARCHIVE_SCOPE',
  );
  demand(
    p.customers?.length === 2 && new Set(p.customers).size === 2 && p.customers.every((c) => /^[a-f0-9-]{36}$/.test(c)),
    'INVALID_ARCHIVE_CUSTOMERS',
  );
  demand(
    p.published?.length === 30 &&
      new Set(p.published.map((p) => p.messageId)).size === 30 &&
      p.published.filter((m) => m.type === 'telemetry').length === 20 &&
      p.published.every(
        (m) =>
          p.devices.includes(m.deviceId) &&
          /^[a-f0-9]{64}$/.test(m.payloadSha256) &&
          /^[a-f0-9]{64}$/.test(m.bodySha256),
      ),
    'INVALID_PUBLISH_LEDGER',
  );
  demand(
    p.outbox?.length >= 20 &&
      p.outbox.every((r) => /^[a-f0-9-]{36}$/.test(r.id) && /^[a-f0-9]{64}$/.test(r.rawBodySha256)),
    'INVALID_OUTBOX_LEDGER',
  );
}
export function verifyArchiveObjects(plan, objects) {
  validateArchivePlan(plan);
  demand(objects.length <= 200, 'ARCHIVE_LIMIT_EXCEEDED');
  const checks = [],
    archiveObjects = [],
    found = new Set();
  for (const object of objects) {
    demand(
      plan.customers.some((c) =>
        ['heartbeat', 'telemetry'].some((t) => object.key.startsWith(`raw/topic_type=${t}/customer_id=${c}/`)),
      ) && object.key.endsWith('.json.gz'),
      'OBJECT_SCOPE_MISMATCH',
    );
    demand(object.bytes.length <= 1048576, 'ARCHIVE_SIZE_EXCEEDED');
    const lines = gunzipSync(object.bytes, { maxOutputLength: 4194304 }).toString().trim().split('\n').map(JSON.parse);
    for (const line of lines) {
      demand(plan.devices.includes(line.deviceId), 'ARCHIVE_DEVICE_SCOPE_MISMATCH');
      const row = plan.outbox.find((r) => r.id === line.eventId),
        published = plan.published.find((r) => r.deviceId === line.deviceId && r.messageId === line.messageId);
      demand(
        row &&
          published &&
          row.rawBodySha256 === hash(line.rawBody) &&
          published.payloadSha256 === hash(canonical(line.payload)) &&
          JSON.stringify(JSON.parse(line.rawBody).meta) === JSON.stringify(line.payload.meta),
        'ARCHIVE_ORIGINAL_BYTES_MISMATCH',
      );
      demand(!found.has(line.messageId), 'DUPLICATE_ARCHIVE_MESSAGE');
      found.add(line.messageId);
      checks.push({
        id: 'archive-original-' + line.eventId,
        result: 'PASS',
        objectKey: object.key,
        eventId: line.eventId,
        rawBodySha256: hash(line.rawBody),
        payloadSha256: hash(canonical(line.payload)),
      });
    }
    archiveObjects.push({ key: object.key, compressedSha256: hash(object.bytes), records: lines.length });
  }
  demand(
    plan.published.filter((p) => p.type === 'telemetry').every((p) => found.has(p.messageId)),
    'TELEMETRY_ARCHIVE_MISSING',
  );
  return {
    schema: 'fdp-qa09-archive-probe/v1',
    completed: true,
    checks,
    archiveObjects,
    archivedMessages: found.size,
    allTelemetryArchived: true,
  };
}
