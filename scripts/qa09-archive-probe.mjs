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
  const total = p.profile === 'QA07_QUICK_REAL_MQTT' ? 950 : p.profile === 'QA09_REPORT_CONSISTENCY' ? 32 : 30;
  const telemetry = p.profile === 'QA07_QUICK_REAL_MQTT' ? 920 : 20;
  demand(
    p.profile === undefined || ['QA07_QUICK_REAL_MQTT', 'QA09_REPORT_CONSISTENCY'].includes(p.profile),
    'INVALID_ARCHIVE_PROFILE',
  );
  demand(
    p.published?.length === total &&
      new Set(p.published.map((p) => p.messageId)).size === total &&
      p.published.filter((m) => m.type === 'telemetry').length === telemetry &&
      p.published.every(
        (m) =>
          p.devices.includes(m.deviceId) &&
          /^[a-f0-9]{64}$/.test(m.payloadSha256) &&
          /^[a-f0-9]{64}$/.test(m.bodySha256),
      ),
    'INVALID_PUBLISH_LEDGER',
  );
  if (p.profile === 'QA09_REPORT_CONSISTENCY')
    demand(
      p.published.filter((m) => m.type === 'report').length === 2 &&
        JSON.stringify(
          p.published
            .filter((m) => m.type === 'report')
            .map((m) => m.deviceId)
            .sort(),
        ) === JSON.stringify([p.devices[0], p.devices[5]].sort()),
      'EXACT_TWO_REPORTS_REQUIRED',
    );
  demand(
    p.outbox?.length >= (p.profile === 'QA09_REPORT_CONSISTENCY' ? 22 : telemetry) &&
      p.outbox.every((r) => /^[a-f0-9-]{36}$/.test(r.id) && /^[a-f0-9]{64}$/.test(r.rawBodySha256)),
    'INVALID_OUTBOX_LEDGER',
  );
}
export function verifyArchiveObjects(plan, objects) {
  validateArchivePlan(plan);
  demand(objects.length <= (plan.profile === 'QA07_QUICK_REAL_MQTT' ? 2000 : 200), 'ARCHIVE_LIMIT_EXCEEDED');
  if (plan.archiveDeadlineAt !== undefined)
    demand(Number.isFinite(Date.parse(plan.archiveDeadlineAt)), 'INVALID_ARCHIVE_DEADLINE');
  const checks = [],
    archiveObjects = [],
    found = new Set();
  for (const object of objects) {
    demand(
      plan.customers.some((c) =>
        ['heartbeat', 'telemetry', ...(plan.profile === 'QA09_REPORT_CONSISTENCY' ? ['report'] : [])].some((t) =>
          object.key.startsWith(`raw/topic_type=${t}/customer_id=${c}/`),
        ),
      ) && object.key.endsWith('.json.gz'),
      'OBJECT_SCOPE_MISMATCH',
    );
    if (plan.archiveDeadlineAt)
      demand(
        Number.isFinite(Date.parse(object.lastModified ?? '')) &&
          Date.parse(object.lastModified) <= Date.parse(plan.archiveDeadlineAt),
        'ARCHIVE_DRAIN_DEADLINE_MISSED',
      );
    demand(object.bytes.length <= 1048576, 'ARCHIVE_SIZE_EXCEEDED');
    const lines = gunzipSync(object.bytes, { maxOutputLength: 4194304 }).toString().trim().split('\n').map(JSON.parse);
    for (const line of lines) {
      demand(plan.devices.includes(line.deviceId), 'ARCHIVE_DEVICE_SCOPE_MISMATCH');
      const messageId =
        line.messageId ??
        (plan.profile === 'QA09_REPORT_CONSISTENCY' && line.topicType === 'report'
          ? line.payload?.meta?.id
          : undefined);
      const row = plan.outbox.find((r) => r.id === line.eventId),
        published = plan.published.find((r) => r.deviceId === line.deviceId && r.messageId === messageId);
      demand(
        row &&
          published &&
          row.rawBodySha256 === hash(line.rawBody) &&
          published.payloadSha256 === hash(canonical(line.payload)) &&
          JSON.stringify(JSON.parse(line.rawBody).meta) === JSON.stringify(line.payload.meta),
        'ARCHIVE_ORIGINAL_BYTES_MISMATCH',
      );
      if (plan.profile === 'QA09_REPORT_CONSISTENCY') {
        const envelope = JSON.parse(line.rawBody),
          contextKeys = ['iotTopic', 'iotDeviceId', 'iotType', 'iotReceivedAt', 'iotPrincipal'],
          rawPayload = Object.fromEntries(Object.entries(envelope).filter(([key]) => !contextKeys.includes(key)));
        demand(
          envelope.iotTopic === `bnx/device/${line.deviceId}/${line.topicType}` &&
            envelope.iotDeviceId === line.deviceId &&
            envelope.iotType === line.topicType &&
            Number.isInteger(envelope.iotReceivedAt) &&
            envelope.iotReceivedAt >= 0 &&
            envelope.iotReceivedAt === line.receivedAtMs &&
            typeof envelope.iotPrincipal === 'string' &&
            envelope.iotPrincipal.length > 0 &&
            hash(canonical(rawPayload)) === published.payloadSha256,
          'INGRESS_CONTEXT_OR_PAYLOAD_MISMATCH',
        );
      }
      demand(!found.has(messageId), 'DUPLICATE_ARCHIVE_MESSAGE');
      found.add(messageId);
      checks.push({
        id: 'archive-original-' + line.eventId,
        result: 'PASS',
        objectKey: object.key,
        eventId: line.eventId,
        rawBodySha256: hash(line.rawBody),
        payloadSha256: hash(canonical(line.payload)),
      });
    }
    if (plan.profile === 'QA09_REPORT_CONSISTENCY') {
      const m = object.manifest;
      demand(
        m?.manifestVersion === '2.0' &&
          m.archiveClass === 'MQTT_RAW' &&
          m.bucket === 'fdp-test-raw-065986019555' &&
          m.key === object.key &&
          m.sha256 === hash(object.bytes) &&
          m.recordCount === lines.length &&
          JSON.stringify(m.eventIds) === JSON.stringify(lines.map((l) => l.eventId)) &&
          lines.every(
            (l) =>
              l.topicType === m.topicType &&
              l.customerId === m.customerId &&
              object.key.startsWith(`raw/topic_type=${m.topicType}/customer_id=${m.customerId}/`),
          ),
        'MANIFEST_ARCHIVE_BINDING_DRIFT',
      );
    }
    archiveObjects.push({
      key: object.key,
      ...(object.lastModified ? { lastModified: object.lastModified } : {}),
      compressedSha256: hash(object.bytes),
      records: lines.length,
      ...(plan.profile === 'QA09_REPORT_CONSISTENCY'
        ? {
            manifestKey: object.key.replace(/\.json\.gz$/, '.manifest.json'),
            manifestProjectionSha256: hash(JSON.stringify(object.manifest)),
            manifestMatched: true,
          }
        : {}),
    });
  }
  demand(
    plan.published
      .filter((p) => p.type === 'telemetry' || (plan.profile === 'QA09_REPORT_CONSISTENCY' && p.type === 'report'))
      .every((p) => found.has(p.messageId)),
    'TELEMETRY_ARCHIVE_MISSING',
  );
  return {
    schema: 'fdp-qa09-archive-probe/v1',
    completed: true,
    checks,
    archiveObjects,
    archivedMessages: found.size,
    allTelemetryArchived: true,
    ...(plan.profile === 'QA09_REPORT_CONSISTENCY' ? { allReportsArchived: true } : {}),
  };
}
