import test from 'node:test';
import assert from 'node:assert/strict';
import { seedCleanupAction } from './qa09-seed-recovery.mjs';
const devices = Array.from({ length: 10 }, (_, i) => 'own-' + i);
const rows = devices.map((id) => ({ id, serial_number: id }));
test('unknown seed outcome requires observed complete own set or proven empty set, never a blind retry', () => {
  assert.equal(seedCleanupAction({ devices: rows, certificates: [], requests: [] }, devices), 'cleanup');
  assert.equal(seedCleanupAction({ devices: [], requests: [], certificates: [] }, devices), 'audit-empty');
  for (const observed of [
    { devices: rows.slice(1) },
    { devices: rows.map((d) => ({ ...d, id: 'foreign' })) },
    { devices: [], requests: [{}] },
    { devices: [], certificates: [{}] },
  ])
    assert.throws(() => seedCleanupAction(observed, devices), /PARTIAL_SEED/);
});
