import { assert, test, expect } from 'vitest';
import { observeRequest } from '../src/request-correlation.js';
test('logs fixed correlation fields for success/error without body or exception text', async () => {
  const rows: Readonly<Record<string, string | number>>[] = [];
  let at = 10;
  const ids = {
    gatewayRequestId: 'req-1',
    gatewayExtendedRequestId: 'extended=',
    lambdaRequestId: 'lambda-1',
    operationId: 'listDevices',
  };
  assert.equal(
    (
      await observeRequest(
        ids,
        async () => {
          at = 22;
          return { statusCode: 200, body: 'secret-canary' };
        },
        (r) => rows.push(r),
        () => at,
      )
    ).statusCode,
    200,
  );
  await expect(
    observeRequest(
      ids,
      async () => {
        throw Error('secret-canary');
      },
      (r) => rows.push(r),
    ),
  ).rejects.toThrow('secret-canary');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.elapsedMs, 12);
  assert.equal(rows[1]?.status, 'UNHANDLED');
  assert.notInclude(JSON.stringify(rows), 'secret-canary');
});
test('caller-controlled JWT-like identifiers are excluded and logger failure cannot alter committed status', async () => {
  const rows: unknown[] = [];
  await observeRequest(
    { gatewayRequestId: 'eyJ.fake.signature', operationId: 'GET /private?token=canary' },
    async () => ({ statusCode: 201 }),
    (r) => rows.push(r),
  );
  assert.notInclude(JSON.stringify(rows), 'canary');
  assert.notInclude(JSON.stringify(rows), 'eyJ.');
  assert.equal(
    (
      await observeRequest(
        {},
        async () => ({ statusCode: 201 }),
        () => {
          throw Error('logger failed');
        },
      )
    ).statusCode,
    201,
  );
});
