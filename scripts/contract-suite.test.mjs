import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DeviceContract, deviceContract } from '../contracts/testing/device-contract.ts';
import { assertMqttPayload } from '../contracts/testing/mqtt-contract.ts';
import { computeAuditHash } from '../contracts/mqtt/payload-normalization.ts';
import { compareBaselines, enforceGovernance, breakingChanges } from './contract-suite/compatibility.mjs';
import { summarizeCoverage } from './run-contract-suite.mjs';
import { snapshot, wireHash, checkBaselines } from './contract-suite/baseline.mjs';
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const topicTypes = json('contracts/mqtt/topic-catalog.json').topics.map((topic) => topic.type);

for (const type of topicTypes)
  test(`QA-02 MQTT ${type}: all valid/invalid fixtures, missing meta and type mutation`, () => {
    const fixture = json(`contracts/mqtt/fixtures/${type}.fixtures.json`);
    for (const payload of fixture.valid) assert.doesNotThrow(() => assertMqttPayload(type, payload));
    for (const { payload } of fixture.invalid) assert.throws(() => assertMqttPayload(type, payload));
    const removed = structuredClone(fixture.valid[0]);
    delete removed.meta;
    assert.throws(() => assertMqttPayload(type, removed));
    const mutated = structuredClone(fixture.valid[0]);
    mutated.meta.id = 42;
    assert.throws(() => assertMqttPayload(type, mutated));
  });
