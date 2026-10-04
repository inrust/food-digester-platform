import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { canonical, verifyArchiveObjects } from './qa09-recovered-archive-probe.mjs';
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
test('recovery excludes explicitly later own SLO records without waiving original bytes or deadlines', () => {
  const f = fixture();
  const plan = { ...f.plan, allowLaterOwnSloRecords: true, archiveDeadlineAt: '2026-10-04T13:11:00Z' };
  const timely = f.objects.map((x) => ({ ...x, lastModified: '2026-10-04T13:10:59Z' }));
  const extra = {
    key: `raw/topic_type=telemetry/customer_id=${plan.customers[0]}/extra.json.gz`,
    lastModified: '2026-10-04T13:20:00Z',
    bytes: gzipSync(
      JSON.stringify({
        deviceId: plan.devices[0],
        messageId: 'later-slo',
        eventId: 'unrelated-later-event',
        payload: {},
        rawBody: '{}',
      }),
    ),
  };
  assert.equal(verifyArchiveObjects(plan, [...timely, extra]).archivedMessages, 20);
  assert.throws(() => verifyArchiveObjects({ ...plan, allowLaterOwnSloRecords: false }, [...timely, extra]));
  assert.throws(() => verifyArchiveObjects(plan, [...timely.slice(1), extra]), /ARCHIVE_MISSING/);
  assert.throws(
    () =>
      verifyArchiveObjects(plan, [{ ...timely[0], lastModified: '2026-10-04T13:11:01Z' }, ...timely.slice(1), extra]),
    /DEADLINE_MISSED/,
  );
  assert.throws(() => verifyArchiveObjects(plan, [...timely, timely[0]]), /DUPLICATE/);
});
test('later record exemption never includes other devices or customers', () => {
  const f = fixture();
  const plan = { ...f.plan, allowLaterOwnSloRecords: true };
  const extra = {
    key: f.objects[0].key,
    bytes: gzipSync(JSON.stringify({ deviceId: 'existing-device', messageId: 'later', payload: {}, rawBody: '{}' })),
  };
  assert.throws(() => verifyArchiveObjects(plan, [...f.objects, extra]), /DEVICE_SCOPE_MISMATCH/);
  assert.throws(
    () =>
      verifyArchiveObjects(plan, [
        ...f.objects,
        { ...extra, key: 'raw/topic_type=telemetry/customer_id=foreign/extra.json.gz' },
      ]),
    /OBJECT_SCOPE_MISMATCH/,
  );
});
