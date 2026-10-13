import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHourlyReplayDedup } from './qa09-replay-dedup-assessment.mjs';
const prefix = 'qa09-1234567890abcdef';
const devices = Array.from({ length: 10 }, (_, i) => prefix + '-' + String(i + 1).padStart(2, '0'));
function frame() {
  return {
    readOnly: true,
    fingerprints: [
      { table: 'ingestion_receipts', count: '30', digest: 'a'.repeat(32) },
      { table: 'telemetry_hourly', count: '10', digest: 'b'.repeat(32) },
      { table: 'telemetry_daily', count: '0', digest: 'd41d8cd98f00b204e9800998ecf8427e' },
      { table: 'outbox_events', count: '20', digest: 'c'.repeat(32) },
    ],
    receipts: devices.flatMap((device_id) =>
      [
        ['heartbeat', 1],
        ['telemetry', 1],
        ['telemetry', 2],
      ].map(([topic_type, seq]) => ({ device_id, topic_type, seq, result: 'PROCESSED', payload_hash: 'd'.repeat(64) })),
    ),
    originalFingerprints: [
      { entity: 'devices', count: '0', digest: 'e'.repeat(32) },
      { entity: 'device_certificates', count: '0', digest: 'e'.repeat(32) },
    ],
  };
}
test('nonempty hourly/receipt/archive scope is independent of unexercised daily rollup; original full Gate stays unchanged', () => {
  const r = assessHourlyReplayDedup(frame(), structuredClone(frame()), devices);
  assert.equal(r.gate, 'PASS_HOURLY_ARCHIVE_DEDUP_SCOPE');
  assert.equal(r.dailyGate, 'NOT_RUN_NO_DAILY_ROWS');
  assert.equal(r.fullDedupGateChanged, false);
  assert.equal(r.fullQa09Accepted, false);
});
test('narrow proof refuses missing/empty/changed business rows, foreign devices, duplicate seq and outside drift', () => {
  for (const mutate of [
    (r) => {
      r.fingerprints[1].count = '0';
    },
    (r) => {
      r.fingerprints[3].digest = 'f'.repeat(32);
    },
    (r) => {
      r.receipts[0].device_id = 'outside';
    },
    (r) => {
      r.receipts[2] = r.receipts[1];
    },
    (r) => {
      r.receipts[0].payload_hash = 'changed';
    },
    (r) => {
      r.originalFingerprints[0].digest = 'f'.repeat(32);
    },
    (r) => {
      r.fingerprints.pop();
    },
    (r) => {
      r.readOnly = false;
    },
  ]) {
    const after = frame();
    mutate(after);
    assert.equal(assessHourlyReplayDedup(frame(), after, devices).gate, 'NO_RECEIPT');
  }
  assert.throws(() => assessHourlyReplayDedup(frame(), frame(), [...devices, 'outside']), /EXACT_OWN_TEN/);
});
