import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectLicenseSync,
  licenseSyncObservationGate,
  confirmReceivedLicenseSnapshot,
} from './qa09-natural-lifecycle-observation.mjs';

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
      rows.map((r) => ({
        ...r,
        lifecycleStatus: 'Licensed',
        adminLifecycleStatus: 'Licensed',
        receiptConfirmationAccepted: true,
      })),
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

test('receipt runner sends only RECEIVED and redacts complete snapshots even with device password hashes', async () => {
  const calls = [];
  const snapshot = {
    deviceId: 'own',
    etag: 'a'.repeat(64),
    snapshotAt: '2026-10-05T00:00:00.000Z',
    license: {
      licenseId: 'license',
      version: 1,
      status: 'ISSUED',
      signature: 'do-not-export',
      signaturePayload: { validFrom: 'full-time' },
    },
    deviceUsers: [{ passwordHash: 'do-not-export' }],
    operationalStatus: { lifecycleStatus: 'Assigned' },
  };
  const row = await confirmReceivedLicenseSnapshot(
    async (input) => {
      calls.push(input);
      return {
        status: 200,
        body: {
          ...snapshot,
          operationalStatus: { lifecycleStatus: input.licenseConfirmation ? 'Licensed' : 'Assigned' },
        },
      };
    },
    'own',
    'license',
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].licenseConfirmation, {
    licenseId: 'license',
    version: 1,
    snapshotEtag: 'a'.repeat(64),
    status: 'RECEIVED',
  });
  assert.equal(row.receiptConfirmationAccepted, true);
  assert.equal(row.firmwareVerificationClaimed, false);
  assert.equal(row.independentHmacVerificationGate, 'NOT_RUN_NO_DEVICE_TRUST_CONFIGURATION');
  assert.ok(!JSON.stringify(row).includes('do-not-export'));
  assert.ok(!JSON.stringify(calls).includes('VERIFIED'));
});

test('receipt runner fails closed for mismatched snapshots and refused confirmation', async () => {
  let count = 0;
  const row = await confirmReceivedLicenseSnapshot(
    async () => {
      count++;
      return { status: 200, body: { deviceId: 'other' } };
    },
    'own',
    'license',
  );
  assert.equal(count, 1);
  assert.equal(row.receiptConfirmationAccepted, false);
  const refused = await confirmReceivedLicenseSnapshot(
    async (input) =>
      input.licenseConfirmation
        ? { status: 409 }
        : {
            status: 200,
            body: {
              deviceId: 'own',
              etag: 'a'.repeat(64),
              license: { licenseId: 'license', version: 1, signature: 'hidden' },
            },
          },
    'own',
    'license',
  );
  assert.equal(refused.status, 409);
  assert.equal(refused.receiptConfirmationAccepted, false);
  assert.equal(
    licenseSyncObservationGate([
      {
        phase: 'issued',
        status: 200,
        deviceMatches: true,
        licenseMatches: true,
        signaturePresent: true,
        licenseStatus: 'ISSUED',
        lifecycleStatus: 'Licensed',
        adminLifecycleStatus: 'Licensed',
      },
      {
        phase: 'activated',
        status: 200,
        deviceMatches: true,
        licenseMatches: true,
        signaturePresent: true,
        licenseStatus: 'ACTIVE',
        lifecycleStatus: 'Licensed',
        adminLifecycleStatus: 'Licensed',
      },
    ]).assignedToLicensedGate,
    'FAIL',
  );
});
