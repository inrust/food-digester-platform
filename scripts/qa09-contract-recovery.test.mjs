import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContractRecovery } from './recover-qa09-contract-race.mjs';
function fixtures() {
  const prefix = 'qa09-1234567890abcdef';
  const customers = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'].map((id, i) => ({
    id,
    name: prefix + (i ? '-b' : '-a'),
  }));
  const child = {
    prefix,
    customers,
    devices: Array.from({ length: 10 }, (_, i) => prefix + '-' + String(i + 1).padStart(2, '0')),
    mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
    sourceCommit: '5'.repeat(40),
    finishedAt: '2026-10-06T01:00:00Z',
    fullQa09Accepted: false,
    coreMode: 'FIVE_ROLE_SCOPE_AND_ASSIGNMENT_FOUNDATION_NOT_FULL_CORE',
    createdSites: customers.map((c, i) => ({ id: 'site-' + i, customerId: c.id })),
    remaining: {
      scope: 'OWN_DRAFT_CONTRACT_THREE_CONCURRENT_IF_MATCH_ROUNDS',
      contractId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      rounds: [1, 2, 3].map((round) => ({
        round,
        settled: ['fulfilled', 'fulfilled'],
        beforeVersion: round,
        readback: { version: round + 1, status: 'DRAFT' },
      })),
      attempts: Array.from({ length: 6 }, (_, i) => ({
        round: Math.floor(i / 2) + 1,
        state: 'SETTLED',
        clientRequestId: `${i}0000000-0000-4000-8000-000000000000`,
        observation: {
          result: 'PASS',
          responseReceived: true,
          status: i % 2 ? 409 : 200,
          gatewayRequestId: `${i}0000000-0000-4000-8000-000000000000`,
        },
      })),
    },
  };
  return {
    child,
    parent: { ...structuredClone(child), target: { accountId: '065986019555', region: 'ap-southeast-1' } },
  };
}
test('read-only completion accepts only all six settled exact successful PATCH receipts', () => {
  const { child, parent } = fixtures();
  assert.equal(validateContractRecovery(child, parent).rounds.length, 3);
});
for (const fault of ['unknown-write', 'foreign-site', 'wrong-account', 'unfinished', 'gateway-id'])
  test('cleanup/completion guard rejects ' + fault, () => {
    const { child, parent } = fixtures();
    if (fault === 'unknown-write') child.remaining.attempts[0].observation.responseReceived = false;
    if (fault === 'foreign-site') child.createdSites[0].customerId = 'foreign';
    if (fault === 'wrong-account') parent.target.accountId = '123456789012';
    if (fault === 'unfinished') parent.finishedAt = null;
    if (fault === 'gateway-id') child.remaining.attempts[0].observation.gatewayRequestId = 'foreign';
    assert.throws(() => validateContractRecovery(child, parent));
  });
