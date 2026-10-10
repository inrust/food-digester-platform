import test from 'node:test';
import assert from 'node:assert/strict';
import { readPreStartFixtureOperation } from './qa09-operation-observation.mjs';
import { fixtureAws } from './qa09-ten-device-bridge.mjs';

const operation = 'codebuild:batch-get-projects';
const error = (code) => Object.assign(Error('private-message'), { code: 'AWS_batch-get-projects_' + code });
for (const code of [
  'CLI_READ_TIMEOUT',
  'CLI_NETWORK_ERROR',
  'ThrottlingException',
  'TooManyRequestsException',
  'RequestTimeout',
  'RequestTimeoutException',
  'ServiceUnavailableException',
  'NetworkingError',
])
  test(`allowlisted temporary ${code} has at most two read recoveries`, async () => {
    let calls = 0,
      clock = 0;
    const observations = [];
    const result = await readPreStartFixtureOperation(
      operation,
      async () => {
        if (++calls < 3) throw error(code);
        return { projects: [] };
      },
      {
        observations,
        now: () => clock,
        pause: async (ms) => {
          clock += ms;
        },
      },
    );
    assert.equal(result.readGate, 'RECOVERED');
    assert.equal(result.readRecoveries, 2);
    assert.deepEqual(
      observations.map((x) => x.result),
      ['FAIL', 'FAIL', 'PASS'],
    );
    assert.equal(clock, 500);
    assert.ok(!JSON.stringify(observations).includes('private-message'));
  });

for (const code of [
  'AccessDeniedException',
  'SSO_SESSION_EXPIRED',
  'CLI_FAILED',
  'CLI_INVALID_JSON',
  'CLI_OUTPUT_LIMIT',
  'InvalidParameterException',
  'ResourceNotFoundException',
  'UNKNOWN',
])
  test(`terminal or unknown ${code} is never retried`, async () => {
    let calls = 0;
    await assert.rejects(
      readPreStartFixtureOperation(
        operation,
        async () => {
          calls++;
          throw error(code);
        },
        { pause: async () => assert.fail('unexpected delay') },
      ),
    );
    assert.equal(calls, 1);
  });

test('exhausted attempts preserve the last error and three failures', async () => {
  const observations = [];
  const original = error('CLI_NETWORK_ERROR');
  await assert.rejects(
    readPreStartFixtureOperation(
      operation,
      async () => {
        throw original;
      },
      {
        observations,
        pause: async () => {},
      },
    ),
    (e) => e === original,
  );
  assert.equal(observations.length, 3);
  assert.ok(observations.every((x) => x.result === 'FAIL'));
});

test('remaining deadline bounds the CLI and never admits an over-deadline success', async () => {
  let clock = 0,
    calls = 0;
  const observations = [];
  await assert.rejects(
    readPreStartFixtureOperation(
      operation,
      async ({ timeoutMs }) => {
        calls++;
        assert.equal(timeoutMs, 10);
        clock += 10;
        return { projects: [] };
      },
      { observations, now: () => clock, timeoutMs: 10 },
    ),
    /PRE_START_READ_TIMEOUT/,
  );
  assert.equal(calls, 1);
  assert.equal(observations[0].result, 'FAIL');
  assert.equal(observations[0].failure.code, 'PRE_START_READ_TIMEOUT');
});

test('deadline includes backoff and prevents another call after budget exhaustion', async () => {
  let clock = 0,
    calls = 0;
  await assert.rejects(
    readPreStartFixtureOperation(
      operation,
      async () => {
        calls++;
        clock += 60;
        throw error('CLI_NETWORK_ERROR');
      },
      { now: () => clock, timeoutMs: 300, pause: async () => assert.fail('no room for backoff') },
    ),
  );
  assert.equal(calls, 1);
});

test('scheduler overshoot never issues a later read', async () => {
  let clock = 0,
    calls = 0;
  await assert.rejects(
    readPreStartFixtureOperation(
      operation,
      async () => {
        calls++;
        throw error('CLI_NETWORK_ERROR');
      },
      {
        now: () => clock,
        timeoutMs: 1000,
        pause: async () => {
          clock += 1001;
        },
      },
    ),
    /PRE_START_READ_TIMEOUT/,
  );
  assert.equal(calls, 1);
});

test('writes, post-start reads, foreign operations and expanded budgets are rejected before callback', async () => {
  const never = () => assert.fail('unexpected read');
  for (const name of [
    'codebuild:start-build',
    'codebuild:update-project',
    'codebuild:create-project',
    'codebuild:batch-get-builds',
    'other:batch-get-projects',
  ])
    await assert.rejects(readPreStartFixtureOperation(name, never), /INVALID_PRE_START_READ_OPERATION/);
  for (const options of [
    { maxAttempts: 4 },
    { maxAttempts: 0 },
    { timeoutMs: 65001 },
    { timeoutMs: NaN },
    { timeoutMs: 0 },
  ])
    await assert.rejects(readPreStartFixtureOperation(operation, never, options), /INVALID_PRE_START_READ_BUDGET/);
});

test('CLI timeout is bounded and SDK retries remain disabled', () => {
  fixtureAws(['codebuild', 'batch-get-projects'], 'esgiot-infra', {
    timeoutMs: 17,
    spawn: (_cmd, args, options) => {
      assert.equal(options.timeout, 17);
      assert.equal(options.env.AWS_MAX_ATTEMPTS, '1');
      assert.ok(args.includes('--cli-read-timeout'));
      return { status: 0, stdout: '{"projects":[]}' };
    },
  });
  for (const timeoutMs of [0, 30001, NaN])
    assert.throws(
      () => fixtureAws([], 'esgiot-infra', { timeoutMs, spawn: () => assert.fail('unexpected spawn') }),
      /INVALID_FIXTURE_CLI_TIMEOUT/,
    );
});
