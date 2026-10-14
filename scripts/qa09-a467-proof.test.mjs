import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRotationProof, assertTabletProof, assertRotationSchedule } from './qa09-a467-proof.mjs';
test('Rotation preflight rejects disabled or incompatible sweep schedules before any new fixture writes', () => {
  const s = { Name: 'fdp-test-cert-package-sweeper', State: 'ENABLED', ScheduleExpression: 'rate(5 minutes)' };
  assert.equal(assertRotationSchedule(s), 360000);
  assert.throws(() => assertRotationSchedule({ ...s, State: 'DISABLED' }));
  assert.throws(() => assertRotationSchedule({ ...s, ScheduleExpression: 'rate(1 hour)' }));
});
import { validateEntityMode } from './run-qa09-ten-device-acceptance.mjs';
const rotation = () => ({
  oldCertificateId: 'old',
  newCertificateId: 'new',
  newFingerprint: 'digest',
  before: { certificates: [{ id: 'old', status: 'ACTIVE' }] },
  after: {
    devices: [{ lifecycle_status: 'Onboarded' }],
    certificates: [
      { id: 'old', status: 'REVOKED', revoked_at: 'now' },
      {
        id: 'new',
        status: 'ACTIVE',
        rotated_from_id: 'old',
        rotation_confirmed_at: 'now',
        mqtt_verified_at: 'now',
        rest_verified_at: 'now',
        package_destroyed: true,
        fingerprint: 'digest',
      },
    ],
  },
  oldRestStatus: 401,
  newRestStatus: 200,
  oldIotStatus: 'INACTIVE',
  oldMqttRejection: 'NOT_AUTHORIZED',
  newMqttConnected: true,
});
test('Rotation gate requires both new channels, durable old revocation and actual old MQTT denial', () => {
  assert.equal(assertRotationProof(rotation()).gate, 'PASS_ONE_REAL_DUAL_CHANNEL_ROTATION');
  for (const mutate of [
    (r) => {
      r.oldRestStatus = 0;
    },
    (r) => {
      r.oldMqttRejection = 'UNPROVEN_TRANSPORT_FAILURE';
    },
    (r) => {
      r.after.certificates[1].rotation_confirmed_at = null;
    },
    (r) => {
      r.after.certificates[1].rotated_from_id = 'foreign';
    },
    (r) => {
      r.after.devices[0].lifecycle_status = 'Active';
    },
    (r) => {
      r.newMqttConnected = false;
    },
  ]) {
    const r = rotation();
    mutate(r);
    assert.throws(() => assertRotationProof(r));
  }
});
test('One-device rotation mode cannot mix with a full or review execution or omit the specialized extension', () => {
  const fn = () => {};
  fn.rotationOnly = true;
  validateEntityMode({ reviewOnly: false, rotationOnly: true }, fn);
  for (const options of [
    { reviewOnly: true, rotationOnly: true },
    { reviewOnly: false, rotationOnly: true, remainingOnly: true },
  ])
    assert.throws(() => validateEntityMode(options, fn));
  assert.throws(() => validateEntityMode({ reviewOnly: false, rotationOnly: true }, () => {}));
});
test('Tablet proof requires all eight actual read pages, language, viewport and successful request IDs', () => {
  const rows = ['zh-CN', 'en'].flatMap((locale) =>
    ['/settings', '/contracts', '/contracts/new', '/consumables'].map((route) => ({
      route,
      locale,
      lang: locale,
      width: 768,
      documentWidth: 768,
      result: 'PASS',
      domSha256: 'a'.repeat(64),
      apiReads: [{ status: 200, requestId: 'real' }],
    })),
  );
  assert.equal(assertTabletProof(rows).allRolesAccepted, false);
  for (const mutate of [
    (r) => r.pop(),
    (r) => {
      r[0].apiReads = [];
    },
    (r) => {
      r[0].lang = 'en';
    },
    (r) => {
      r[0].documentWidth = 900;
    },
    (r) => {
      r[0].apiReads[0].requestId = null;
    },
  ]) {
    const r = structuredClone(rows);
    mutate(r);
    assert.throws(() => assertTabletProof(r));
  }
});
