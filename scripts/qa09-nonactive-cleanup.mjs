import { seedCleanupAction } from './qa09-seed-recovery.mjs';
import {
  createOperationObserver,
  safeOperationError,
  cleanupIdentityOperations,
} from './qa09-operation-observation.mjs';

// Save the ledger before the bridge can launch a Build; never replay a failed or unknown start here.
export function createParentFixtureExecutor({ receipt, output, plan, runFixture, save, observe, progress }) {
  return async (action, { cleanup = false } = {}) => {
    const path = output + `.fixtures-${action}-${receipt.databaseBuilds.length}.json`;
    const row = { action, receipt: path, gate: 'RUNNING' };
    receipt.databaseBuilds.push(row);
    save();
    try {
      const run = () => runFixture({ ...plan(), action }, path, progress);
      const result = await (cleanup ? observe('database:' + action, run) : run());
      if (result.gate !== 'PASS') throw Error('FIXTURE_RESULT_NOT_VERIFIED');
      Object.assign(row, { buildId: result.build.id, gate: 'PASS' });
      save();
      return result.result;
    } catch (error) {
      Object.assign(row, { gate: 'FAIL', failure: safeOperationError(error) });
      save();
      throw error;
    }
  };
}

// Existing owned-ledger operations only: no retries, latest-Build lookup, or new identity.
export async function cleanupNonActiveParent(ctx) {
  const { receipt: r, save, db, check, refreshIdentity, api, created, seeded, baseline, devices, username } = ctx;
  const observe = createOperationObserver(r.cleanupOperations, save);
  const fail = (type, error, extra = {}) => {
    r.cleanup.push({ type, ...extra, result: 'FAIL', failure: safeOperationError(error) });
    save();
  };
  if (seeded)
    try {
      const observed = await db('observe', { cleanup: true });
      const action = seedCleanupAction(observed, devices);
      const result = action === 'cleanup' ? await db(action, { cleanup: true }) : observed;
      await observe('database:baseline-check', async () =>
        check(
          'original-device-certificate-baseline-preserved',
          JSON.stringify(result.originalFingerprints) === JSON.stringify(baseline),
        ),
      );
      r.cleanup.push({ type: 'database-fixtures', count: observed.devices.length, result: 'PASS' });
      save();
    } catch (error) {
      fail('database-fixtures', error);
    }
  if (created)
    try {
      await observe('identity:refresh', refreshIdentity);
    } catch (error) {
      fail('identity-renewal', error);
    }
  for (const c of [...r.customers].reverse())
    try {
      const path = '/api/v1/admin/customers/' + c.id;
      const current = await observe('http:customer-scope-' + c.suffix, async () => {
        const value = await api('cleanup-customer-scope-' + c.suffix, 'GET', path, 200);
        check('own-customer-name-' + c.suffix, value.data.name === r.prefix + '-' + c.suffix);
        return value;
      });
      await observe('http:customer-delete-' + c.suffix, () =>
        api('cleanup-customer-' + c.suffix, 'DELETE', path, 200, undefined, {
          'If-Match': String(current.data.version),
        }),
      );
      await observe('http:customer-absence-' + c.suffix, () =>
        api('verify-customer-gone-' + c.suffix, 'GET', path, 404),
      );
      r.cleanup.push({ type: 'customer', id: c.id, result: 'PASS' });
      save();
    } catch (error) {
      fail('customer', error, { id: c.id });
    }
  if (created)
    try {
      const identity = await cleanupIdentityOperations(
        (operation, run) =>
          observe(
            operation === 'cognito:GlobalSignOut' && !ctx.hasAccessToken()
              ? 'cognito:AdminUserGlobalSignOutCommand'
              : operation,
            run,
          ),
        {
          globalSignOut: () => (ctx.hasAccessToken() ? ctx.globalSignOut() : ctx.adminGlobalSignOut()),
          deleteUser: ctx.deleteUser,
          getUser: ctx.getUser,
        },
      );
      r.globalSignOut = identity.globalSignOut;
      r.cleanup.push({ type: 'identity', username, ...identity });
      save();
      check('own-superadmin-deleted', identity.absence === 'PASS');
    } catch (error) {
      fail('identity', error, { username });
    }
}

export function validateNonActiveParentCleanup(r) {
  const rows = r.cleanupOperations;
  const pass = (operation) => rows.some((x) => x.operation === operation && x.result === 'PASS');
  if (r.gate !== 'PASS' || !r.cleanup.length || r.cleanup.some((x) => x.result !== 'PASS') || !rows?.length)
    throw Error('PARENT_CLEANUP_NOT_COMPLETE');
  if (
    rows.some(
      (x, i) =>
        x.sequence !== i + 1 ||
        !Number.isSafeInteger(x.durationMs) ||
        x.durationMs < 0 ||
        !Number.isFinite(Date.parse(x.startedAt)) ||
        !Number.isFinite(Date.parse(x.finishedAt)) ||
        (x.result !== 'PASS' &&
          !(
            x.result === 'FAIL' &&
            x.operation === 'cognito:AdminGetUserCommand' &&
            x.expectedOutcome === 'ABSENT_IDENTITY' &&
            x.failure?.errorName === 'UserNotFoundException'
          )),
    )
  )
    throw Error('PARENT_CLEANUP_OPERATION_FAILED');
  if (
    r.globalSignOut !== 'PASS' ||
    !pass('identity:refresh') ||
    !(pass('cognito:GlobalSignOut') || pass('cognito:AdminUserGlobalSignOutCommand')) ||
    !pass('cognito:AdminDeleteUserCommand') ||
    !rows.some((x) => x.operation === 'cognito:AdminGetUserCommand' && x.expectedOutcome === 'ABSENT_IDENTITY') ||
    !r.databaseBuilds.length ||
    r.databaseBuilds.some((x) => x.gate !== 'PASS' || !x.buildId) ||
    !pass('database:observe') ||
    !pass('database:baseline-check')
  )
    throw Error('PARENT_CLEANUP_REQUIRED_PROOF');
  const database = r.cleanup.find((x) => x.type === 'database-fixtures');
  const identity = r.cleanup.find((x) => x.type === 'identity');
  if (
    !database ||
    ![0, 10].includes(database.count) ||
    (database.count === 10 && !pass('database:cleanup')) ||
    r.customers.length !== 2 ||
    new Set(r.customers.map((c) => c.suffix)).size !== 2 ||
    !r.customers.every(
      (c) => ['a', 'b'].includes(c.suffix) && r.cleanup.some((x) => x.type === 'customer' && x.id === c.id),
    ) ||
    !identity ||
    identity.username !== r.prefix + '-platformsuperadmin@example.invalid' ||
    identity.globalSignOut !== 'PASS' ||
    identity.deletion !== 'PASS' ||
    identity.absence !== 'PASS'
  )
    throw Error('PARENT_OWN_CLEANUP_LEDGER_REQUIRED');
  for (const c of r.customers)
    if (!['scope', 'delete', 'absence'].every((name) => pass('http:customer-' + name + '-' + c.suffix)))
      throw Error('PARENT_CUSTOMER_CLEANUP_PROOF');
  return { gate: 'PASS', scope: 'ORIGINAL_PARENT_CLEANUP_OPERATIONS_ONLY', operations: rows.length };
}
