import test from 'node:test';
import assert from 'node:assert/strict';
import { bindAudits, overlap } from './check-qa09-contract-race.mjs';
const attempts = Array.from({ length: 6 }, (_, i) => ({
  clientRequestId: String(i),
  ifMatch: Math.floor(i / 2) + 1,
  observation: { status: i % 2 ? 409 : 200 },
}));
const audits = [0, 2, 4].map((i) => ({
  auditId: 'audit' + i,
  requestId: String(i),
  result: 'SUCCESS',
  beforeVersion: Math.floor(i / 2) + 1,
  afterVersion: Math.floor(i / 2) + 2,
}));
test('success audits bind precisely and conflicts never have a success audit', () => bindAudits(attempts, audits));
for (const fault of ['duplicate', 'wrong-version', 'conflict-success'])
  test('audit proof rejects ' + fault, () => {
    const a = structuredClone(audits);
    if (fault === 'duplicate') a[1] = a[0];
    if (fault === 'wrong-version') a[1].afterVersion++;
    if (fault === 'conflict-success') a[1].requestId = '3';
    assert.throws(() => bindAudits(attempts, a));
  });
test('Gateway overlap cannot conceal serialized Lambda executions', () => {
  const records = [1, 2, 3].flatMap((round) =>
    ['a', 'b'].map((s, i) => ({
      id: `race:${round}:${s}`,
      exactLinked: true,
      gateway: [{ requestTimeEpoch: 100 + i, responseLatency: 40 }],
      lambda: [{ logTimestampMs: 120 + i * 20, elapsedMs: 10 }],
    })),
  );
  const t = overlap(records);
  assert.equal(t[0].gatewayOverlapMs, 39);
  assert.equal(t[0].lambdaApproximateOverlapMs, 0);
  records[1].lambda[0].logTimestampMs = 121;
  assert.equal(overlap(records)[0].lambdaApproximateOverlapMs, 9);
  delete records[1].lambda[0].logTimestampMs;
  assert.throws(() => overlap(records), /LOG_TIMING_REQUIRED/);
});
