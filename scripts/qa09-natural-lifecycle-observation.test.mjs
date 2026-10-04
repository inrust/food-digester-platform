import test from 'node:test';
import assert from 'node:assert/strict';
import { projectLicenseSync, licenseSyncObservationGate } from './qa09-natural-lifecycle-observation.mjs';

test('real Sync observation redacts secret domains and cannot treat delivery as firmware verification', () => {
  const row = projectLicenseSync(
    {
      status: 200,
      body: {
        deviceId: 'own',
        license: { licenseId: 'license', status: 'ISSUED', signature: 'do-not-export' },
        operationalStatus: { lifecycleStatus: 'Assigned' },
        deviceUsers: [{ passwordHash: 'do-not-export' }],
      },
    },
    'own',
    'license',
  );
  assert.equal(row.signaturePresent, true);
  assert.equal(row.firmwareVerificationClaimed, false);
  assert.ok(!JSON.stringify(row).includes('do-not-export'));
  const rows = [
    { phase: 'issued', ...row, adminLifecycleStatus: 'Assigned' },
    { phase: 'activated', ...row, licenseStatus: 'ACTIVE', adminLifecycleStatus: 'Assigned' },
  ];
  assert.equal(licenseSyncObservationGate(rows).licenseDeliveryGate, 'PASS');
  assert.equal(licenseSyncObservationGate(rows).naturalLifecycleGate, 'FAIL');
  assert.equal(
    licenseSyncObservationGate(
      rows.map((r) => ({ ...r, lifecycleStatus: 'Licensed', adminLifecycleStatus: 'Licensed' })),
    ).naturalLifecycleGate,
    'PARTIAL',
  );
  assert.equal(licenseSyncObservationGate(rows).lifecycleReadbackGate, 'PASS');
  assert.equal(
    licenseSyncObservationGate(rows.map((r) => ({ ...r, lifecycleStatus: 'Licensed' }))).assignedToLicensedGate,
    'FAIL',
  );
  for (const patch of [{ status: 0 }, { deviceMatches: false }, { licenseMatches: false }, { signaturePresent: false }])
    assert.equal(licenseSyncObservationGate(rows.map((r) => ({ ...r, ...patch }))).licenseDeliveryGate, 'FAIL');
  assert.equal(licenseSyncObservationGate([]).licenseDeliveryGate, 'FAIL');
});
