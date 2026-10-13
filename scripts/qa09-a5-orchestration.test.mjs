import test from 'node:test';
import assert from 'node:assert/strict';
import { waitOwnDaily } from './qa09-wait-own-daily.mjs';
import { prepareOwnReplayOperator } from './qa09-own-replay-operator.mjs';
const prefix = 'qa09-1234567890abcdef',
  userId = '11111111-1111-4111-8111-111111111111',
  customerId = '22222222-2222-4222-8222-222222222222';
const context = () => ({
  receipt: { prefix, devices: [prefix + '-01'], customers: [{ id: customerId }] },
  cognito: {
    async send() {
      return {};
    },
  },
});
test('daily wait consumes actual bounded API envelope and times out without shared invocations', async () => {
  const ctx = context(),
    r = {};
  let now = 0,
    calls = 0;
  ctx.refreshIdentity = async () => {};
  ctx.api = async (id, method, path) => {
    calls++;
    assert.equal(method, 'GET');
    assert.ok(path.includes('deviceId=' + prefix + '-01'));
    return {
      data: calls === 2 ? [{ deviceId: prefix + '-01', customerId }] : [],
      meta: { nextCursor: null, requestId: 'r', timestamp: '2026-10-13T10:00:00.000Z' },
    };
  };
  await waitOwnDaily(ctx, r, () => {}, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    budgetMs: 60000,
  });
  assert.equal(calls, 2);
  assert.equal(r.dailyWait.gate, 'PASS_NATURAL_OWN_DAILY_VISIBLE');
  assert.equal(r.dailyWait.sharedWorkerInvocations, 0);
  calls = 0;
  now = 0;
  await assert.rejects(
    waitOwnDaily(ctx, {}, () => {}, {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      budgetMs: 1,
    }),
    /OWN_DAILY_NOT_READY/,
  );
});
test('unknown Operator preparation freezes cleanup; no fake login or destructive recovery', async () => {
  const ctx = context(),
    r = {};
  let logins = 0;
  await assert.rejects(
    prepareOwnReplayOperator(ctx, r, () => {}, '/tmp/unit', {
      provision: async () => {
        throw Error('UNKNOWN_USER_SEED_START_NO_RESTART');
      },
      login: async () => {
        logins++;
      },
    }),
    /UNKNOWN_USER/,
  );
  assert.equal(ctx.receipt.cleanupHold, 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE');
  assert.equal(logins, 0);
});
test('known Operator cleanup checks exact disabled tombstone and stops unknown disable without retry', async () => {
  const ctx = context(),
    r = {};
  const requests = [];
  ctx.api = async (id, method, path) => {
    requests.push({ method, path });
    return { data: { userId, email: prefix + '-h01-platformoperator@example.invalid', status: 'DISABLED' } };
  };
  const operator = await prepareOwnReplayOperator(ctx, r, () => {}, '/tmp/unit', {
    provision: async ({ own }) => {
      own.userId = userId;
    },
    login: async () => ({ status: 'authenticated', session: { idToken: 'memory-only' } }),
  });
  assert.equal(r.operator.realSrp, true);
  assert.equal((await operator.cleanup()).gate, 'PASS_DISABLED_TOMBSTONE_AND_COGNITO_DELETED');
  assert.equal(requests.length, 2);
  const ctx2 = context(),
    r2 = {};
  let writes = 0;
  ctx2.api = async () => {
    writes++;
    throw Error('TIMEOUT');
  };
  const other = await prepareOwnReplayOperator(ctx2, r2, () => {}, '/tmp/unit', {
    provision: async ({ own }) => {
      own.userId = userId;
    },
    login: async () => ({ status: 'authenticated', session: { idToken: 'memory-only' } }),
  });
  await assert.rejects(other.cleanup(), /TIMEOUT/);
  assert.equal((await other.cleanup()).gate, 'BLOCKED_UNKNOWN_WRITE');
  assert.equal(writes, 1);
  assert.equal(ctx2.receipt.cleanupHold, 'UNKNOWN_OR_RUNNING_RELIABILITY_WRITE');
});
