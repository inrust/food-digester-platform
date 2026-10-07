import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthenticatedPreconnectPhases } from './qa09-authenticated-preconnect-proof.mjs';
const rows = () =>
  [
    ['admin-authenticate', 0, 9],
    ['admin-account-hook', 10, 100],
    ['db-engine-prepare', 11, 45],
    ['db-authenticated-preconnect', 12, 50],
    ['admin-account-query', 51, 99],
    ['db-first-query', 60, 95],
    ['db-first-connection', 61, 65],
  ].map(([phase, s, e]) => ({
    phase,
    lambdaRequestId: 'lambda',
    gatewayRequestId: 'gateway',
    operationId: 'operation',
    outcome: 'PASS',
    errorCode: 'NONE',
    durationMs: e - s,
    startedAt: new Date(s).toISOString(),
    completedAt: new Date(e).toISOString(),
    includesConnectionWait: true,
    completionBoundary: 'OPERATION_SETTLED',
  }));
test('C1 waits for both branches then independent query/checkout; C0 refuses candidate signal; warm absent is null', () => {
  assert.equal(validateAuthenticatedPreconnectPhases(rows(), true).preconnectMs, 38);
  assert.throws(() => validateAuthenticatedPreconnectPhases(rows(), false));
  const warm = rows().filter((p) => !['db-authenticated-preconnect', 'db-engine-prepare'].includes(p.phase));
  assert.equal(validateAuthenticatedPreconnectPhases(warm, true), null);
  assert.equal(validateAuthenticatedPreconnectPhases(warm, false), null);
});
for (const [name, mutate] of [
  ['missing', (r) => r.splice(3, 1)],
  ['duplicate', (r) => r.push({ ...r[3] })],
  ['failed', (r) => (r[3].outcome = 'FAIL')],
  ['foreign', (r) => (r[3].lambdaRequestId = 'foreign')],
  ['bad timestamp', (r) => (r[3].startedAt = 'invalid')],
  ['dispatch instead of settlement', (r) => (r[3].completionBoundary = 'DRIVER_DISPATCH')],
  ['not connection wait', (r) => (r[3].includesConnectionWait = false)],
  ['query before preparation', (r) => (r[4].startedAt = new Date(44).toISOString())],
  ['checkout steals readiness', (r) => (r[6].startedAt = new Date(13).toISOString())],
  ['outside hook', (r) => (r[3].completedAt = new Date(101).toISOString())],
  ['invalid duration', (r) => (r[3].durationMs = -1)],
  ['orphan', (r) => r.splice(2, 1)],
])
  test('preconnect proof rejects ' + name, () => {
    const r = rows();
    mutate(r);
    assert.throws(() => validateAuthenticatedPreconnectPhases(r, true));
  });

test('preconnect proof rejects consistently empty invocation identities', () => {
  const r = rows();
  for (const p of r) p.lambdaRequestId = '';
  assert.throws(() => validateAuthenticatedPreconnectPhases(r, true), /PRECONNECT_ID/);
});
