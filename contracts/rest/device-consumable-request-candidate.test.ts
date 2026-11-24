import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const load = (filename: string) => JSON.parse(readFileSync(new URL(filename, import.meta.url), 'utf8'));
const candidate = load('./device-consumable-request-candidate.openapi.json');
const published = load('./openapi.bundle.json');
const path = '/api/v1/device/consumable-requests';

test('R20 candidate intake requires device mTLS and stays outside the published device inventory', () => {
  const operation = candidate.paths[path].post;
  assert.equal(operation.operationId, 'submitDeviceConsumableRequestCandidate');
  assert.deepEqual(operation.security, [{ DeviceMtls: [] }]);
  assert.ok(!published.paths[path]);
  for (const status of ['200', '201', '400', '401', '403', '404', '409', '500']) assert.ok(operation.responses[status]);
});

test('R20 device request and receipt schemas use stable keys and server-owned origin', () => {
  const schemas = candidate.components.schemas;
  const request = schemas.DeviceConsumableRequest;
  assert.equal(request.additionalProperties, false);
  assert.deepEqual(request.required, ['schemaVersion', 'clientVersion', 'requestKey', 'consumableType', 'occurredAt']);
  assert.equal(request.properties.schemaVersion.const, 1);
  assert.equal(
    request.properties.consumableType.$ref,
    'admin-consumable-request-api.json#/components/schemas/ConsumableRequest/properties/consumableType',
  );
  for (const field of ['deviceId', 'customerId', 'source', 'status']) assert.ok(!(field in request.properties));
  assert.deepEqual(schemas.ExistingDeviceConsumableRequest.properties.data.properties.outcome.enum, [
    'LINKED_OPEN',
    'REPLAYED',
  ]);
  assert.deepEqual(schemas.CreatedDeviceConsumableRequest.properties.data.properties.outcome.enum, ['CREATED']);
});
