import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectReplayProduction,
  uniqueReplayProduction,
  collectReplayProduction,
} from './qa09-replay-production-proof.mjs';
const expected = {
  jobId: 'a'.repeat(36),
  deviceId: 'qa09-1234567890abcdef-03',
  topicType: 'telemetry',
  messageId: 'original-1',
  seq: 1,
  startMs: 1,
  endMs: 100,
};
const row = { event: 'replay.record.produced', schemaVersion: 1, ...expected, sqsMessageId: 'actual-sqs-1' };
test('only bounded fields are projected and an exact unique Job/source/SQS tuple proves production', () => {
  const p = projectReplayProduction(JSON.stringify({ ...row, payload: 'never-store', token: 'never-store' }));
  assert.ok(p);
  assert.deepEqual(
    projectReplayProduction('2026-10-13T10:00:00.000Z request-id INFO ' + JSON.stringify(row) + '\n'),
    projectReplayProduction(JSON.stringify(row)),
  );
  assert.ok(!JSON.stringify(p).includes('never-store'));
  assert.equal(uniqueReplayProduction([p], expected).gate, 'PASS_UNIQUE_REPLAY_JOB_PRODUCTION');
  assert.equal(uniqueReplayProduction([{ ...p, jobId: 'foreign' }], expected).gate, 'NO_RECEIPT');
  assert.equal(uniqueReplayProduction([p, { ...p, sqsMessageId: 'second' }], expected).gate, 'AMBIGUOUS_PRODUCTION');
});
test('collector reads the exact fixed log group; truncation and repeated tokens cannot pass', async () => {
  let calls = 0;
  const read = async (args) => {
    calls++;
    assert.ok(args.includes('/aws/lambda/fdp-test-replay'));
    return { events: [{ message: JSON.stringify(row), timestamp: 10 }] };
  };
  assert.equal((await collectReplayProduction(expected, { read })).sqsMessageId, 'actual-sqs-1');
  assert.equal(calls, 1);
  await assert.rejects(
    collectReplayProduction(expected, { read: async () => ({ events: [], nextToken: 'repeat' }) }),
    /INCOMPLETE/,
  );
});
