import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFixture, fixtureAws } from './qa09-ten-device-bridge.mjs';
import { readStartedFixtureBuild, verifyStartedBuild } from './qa09-started-build-read.mjs';
import {
  createOperationObserver,
  safeOperationError,
  classifySafeCliError,
  cleanupIdentityOperations,
} from './qa09-operation-observation.mjs';
const prefix = 'qa09-1234567890abcdef';
const prep = () =>
  prepareFixture({
    prefix,
    action: 'business-cleanup',
    devices: Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`),
    customers: [
      { id: '11111111-1111-1111-1111-111111111111', name: prefix + '-a', suffix: 'a' },
      { id: '22222222-2222-2222-2222-222222222222', name: prefix + '-b', suffix: 'b' },
    ],
    businessBaseline: [{ table: 'contracts', count: '0', fingerprint: 'a'.repeat(32) }],
  });
const id = 'fdp-test-qa09-ten-device-fixtures:11111111-1111-1111-1111-111111111111';
const build = (p, status = 'SUCCEEDED') => ({
  id,
  status,
  phase: 'COMPLETED',
  buildspec: p.project.source.buildspec,
  sourceType: 'NO_SOURCE',
  serviceRole: p.project.serviceRole,
  vpcConfig: p.project.vpcConfig,
  environment: p.project.environment,
  logs: { groupName: 'reviewed', streamName: 'own' },
});
const timeout = () => Object.assign(Error('AWS_OPERATION_FAILED'), { code: 'AWS_batch-get-builds_CLI_READ_TIMEOUT' });
test('read recovery preserves original timeout, reads only one started ID and never replays a mutation', async () => {
  const p = prep(),
    rows = [],
    reads = [];
  let ticks = 0;
  const r = await readStartedFixtureBuild(
    p,
    id,
    async (requested) => {
      reads.push(requested);
      if (reads.length === 1) throw timeout();
      return build(p, reads.length === 2 ? 'IN_PROGRESS' : 'SUCCEEDED');
    },
    {
      observations: rows,
      pause: async (ms) => {
        ticks += ms;
      },
      now: () => ticks,
    },
  );
  assert.deepEqual(reads, [id, id, id]);
  assert.equal(r.readGate, 'RECOVERED');
  assert.equal(r.originalReadGate, 'FAIL');
  assert.equal(rows[0].result, 'FAIL');
  assert.equal(rows[0].failure.code, 'AWS_batch-get-builds_CLI_READ_TIMEOUT');
  assert.equal(r.readRecoveries, 1);
});
test('known authorization, expired SSO, invalid JSON and unknown failures never retry', async () => {
  for (const code of [
    'AWS_batch-get-builds_AccessDeniedException',
    'AWS_batch-get-builds_SSO_SESSION_EXPIRED',
    'CLI_INVALID_JSON',
    'AWS_batch-get-builds_CLI_FAILED',
  ]) {
    let reads = 0;
    const e = Object.assign(Error('AWS_OPERATION_FAILED'), { code });
    await assert.rejects(
      readStartedFixtureBuild(prep(), id, async () => {
        reads++;
        throw e;
      }),
      (actual) => actual === e,
    );
    assert.equal(reads, 1);
  }
});
test('two read recoveries are the global bound, repeated timeout remains FAIL', async () => {
  let reads = 0;
  await assert.rejects(
    readStartedFixtureBuild(
      prep(),
      id,
      async () => {
        reads++;
        throw timeout();
      },
      { pause: async () => {} },
    ),
    /AWS_OPERATION_FAILED/,
  );
  assert.equal(reads, 3);
});
test('started Build waiting is bounded by polls and elapsed time; non-success terminal status never admits cleanup', async () => {
  const p = prep();
  let reads = 0,
    clock = 0;
  await assert.rejects(
    readStartedFixtureBuild(
      p,
      id,
      async () => {
        reads++;
        return build(p, 'IN_PROGRESS');
      },
      {
        maxPolls: 2,
        pause: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    ),
    /BUILD_TIMEOUT/,
  );
  assert.equal(reads, 2);
  reads = 0;
  clock = 0;
  await assert.rejects(
    readStartedFixtureBuild(
      p,
      id,
      async () => {
        reads++;
        return build(p, 'IN_PROGRESS');
      },
      {
        timeoutMs: 5000,
        pause: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      },
    ),
    /BUILD_TIMEOUT/,
  );
  assert.equal(reads, 1);
  for (const status of ['FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'])
    await assert.rejects(
      readStartedFixtureBuild(p, id, async () => build(p, status)),
      /NOT_VERIFIED/,
    );
});
test('every cloud ownership field and raw Plan is required before reading results', async () => {
  const p = prep();
  const corrupt = [
    null,
    { ...build(p), id: id.replace('11111111', '22222222') },
    { ...build(p), serviceRole: 'foreign' },
    { ...build(p), sourceType: 'GITHUB' },
    { ...build(p), vpcConfig: {} },
    { ...build(p), buildspec: 'foreign' },
    { ...build(p), environment: {} },
  ];
  for (const b of corrupt)
    await assert.rejects(
      readStartedFixtureBuild(p, id, async () => b),
      /NOT_FOUND|BINDING_MISMATCH/,
    );
  for (const field of ['QA09_FIXTURE_HASH', 'QA09_FIXTURE_PLAN_B64']) {
    for (const duplicate of [false, true]) {
      const b = structuredClone(build(p));
      if (duplicate)
        b.environment.environmentVariables.push(b.environment.environmentVariables.find((v) => v.name === field));
      else b.environment.environmentVariables.find((v) => v.name === field).value = 'foreign';
      assert.throws(() => verifyStartedBuild(b, p, id), /BINDING_MISMATCH/);
    }
  }
  const reordered = structuredClone(build(p));
  reordered.environment.environmentVariables.find((v) => v.name === 'QA09_FIXTURE_PLAN_B64').value = Buffer.from(
    JSON.stringify({ action: p.plan.action, ...p.plan }),
  ).toString('base64');
  assert.throws(() => verifyStartedBuild(reordered, p, id), /BINDING_MISMATCH/);
  let reads = 0;
  await assert.rejects(
    readStartedFixtureBuild({ ...p, buildspecHash: '0'.repeat(64) }, id, () => {
      reads++;
    }),
    /BINDING/,
  );
  assert.equal(reads, 0);
});
test('CLI failure records exit/signal/timing, classifies recognized errors and stores no stderr or credentials', () => {
  const secret = 'sensitive-password-token';
  let args, options;
  assert.throws(
    () =>
      fixtureAws(['codebuild', 'batch-get-builds', '--ids', id], 'esgiot-readonly', {
        spawn: (_exe, a, o) => {
          args = a;
          options = o;
          return { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stderr: secret, stdout: secret };
        },
        now: () => 10,
      }),
    (e) => {
      const safe = safeOperationError(e);
      assert.equal(safe.cli.signal, 'SIGTERM');
      assert.equal(safe.cli.spawnErrorCode, 'ETIMEDOUT');
      assert.equal(safe.code, 'AWS_batch-get-builds_CLI_READ_TIMEOUT');
      assert.ok(!JSON.stringify(safe).includes(secret));
      return true;
    },
  );
  assert.equal(options.timeout, 30000);
  assert.equal(options.env.AWS_MAX_ATTEMPTS, '1');
  assert.ok(args.includes('--cli-read-timeout'));
  assert.equal(classifySafeCliError(`An error occurred (AccessDeniedException) ${secret}`), 'AccessDeniedException');
  assert.equal(classifySafeCliError(`An error occurred (${secret})`), 'CLI_FAILED');
  assert.equal(classifySafeCliError('Token has expired and refresh failed'), 'SSO_SESSION_EXPIRED');
  assert.throws(
    () =>
      fixtureAws(['codebuild', 'batch-get-builds'], 'esgiot-readonly', {
        spawn: () => ({ status: 0, stdout: secret }),
      }),
    (e) => safeOperationError(e).code === 'CLI_INVALID_JSON',
  );
});
test('cleanup observer persists each success/failure and preserves failure identity without raw message, stack or input', async () => {
  const rows = [],
    saved = [];
  let clock = 0;
  const observe = createOperationObserver(
    rows,
    () => saved.push(structuredClone(rows)),
    () => clock++,
  );
  const response = { $metadata: { requestId: '11111111-1111-1111-1111-111111111111' }, token: 'not-saved' };
  assert.equal(await observe('cognito:AdminDeleteUserCommand', async () => response), response);
  const e = Object.assign(Error('secret SQL or password'), {
    name: 'AccessDeniedException',
    code: 'untrusted-secret',
    cause: { code: 'ECONNRESET', message: 'secret' },
    $metadata: { requestId: response.$metadata.requestId, httpStatusCode: 403, attempts: 1, totalRetryDelay: 0 },
  });
  await assert.rejects(
    observe('cognito:GlobalSignOut', async () => {
      throw e;
    }),
    (actual) => actual === e,
  );
  assert.deepEqual(
    rows.map((r) => r.result),
    ['PASS', 'FAIL'],
  );
  assert.equal(rows[1].failure.errorName, 'AccessDeniedException');
  assert.equal(rows[1].failure.causeCode, 'ECONNRESET');
  assert.equal(rows[1].failure.httpStatusCode, 403);
  assert.equal(saved.length, 4);
  assert.ok(!/secret|not-saved|stack|password/.test(JSON.stringify(rows)));
});

test('sign-out failure still deletes and verifies own identity, retains failure and cannot admit cleanup PASS', async () => {
  const rows = [],
    calls = [];
  const observe = createOperationObserver(rows);
  const denied = Object.assign(Error('private message'), { name: 'NotAuthorizedException' });
  const absent = Object.assign(Error('private username'), { name: 'UserNotFoundException' });
  const result = await cleanupIdentityOperations(observe, {
    globalSignOut: async () => {
      calls.push('signout');
      throw denied;
    },
    deleteUser: async () => {
      calls.push('delete');
    },
    getUser: async () => {
      calls.push('get');
      throw absent;
    },
  });
  assert.deepEqual(calls, ['signout', 'delete', 'get']);
  assert.equal(result.result, 'FAIL');
  assert.equal(result.deletion, 'PASS');
  assert.equal(result.absence, 'PASS');
  assert.equal(result.failures[0].errorName, 'NotAuthorizedException');
  assert.equal(rows[2].expectedOutcome, 'ABSENT_IDENTITY');
  assert.equal(rows[2].result, 'FAIL');
  assert.ok(!JSON.stringify({ rows, result }).includes('private'));
});
test('only UserNotFound proves absence, failed delete is retained, and surviving identity fails closed', async () => {
  for (const mode of ['absent', 'delete-failed', 'get-denied', 'survives']) {
    const rows = [];
    const result = await cleanupIdentityOperations(createOperationObserver(rows), {
      globalSignOut: async () => {},
      deleteUser: async () => {
        if (mode === 'delete-failed') throw Object.assign(Error('redacted'), { name: 'AccessDeniedException' });
      },
      getUser: async () => {
        if (mode !== 'survives')
          throw Object.assign(Error('redacted'), {
            name: mode === 'get-denied' ? 'AccessDeniedException' : 'UserNotFoundException',
          });
      },
    });
    assert.equal(result.result, mode === 'absent' ? 'PASS' : 'FAIL');
    assert.equal(rows.length, 3);
  }
});
