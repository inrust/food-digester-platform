import test from 'node:test';
import assert from 'node:assert/strict';
import { entityRows } from './collect-qa09-nonactive-semantics.mjs';
const prefix = 'qa09-1234567890abcdef';
const parent = {
  prefix,
  sourceCommit: 'a'.repeat(40),
  gate: 'PASS',
  finishedAt: '2026-10-05',
  reviewOnly: true,
  scope: 'PENDING_CSR_ENTITY_REVIEW_ONLY',
  devices: ['own1', 'own2', 'own3', 'own4'],
  cleanup: [{ type: 'database-fixtures', count: 10, result: 'PASS' }],
};
const r = {
  prefix,
  sourceCommit: parent.sourceCommit,
  gate: 'PASS',
  finishedAt: '2026-10-05',
  cleanupVerified: true,
  fullQa09Accepted: false,
  apiMock: false,
  scope: 'REAL_NONACTIVE_ENTITY_CSR',
  layouts: [375, 1440].flatMap((width) =>
    [1, 2].map(() => ({ width, viewport: width, body: width, document: width, result: 'PASS' })),
  ),
  executions: [375, 1440].flatMap((width, i) =>
    ['approve', 'reject'].map((decision, j) => ({
      group: 'device-group.onboarding',
      width,
      decision,
      deviceId: parent.devices[i * 2 + j],
      result: 'PASS',
      ifMatch: '1',
      version: 2,
      gatewayRequestId: 'real-request',
    })),
  ),
};
test('entity merge requires actual decisions on both viewports, scoped devices, versions and cleanup', () => {
  assert.equal(entityRows(r, parent).length, 2);
  for (const changed of [
    { ...r, apiMock: true },
    { ...r, layouts: [] },
    { ...r, layouts: r.layouts.map((x) => ({ ...x, body: x.width + 30 })) },
    { ...r, cleanupVerified: false },
    { ...r, prefix: 'qa09-ffffffffffffffff' },
    { ...r, executions: r.executions.slice(1) },
    { ...r, executions: r.executions.map((x) => ({ ...x, version: 1 })) },
    { ...r, executions: r.executions.map((x) => ({ ...x, deviceId: 'foreign' })) },
  ])
    assert.throws(() => entityRows(changed, parent));
  assert.throws(() =>
    entityRows(r, { ...parent, cleanup: [{ type: 'database-fixtures', count: 10, result: 'FAIL' }] }),
  );
  assert.throws(() => entityRows(r, { ...parent, reviewOnly: false }));
});
test('certificate merge cannot use review-only parent to claim real dual-channel certificate entity', () => {
  const certificate = {
    ...r,
    scope: 'REAL_NONACTIVE_ENTITY_CERTIFICATE',
    layouts: [375, 1440].map((width) => ({ width, viewport: width, body: width, document: width, result: 'PASS' })),
    executions: [375, 1440].map((width, i) => ({
      group: 'device-manage.certificate',
      width,
      deviceId: parent.devices[i],
      result: 'PASS',
      gatewayRequestId: 'real-request',
      certificateId: 'own-cert',
      rotationRequestId: 'own-intent',
    })),
  };
  assert.throws(() => entityRows(certificate, parent));
  assert.equal(
    entityRows(certificate, { ...parent, reviewOnly: false, scope: 'TEN_DEVICE_CSR_MTLS_HEARTBEAT_TELEMETRY_ARCHIVE' })
      .length,
    2,
  );
});
