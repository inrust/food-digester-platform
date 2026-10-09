import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupNonActiveParent,
  createParentFixtureExecutor,
  validateNonActiveParentCleanup,
} from './qa09-nonactive-cleanup.mjs';
import { createOperationObserver } from './qa09-operation-observation.mjs';

function fixture(fault = '') {
  const prefix = 'qa09-1234567890abcdef';
  const r = {
    prefix,
    checks: [],
    cleanup: [],
    cleanupOperations: [],
    databaseBuilds: [],
    customers: ['a', 'b'].map((suffix) => ({ id: suffix, suffix })),
  };
  const devices = Array.from({ length: 10 }, (_, i) => prefix + '-' + String(i + 1).padStart(2, '0'));
  const calls = [],
    saves = [],
    baseline = { device: 'unchanged', certificate: 'unchanged' };
  const fail = () => {
    throw Object.assign(Error('SENSITIVE_SENTINEL'), {
      name: 'AccessDeniedException',
      $metadata: { requestId: '12345678-1234-1234-1234-123456789abc', httpStatusCode: 403 },
    });
  };
  const save = () => saves.push(structuredClone(r));
  const ctx = {
    receipt: r,
    save,
    devices,
    baseline,
    username: prefix + '-platformsuperadmin@example.invalid',
    created: true,
    seeded: true,
    check: (id, ok) => {
      r.checks.push({ id, result: ok ? 'PASS' : 'FAIL' });
      if (!ok) fail();
    },
    refreshIdentity: async () => {
      calls.push('refresh');
      if (fault === 'refresh') fail();
    },
    api: async (id, method, path, status, body, headers) => {
      calls.push(id);
      if (fault === id) fail();
      if (method === 'DELETE') assert.equal(headers['If-Match'], '7');
      return { data: { name: fault === 'scope' ? 'foreign' : prefix + '-' + path.split('/').at(-1), version: 7 } };
    },
    hasAccessToken: () => fault !== 'no-token',
    globalSignOut: async () => {
      calls.push('signout');
      if (fault === 'signout') fail();
    },
    adminGlobalSignOut: async () => calls.push('admin-signout'),
    deleteUser: async () => {
      calls.push('delete');
      if (fault === 'delete') fail();
    },
    getUser: async () => {
      calls.push('get');
      if (fault === 'get') fail();
      if (fault !== 'survives') throw Object.assign(Error('SENSITIVE_SENTINEL'), { name: 'UserNotFoundException' });
    },
  };
  ctx.db = createParentFixtureExecutor({
    receipt: r,
    output: '/tmp/not-executed',
    plan: () => ({ prefix, devices }),
    save,
    observe: createOperationObserver(r.cleanupOperations, save),
    runFixture: async (plan) => {
      assert.equal(r.databaseBuilds.at(-1).gate, 'RUNNING');
      assert.equal(saves.at(-1).databaseBuilds.at(-1).action, plan.action);
      calls.push(plan.action);
      if (fault === plan.action) fail();
      return {
        gate: 'PASS',
        build: { id: 'exact-' + plan.action },
        result: {
          devices: devices.map((id) => ({ id, serial_number: id })),
          certificates: [],
          requests: [],
          originalFingerprints: fault === 'baseline' ? {} : baseline,
        },
      };
    },
  });
  return { ctx, r, calls, saves };
}
test('parent success persists entries before launch and observes each owned cleanup without changing writes', async () => {
  const { ctx, r, calls } = fixture();
  await cleanupNonActiveParent(ctx);
  assert.ok(r.cleanup.every((x) => x.result === 'PASS'));
  assert.equal(r.cleanup.length, 4);
  assert.deepEqual(calls, [
    'observe',
    'cleanup',
    'refresh',
    'cleanup-customer-scope-b',
    'cleanup-customer-b',
    'verify-customer-gone-b',
    'cleanup-customer-scope-a',
    'cleanup-customer-a',
    'verify-customer-gone-a',
    'signout',
    'delete',
    'get',
  ]);
  assert.equal(r.cleanupOperations.length, 13);
  r.gate = 'PASS';
  assert.equal(validateNonActiveParentCleanup(r).gate, 'PASS');
  const missing = structuredClone(r);
  missing.cleanupOperations = [];
  assert.throws(() => validateNonActiveParentCleanup(missing));
  const failed = structuredClone(r);
  failed.databaseBuilds[0].gate = 'FAIL';
  assert.throws(() => validateNonActiveParentCleanup(failed));
  const missingCleanup = structuredClone(r);
  missingCleanup.cleanupOperations = missingCleanup.cleanupOperations
    .filter((x) => x.operation !== 'database:cleanup')
    .map((x, i) => ({ ...x, sequence: i + 1 }));
  assert.throws(() => validateNonActiveParentCleanup(missingCleanup));
  assert.equal(r.databaseBuilds.length, 2);
  assert.ok(r.databaseBuilds.every((x) => x.gate === 'PASS'));
  assert.equal(r.cleanupOperations.at(-1).expectedOutcome, 'ABSENT_IDENTITY');
  assert.ok(!JSON.stringify(r).includes('SENSITIVE_SENTINEL'));
});
for (const fault of [
  'observe',
  'cleanup',
  'baseline',
  'refresh',
  'cleanup-customer-b',
  'verify-customer-gone-b',
  'scope',
  'signout',
  'delete',
  'get',
  'survives',
]) {
  test('parent keeps ' + fault + ' failure, continues remaining cleanup, and cannot close PASS', async () => {
    const { ctx, r, calls } = fixture(fault);
    await cleanupNonActiveParent(ctx);
    assert.ok(r.cleanup.some((x) => x.result === 'FAIL'));
    r.gate = 'PASS'; // Even a forged summary must not admit failed operations.
    assert.throws(() => validateNonActiveParentCleanup(r));
    assert.ok(calls.includes('delete') && calls.includes('get'));
    if (fault === 'scope') assert.ok(!calls.includes('cleanup-customer-b') && !calls.includes('cleanup-customer-a'));
    if (['observe', 'cleanup'].includes(fault)) assert.equal(r.databaseBuilds.at(-1).gate, 'FAIL');
    if (fault === 'signout') {
      assert.equal(r.globalSignOut, 'FAIL');
      assert.equal(r.cleanup.find((x) => x.type === 'identity').absence, 'PASS');
    }
    assert.ok(!JSON.stringify(r).includes('SENSITIVE_SENTINEL'));
  });
}
test('no session uses only owned admin signout and records the actual SDK operation', async () => {
  const { ctx, r, calls } = fixture('no-token');
  await cleanupNonActiveParent(ctx);
  assert.ok(r.cleanup.every((x) => x.result === 'PASS'));
  assert.ok(calls.includes('admin-signout') && !calls.includes('signout'));
  assert.ok(r.cleanupOperations.some((x) => x.operation === 'cognito:AdminUserGlobalSignOutCommand'));
});
test('failed or unknown startup is persisted once without restarting or guessing a Build ID', async () => {
  const { r, saves } = fixture();
  let starts = 0;
  const run = createParentFixtureExecutor({
    receipt: r,
    output: '/tmp/unknown',
    plan: () => ({}),
    save: () => saves.push(structuredClone(r)),
    runFixture: async () => {
      starts++;
      throw Object.assign(Error('private-token'), { name: 'TimeoutError', code: 'AWS_start-build_CLI_READ_TIMEOUT' });
    },
  });
  await assert.rejects(run('business-seed-devices'), /private-token/);
  assert.equal(starts, 1);
  assert.equal(r.databaseBuilds[0].gate, 'FAIL');
  assert.equal(r.databaseBuilds[0].buildId, undefined);
  assert.equal(saves[0].databaseBuilds[0].gate, 'RUNNING');
  assert.ok(!JSON.stringify(r).includes('private-token'));
});
