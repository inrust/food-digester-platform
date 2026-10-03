import test from 'node:test';
import assert from 'node:assert/strict';
import { correlateGatewayRequest } from './qa09-request-correlation.mjs';
const client = {
  gatewayExtendedRequestId: 'extended',
  gatewayRequestId: 'request',
  startedAt: '2026-10-03T00:36:00Z',
  latencyMs: 500,
  status: 500,
};
const row = {
  extendedRequestId: 'extended',
  requestId: 'request',
  requestTimeEpoch: Date.parse(client.startedAt),
  status: '500',
  integrationStatus: '429',
  functionResponseStatus: '-',
};
test('per-request service throttling requires both unique IDs and bound access-row time/status, never minute metrics', () => {
  assert.equal(correlateGatewayRequest(client, [row]).cause, 'LAMBDA_INVOCATION_SERVICE_429');
  assert.equal(
    correlateGatewayRequest(client, [{ ...row, integrationStatus: '200', functionResponseStatus: '500' }]).cause,
    'FUNCTION_RETURNED_500',
  );
  assert.equal(correlateGatewayRequest(client, []).gate, 'NOT_PROVABLE');
  assert.equal(correlateGatewayRequest(client, [row, row]).gate, 'NOT_PROVABLE');
  assert.equal(correlateGatewayRequest({ ...client, gatewayExtendedRequestId: null }, [row]).gate, 'NOT_PROVABLE');
  assert.equal(correlateGatewayRequest(client, [{ ...row, requestTimeEpoch: 0 }]).gate, 'FAIL');
  assert.equal(correlateGatewayRequest(client, [{ ...row, status: '200' }]).gate, 'FAIL');
  assert.equal(correlateGatewayRequest(client, [{ ...row, extendedRequestId: 'foreign' }]).gate, 'NOT_PROVABLE');
});