test('MQTT semantic hash, discriminator and UTC calendar errors fail closed', () => {
  const fixture = json('contracts/mqtt/fixtures/telemetry.fixtures.json').valid[0];
  const wrongHash = structuredClone(fixture);
  wrongHash.data.feedingWeightKg++;
  assert.throws(() => assertMqttPayload('telemetry', wrongHash), /AUDIT_HASH_MISMATCH/);
  wrongHash.audit.hash = computeAuditHash(wrongHash);
  assert.doesNotThrow(() => assertMqttPayload('telemetry', wrongHash));
  const ack = json('contracts/mqtt/fixtures/ack.fixtures.json').valid[0];
  assert.throws(
    () => assertMqttPayload('ack', { ...ack, data: { ...ack.data, otaTargetId: 'mixed' } }),
    /DISCRIMINATOR/,
  );
  assert.throws(() => assertMqttPayload('ack', { ...ack, data: { objectType: 'OTA_TARGET' } }), /DISCRIMINATOR/);
  fixture.meta.ts = '2026-01-01T24:00:00Z';
  assert.throws(() => assertMqttPayload('telemetry', fixture));
  fixture.meta.ts = '2026-02-30T10:00:00Z';
  assert.throws(() => assertMqttPayload('telemetry', fixture));
});
const statusBody = {
  certificateId: 'cert-1',
  status: 'ACTIVE',
  expiryDate: '2027-01-01',
  daysRemaining: 92,
  mqttVerifiedAt: null,
  restVerifiedAt: null,
  rotationDeadlineAt: null,
  rotationConfirmedAt: null,
};
test('full REST response: field deletion/type mutation/envelope/date/errors/status/headers are enforced', () => {
  const check = (body, status = 200) => deviceContract.assertResponse('getCertificateStatus', { status, body });
  check(statusBody);
  check(JSON.stringify(statusBody));
  const removed = structuredClone(statusBody);
  delete removed.certificateId;
  assert.throws(() => check(removed));
  assert.throws(() => check({ ...statusBody, daysRemaining: '92' }));
  assert.throws(() => check({ ...statusBody, expiryDate: '2027-02-30' }));
  assert.throws(() => check({ data: statusBody }));
  assert.throws(() => check(statusBody, 201));
  assert.throws(() => check('{broken'));
  check({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required', requestId: 'r1' } }, 401);
  assert.throws(
    () => check({ error: { code: 'FORBIDDEN', message: 'wrong status mapping', requestId: 'r1' } }, 401),
    /MISMATCH/,
  );
  assert.throws(() => check({ error: { code: 'UNKNOWN', message: 'unknown', requestId: 'r1' } }, 401));
  const redirect = {
    status: 307,
    body: '',
    headers: { Location: 'https://s3.test/object', 'Cache-Control': 'no-store' },
  };
  deviceContract.assertResponse('redeemOtaDownloadGrant', redirect);
  assert.throws(() => deviceContract.assertResponse('redeemOtaDownloadGrant', { ...redirect, headers: {} }));
  assert.throws(() =>
    deviceContract.assertResponse('redeemOtaDownloadGrant', { ...redirect, body: { expiresAt: 'extra' } }),
  );
  assert.throws(() =>
    deviceContract.assertResponse('redeemOtaDownloadGrant', {
      ...redirect,
      headers: { ...redirect.headers, 'Cache-Control': 'public' },
    }),
  );
});
test('REST request validation: required body/path/query/header, optional Sync, bodyless Deactivate, no type coercion in JSON', () => {
  deviceContract.assertRequest('syncDevice', {});
  deviceContract.assertRequest('syncDevice', { body: { lastSyncTime: null } });
  assert.throws(() => deviceContract.assertRequest('syncDevice', { body: { lastSyncTime: '2026-02-30T00:00:00Z' } }));
  assert.throws(() => deviceContract.assertRequest('syncDevice', { body: { unknown: true } }));
  deviceContract.assertRequest('confirmDeactivation', {});
  assert.throws(() => deviceContract.assertRequest('confirmDeactivation', { body: {} }));
  assert.throws(() => deviceContract.assertRequest('rotateCertificate', { body: { currentCertificateId: 'cert-1' } }));
  assert.throws(() => deviceContract.assertRequest('redeemOtaDownloadGrant', { params: { targetId: 't1' } }));
  const input = { mediaType: 'IMAGE', fileName: 'snap.jpg', sizeKb: 1, sizeBytes: 1024, sha256: 'a'.repeat(64) };
  deviceContract.assertRequest('createMediaUploadSession', { body: input });
  assert.throws(() =>
    deviceContract.assertRequest('createMediaUploadSession', { body: { ...input, sizeBytes: '1024' } }),
  );
  const statusRequest = {
    query: { requestId: '00000000-0000-0000-0000-000000000001' },
    headers: {
      'x-onboarding-timestamp': '1',
      'x-onboarding-nonce': 'n'.repeat(32),
      'x-onboarding-signature': 'A'.repeat(344),
    },
  };
  deviceContract.assertRequest('getOnboardingStatus', statusRequest);
  assert.throws(() => deviceContract.assertRequest('getOnboardingStatus', { ...statusRequest, headers: {} }));
});
test('all device operations and declared response JSON Schemas compile; stable error catalog has no duplicates', () => {
  assert.equal(deviceContract.operations.size, 8);
  for (const [id, { operation }] of deviceContract.operations)
    for (const [status, response] of Object.entries(operation.responses)) {
      const resolved = deviceContract.resolve(response);
      const schema = resolved.content?.['application/json']?.schema;
      if (schema)
        assert.ok(
          deviceContract.ajv.compile(
            JSON.parse(JSON.stringify(schema), (key, value) =>
              key === '$ref' && value.startsWith('#/') ? deviceContract.api.$id + value : value,
            ),
          ),
          `${id} ${status}`,
        );
      else assert.equal(status, '307');
    }
  const codes = json('contracts/rest/error-codes.json').errorCodes;
  assert.equal(new Set(codes.map((code) => code.code)).size, codes.length);
});
test('predecessor MQTT is compatible; known REST break requires exact version and frozen DEC approvals', async () => {
  const receipt = await checkBaselines();
  assert.equal(receipt.status, 'APPROVED_BREAKING_UPGRADE');
  const old = json('contracts/testing/baselines/0.11.0.json');
  const current = snapshot();
  assert.deepEqual(
    compareBaselines({ ...old, rest: {}, errorCodes: [] }, { ...current, rest: {}, errorCodes: [] }),
    [],
  );
  const approvals = json('contracts/testing/compatibility-approvals.json');
  const changes = compareBaselines(old, current);
  const version = json('contracts/contract-version.json');
  const register = json('contracts/decisions/decision-register.json');
  assert.throws(() => enforceGovernance(changes, { ...approvals, changes: [] }, version, register), /UNAPPROVED_BREAK/);
  assert.throws(
    () => enforceGovernance(changes, approvals, { ...version, contractVersion: '0.11.0' }, register),
    /VERSION_NOT_UPDATED/,
  );
  assert.throws(
    () => enforceGovernance(changes, approvals, version, { ...register, decisions: [] }),
    /DECISION_NOT_FROZEN/,
  );
  assert.equal(wireHash(current), approvals.toWireSha256);
});
test('breaking contract mutations fail: removing fields/operations/status, changing type/required/security', () => {
  const base = snapshot();
  const mutants = [
    (m) => delete m.mqtt.telemetry.properties.data.properties.feedingWeightKg,
    (m) => {
      m.mqtt.telemetry.properties.data.properties.feedingWeightKg.type = 'string';
    },
    (m) => delete m.rest.syncDevice,
    (m) => delete m.rest.getCertificateStatus.responses['200'],
    (m) => {
      m.rest.rotateCertificate.security = [];
    },
    (m) =>
      delete m.rest.getCertificateStatus.responses['200'].content['application/json'].schema.properties.certificateId,
    (m) => {
      m.rest.getCertificateStatus.responses['200'].content['application/json'].schema.properties.daysRemaining.type =
        'string';
    },
  ];
  for (const mutate of mutants) {
    const candidate = structuredClone(base);
    mutate(candidate);
    assert.ok(compareBaselines(base, candidate).length > 0);
    assert.notEqual(wireHash(base), wireHash(candidate));
  }
  assert.ok(
    breakingChanges(
      { type: 'object', properties: {}, required: [] },
      { type: 'object', properties: { newField: { type: 'string' } }, required: ['newField'] },
    ).some((c) => c.kind === 'request-required-added'),
  );
  // OpenAPI mutation is detected without rebuilding sample expectations from the mutated schema.
  const api = json('contracts/rest/openapi.bundle.json');
  const op = api.paths['/api/v1/device/certificate/status'].get;
  const contract = new DeviceContract(api, json('contracts/rest/error-codes.json'));
  const schema = contract.resolve(contract.resolve(op.responses['200']).content['application/json'].schema);
  schema.properties.daysRemaining.type = 'string';
  assert.throws(() => contract.assertResponse('getCertificateStatus', { status: 200, body: statusBody }));
});

test('receipt coverage gate fails closed for missing operations/statuses, no valid request and forged records', () => {
  const operations = new Map([['op', { operation: { responses: { 200: {}, 401: {} } } }]]);
  const rows = [
    { operationId: 'op', status: 200, validRequest: true, source: 'REAL_HANDLER' },
    { operationId: 'op', status: 401, validRequest: false, source: 'REAL_HANDLER' },
  ];
  assert.equal(summarizeCoverage(rows, operations).length, 1);
  assert.throws(() => summarizeCoverage([], operations), /INCOMPLETE/);
  assert.throws(() => summarizeCoverage(rows.slice(0, 1), operations), /INCOMPLETE/);
  assert.throws(
    () =>
      summarizeCoverage(
        rows.map((row) => ({ ...row, validRequest: false })),
        operations,
      ),
    /INCOMPLETE/,
  );
  assert.throws(() => summarizeCoverage([...rows, { ...rows[0], status: 201 }], operations), /INCOMPLETE/);
  assert.throws(() => summarizeCoverage([...rows, { ...rows[0], operationId: 'unknown' }], operations), /UNEXPECTED/);
  assert.throws(
    () =>
      summarizeCoverage(
        rows.map((row) => ({ ...row, source: 'FABRICATED' })),
        operations,
      ),
    /INVALID_OPERATION_TRACE/,
  );
});
