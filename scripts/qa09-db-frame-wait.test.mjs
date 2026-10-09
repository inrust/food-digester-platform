import test from 'node:test';
import assert from 'node:assert/strict';
import { readVerifiedFixtureFrame } from './qa09-db-frame-wait.mjs';
const expected = {
  buildId: 'build-1',
  sourceHash: 'hash-1',
  prefix: 'qa09-1234567890abcdef',
  action: 'business-audit',
};
const frame = { kind: 'fdp-qa09-ten-device-db/v1', ...expected, gate: 'PASS' };
const logs = (v) => ({ events: [{ message: JSON.stringify(v) }] });
test('completed Build result tolerates delayed/truncated CloudWatch visibility and transient read failure without rerunning SQL', async () => {
  let reads = 0,
    clock = 0;
  const result = await readVerifiedFixtureFrame(
    async () => {
      reads++;
      if (reads === 1)
        throw Object.assign(Error('AWS_OPERATION_FAILED'), { code: 'AWS_get-log-events_CLI_NETWORK_ERROR' });
      if (reads === 2) return { events: [] };
      if (reads === 3) return { events: [{ message: JSON.stringify(frame).slice(0, 80) }] };
      return logs(frame);
    },
    expected,
    {
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
    },
  );
  assert.equal(reads, 4);
  assert.equal(result.frame.buildId, expected.buildId);
  assert.equal(result.observations.length, 4);
});
test('wrong/multiple/failed frames and AccessDenied reject immediately, absent result fails closed after bounded reads', async () => {
  for (const v of [
    { ...frame, sourceHash: 'foreign' },
    { ...frame, prefix: 'other' },
    { ...frame, gate: 'FAIL' },
  ])
    await assert.rejects(
      readVerifiedFixtureFrame(async () => logs(v), expected, { pause: async () => {} }),
      /NOT_VERIFIED/,
    );
  await assert.rejects(
    readVerifiedFixtureFrame(async () => ({ events: [...logs(frame).events, ...logs(frame).events] }), expected),
    /NOT_VERIFIED/,
  );
  await assert.rejects(
    readVerifiedFixtureFrame(async () => {
      throw Object.assign(Error('AWS_OPERATION_FAILED'), { code: 'AWS_get-log-events_AccessDeniedException' });
    }, expected),
    /AWS_OPERATION_FAILED/,
  );
  let reads = 0;
  await assert.rejects(
    readVerifiedFixtureFrame(
      async () => {
        reads++;
        return { events: [] };
      },
      expected,
      { maxAttempts: 2, pause: async () => {} },
    ),
    /READ_TIMEOUT/,
  );
  assert.equal(reads, 2);
});

test('expired SSO is a terminal authentication condition, never a transient log retry', async () => {
  let reads = 0;
  await assert.rejects(
    readVerifiedFixtureFrame(async () => {
      reads++;
      throw Object.assign(Error('AWS_OPERATION_FAILED'), { code: 'AWS_get-log-events_SSO_SESSION_EXPIRED' });
    }, expected),
    /AWS_OPERATION_FAILED/,
  );
  assert.equal(reads, 1);
});
