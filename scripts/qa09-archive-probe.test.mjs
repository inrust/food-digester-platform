import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { canonical, validateArchivePlan, verifyArchiveObjects } from './qa09-archive-probe.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
function fixture() {
  const prefix = 'qa09-1234567890abcdef',
    devices = Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`),
    customers = [
      'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12),
      'b'.repeat(8) + '-bbbb-bbbb-bbbb-' + 'b'.repeat(12),
    ];
  const published = [],
    outbox = [],
    objects = [];
  for (let i = 0; i < 10; i++)
    for (let seq = 0; seq < 3; seq++) {
      const type = seq === 0 ? 'heartbeat' : 'telemetry',
        messageId = `${devices[i]}-${seq}`,
        payload = { meta: { deviceId: devices[i], messageId }, sensor: { value: i } },
        rawBody = JSON.stringify(payload),
        id = `00000000-0000-0000-0000-${String(i * 3 + seq).padStart(12, '0')}`;
      published.push({
        deviceId: devices[i],
        messageId,
        type,
        bodySha256: hash(rawBody),
        payloadSha256: hash(canonical(payload)),
      });
      if (type === 'telemetry') {
        outbox.push({ id, rawBodySha256: hash(rawBody) });
        objects.push({
          key: `raw/topic_type=telemetry/customer_id=${customers[i < 5 ? 0 : 1]}/part-${id}.json.gz`,
          bytes: gzipSync(JSON.stringify({ deviceId: devices[i], messageId, eventId: id, payload, rawBody })),
        });
      }
    }
  return { plan: { prefix, devices, customers, published, outbox }, objects };
}
test('real gzip bytes bind exact own devices, raw outbox hash and canonical published hash', () => {
  const { plan, objects } = fixture(),
    r = verifyArchiveObjects(plan, objects);
  assert.equal(r.allTelemetryArchived, true);
  assert.equal(r.archivedMessages, 20);
  assert.equal(r.checks.length, 20);
  assert.equal(r.archiveObjects.length, 20);
  assert.ok(r.checks.every((c) => c.payloadSha256));
  assert.ok(!JSON.stringify(r).includes('rawBody"'));
});
test('scope expansion, unknown customer/device, modified bytes and missing archive fail closed', () => {
  const f = fixture();
  const bad = structuredClone(f.plan);
  bad.devices[0] = 'existing-device';
  assert.throws(() => validateArchivePlan(bad));
  const foreign = [{ ...f.objects[0], key: 'raw/topic_type=telemetry/customer_id=foreign/part.json.gz' }];
  assert.throws(() => verifyArchiveObjects(f.plan, foreign), /SCOPE_MISMATCH/);
  assert.throws(() => verifyArchiveObjects(f.plan, f.objects.slice(1)), /ARCHIVE_MISSING/);
  const objects = structuredClone(f.objects);
  objects[0].bytes = gzipSync(
    JSON.stringify({
      deviceId: f.plan.devices[0],
      messageId: f.plan.published[1].messageId,
      eventId: f.plan.outbox[0].id,
      payload: { changed: true },
      rawBody: 'changed',
    }),
  );
  assert.throws(() => verifyArchiveObjects(f.plan, objects), /BYTES_MISMATCH/);
  assert.throws(() => verifyArchiveObjects(f.plan, [...f.objects, f.objects[0]]), /DUPLICATE/);
});

test('IoT normalized raw body binds outbox bytes while original publication binds canonical payload', () => {
  const f = fixture();
  f.plan.published.forEach(
    (p) => (p.bodySha256 = hash('different JSON serialization with equivalent canonical content')),
  );
  assert.equal(verifyArchiveObjects(f.plan, f.objects).allTelemetryArchived, true);
});
