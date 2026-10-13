import test from 'node:test';
import assert from 'node:assert/strict';
import { bindOwnOperatorActor } from './collect-qa09-operator-actor-binding.mjs';
const prefix = 'qa09-1234567890abcdef',
  dbId = '11111111-1111-4111-8111-111111111111',
  sub = '22222222-2222-4222-8222-222222222222',
  email = prefix + '-h01-platformoperator@example.invalid',
  buildId = 'fdp-test-qa09-ten-device-fixtures:33333333-3333-4333-8333-333333333333';
function inputs() {
  return [
    { prefix, sourceCommit: 'a'.repeat(40) },
    {
      prefix,
      sourceCommit: 'a'.repeat(40),
      operator: { userId: dbId, role: 'PlatformOperator', email, realSrp: true },
      fixtureBuilds: [{ gate: 'PASS', buildId }],
    },
    {
      sourceHash: 'h',
      plan: {
        prefix,
        action: 'business-seed-user',
        ownUser: { userId: dbId, cognitoSub: sub, email, role: 'PlatformOperator', customerId: null },
      },
    },
    {
      gate: 'PASS',
      sourceHash: 'h',
      build: { id: buildId, status: 'SUCCEEDED' },
      result: {
        sourceHash: 'h',
        prefix,
        action: 'business-seed-user',
        user: { userId: dbId, email, roles: ['PlatformOperator'] },
      },
    },
    { enabled: true, status: 'CONFIRMED', email, subject: sub },
    ['PlatformOperator'],
  ];
}
test('real actor sub stays distinct from database userId and cannot be replaced with a convenient identifier', () => {
  const args = inputs(),
    result = bindOwnOperatorActor(...args);
  assert.equal(result.actorId, sub);
  assert.equal(result.businessUserId, dbId);
  for (const mutate of [
    (a) => (a[4].subject = dbId),
    (a) => (a[4].enabled = false),
    (a) => (a[5] = ['PlatformSuperAdmin']),
    (a) => (a[2].plan.prefix = 'qa09-0000000000000000'),
    (a) => (a[3].build.status = 'IN_PROGRESS'),
  ]) {
    const a = inputs();
    mutate(a);
    assert.throws(() => bindOwnOperatorActor(...a), /EXACT_REAL_OPERATOR_SUB/);
  }
});
