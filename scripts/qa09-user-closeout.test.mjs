import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { executeFixture, validatePlan } from './qa09-ten-device-db.mjs';
import { provisionSuppressedOwnUser } from './run-qa09-user-closeout-target.mjs';

const prefix = 'qa09-1234567890abcdef';
const customers = ['a', 'b'].map((suffix, i) => ({
  id: i ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111',
  name: prefix + '-' + suffix,
  suffix,
}));
const subject = '44444444-4444-4444-8444-444444444444';
const userId = '33333333-3333-4333-8333-333333333333';
function plan(role = 'CustomerAdmin') {
  return {
    action: 'business-seed-user',
    prefix,
    customers,
    devices: Array.from({ length: 10 }, (_, i) => prefix + '-' + String(i + 1).padStart(2, '0')),
    ownUser: {
      userId,
      cognitoSub: subject,
      email: prefix + '-h01-' + role.toLowerCase() + '@example.invalid',
      role,
      customerId: role === 'CustomerAdmin' ? customers[0].id : role === 'CustomerViewer' ? customers[1].id : null,
      identityProvisioning: 'COGNITO_SUPPRESS_REAL_SUBJECT',
    },
  };
}
async function database() {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE customers(id text PRIMARY KEY,name text,deleted_at timestamptz);
    CREATE TABLE devices(id text); CREATE TABLE device_certificates(id text,device_id text);
    CREATE TABLE users(id text PRIMARY KEY,email text UNIQUE,display_name text,cognito_sub text UNIQUE,status text,updated_at timestamptz);
    CREATE TABLE roles(code text PRIMARY KEY);
    CREATE TABLE user_roles(user_id text REFERENCES users(id),role_code text REFERENCES roles(code));
    CREATE TABLE user_scopes(id text PRIMARY KEY,user_id text REFERENCES users(id),customer_id text REFERENCES customers(id));
    INSERT INTO roles VALUES('CustomerAdmin'),('CustomerViewer'),('Auditor'),('PlatformOperator'),('PlatformSuperAdmin');
    INSERT INTO users VALUES('original','original@example.invalid','original','original-sub','ACTIVE',now());
    INSERT INTO user_roles VALUES('original','Auditor');`);
  for (const c of customers) await pg.query('INSERT INTO customers(id,name) VALUES($1,$2)', [c.id, c.name]);
  const client = {
    query: async (sql, args) => {
      if (sql === 'SELECT current_database() AS database') return { rows: [{ database: 'fdp' }], rowCount: 1 };
      const r = await pg.query(sql, args);
      return { rows: r.rows, rowCount: /^SELECT/i.test(sql) ? r.rows.length : r.affectedRows };
    },
  };
  return { pg, client };
}
test('only exact fresh suppressed identities and matching customer scopes are allowed', () => {
  validatePlan(plan());
  for (const patch of [
    { email: 'someone@example.com' },
    { cognitoSub: 'fake' },
    { role: 'Admin' },
    { customerId: customers[1].id },
    { identityProvisioning: 'INVITE' },
    { userId: 'foreign' },
  ])
    assert.throws(() => validatePlan({ ...plan(), ownUser: { ...plan().ownUser, ...patch } }));
  for (const role of ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerViewer']) validatePlan(plan(role));
});
test('real SQL seeds only INVITED and preserves outside users; duplicate seed never replays', async () => {
  const { pg, client } = await database();
  try {
    const original = (await pg.query("SELECT * FROM users WHERE id='original'")).rows;
    const result = await executeFixture(client, plan());
    assert.equal(result.user.status, 'INVITED');
    assert.equal(result.invitationSent, false);
    assert.equal(result.naturalActivationClaimed, false);
    assert.deepEqual((await pg.query("SELECT * FROM users WHERE id='original'")).rows, original);
    assert.deepEqual((await pg.query('SELECT customer_id FROM user_scopes')).rows, [{ customer_id: customers[0].id }]);
    await assert.rejects(executeFixture(client, plan()), /OWN_USER_ALREADY_EXISTS/);
  } finally {
    await pg.close();
  }
});
test('foreign customer and outside-user trigger mutation roll back all seed writes', async () => {
  const { pg, client } = await database();
  try {
    await pg.exec(`UPDATE customers SET name='foreign' WHERE name LIKE '%-a'`);
    await assert.rejects(executeFixture(client, plan()), /CUSTOMER_SCOPE_DRIFT/);
    await pg.query('UPDATE customers SET name=$1 WHERE id=$2', [customers[0].name, customers[0].id]);
    await pg.exec(`CREATE FUNCTION corrupt_original() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE users SET status='DISABLED' WHERE id='original'; RETURN NEW; END $$;
      CREATE TRIGGER corrupt AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION corrupt_original();`);
    await assert.rejects(executeFixture(client, plan()), /OWN_USER_OUTSIDE_FINGERPRINT_DRIFT/);
    assert.equal((await pg.query('SELECT * FROM users WHERE id=$1', [userId])).rows.length, 0);
    assert.equal((await pg.query("SELECT status FROM users WHERE id='original'")).rows[0].status, 'ACTIVE');
  } finally {
    await pg.close();
  }
});
test('identity provisioning suppresses delivery, requires real returned subject, and cannot act on foreign names', async () => {
  class Create {}
  class Group {}
  const sdk = { AdminCreateUserCommand: Create, AdminAddUserToGroupCommand: Group };
  const calls = [];
  const own = { ...plan().ownUser };
  delete own.cognitoSub;
  const receipt = { outputPath: '/tmp/qa09-unit-only' };
  const ctx = {
    prefix,
    own,
    customers,
    sdk,
    receipt,
    save() {},
    call: async (Cmd, input) => {
      calls.push({ Cmd, input });
      return { User: { Attributes: [{ Name: 'sub', Value: subject }] } };
    },
  };
  const fixture = async (p) => ({
    gate: 'PASS',
    result: { invitationSent: false, user: { userId: p.ownUser.userId, status: 'INVITED' } },
  });
  // A fabricated success without the exact source, scope and successful Build metadata is refused.
  await assert.rejects(provisionSuppressedOwnUser(ctx, fixture), /OWN_USER_FIXTURE_NOT_BOUND/);
  assert.equal(own.cognitoSub, subject);
  assert.notEqual(own.preparedUserId, own.cognitoSub);
  assert.equal(calls[0].input.MessageAction, 'SUPPRESS');
  assert.equal(calls[0].input.DesiredDeliveryMediums, undefined);
  assert.equal(calls.length, 2);
  const noCalls = {
    ...ctx,
    own: { ...own, email: 'foreign@example.com' },
    call: async () => {
      throw Error('MUST_NOT_CALL');
    },
  };
  await assert.rejects(provisionSuppressedOwnUser(noCalls, fixture), /EXACT_SUPPRESSED_OWN_USER_REQUIRED/);
  await assert.rejects(
    provisionSuppressedOwnUser({ ...ctx, call: async () => ({ User: { Attributes: [] } }) }, fixture),
    /REAL_COGNITO_SUBJECT_REQUIRED/,
  );
});

test('response rejection is owned even when the browser action fails first', async () => {
  const { observeUserAction } = await import('./qa09-user-closeout-browser.mjs');
  let rejectResponse;
  const response = new Promise((resolve, reject) => {
    rejectResponse = reject;
  });
  await assert.rejects(
    observeUserAction(response, async () => {
      throw Error('CLICK_FAILED');
    }),
    /CLICK_FAILED/,
  );
  rejectResponse(Error('LATE_RESPONSE_TIMEOUT'));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    observeUserAction(Promise.reject(Error('RESPONSE_TIMEOUT')), () => {}),
    /RESPONSE_TIMEOUT/,
  );
  assert.equal(await observeUserAction(Promise.resolve(200), () => {}), 200);
});

test('unknown fixture start is preserved and surfaced as a stop condition without replay', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'qa09-user-unknown-'));
  let starts = 0;
  const receipt = { outputPath: join(dir, 'target') };
  const own = { ...plan().ownUser };
  try {
    const fixture = async (p, path) => {
      starts++;
      writeFileSync(
        path,
        JSON.stringify({ gate: 'FAIL', failure: { kind: 'START_OUTCOME_UNCONFIRMED', startedBuildMayStillRun: true } }),
      );
      throw Error('TIMEOUT');
    };
    await assert.rejects(
      provisionSuppressedOwnUser(
        {
          prefix,
          own,
          customers,
          receipt,
          save() {},
          sdk: { AdminCreateUserCommand: class {}, AdminAddUserToGroupCommand: class {} },
          call: async () => ({ User: { Attributes: [{ Name: 'sub', Value: subject }] } }),
        },
        fixture,
      ),
      /UNKNOWN_USER_SEED_START_NO_RESTART/,
    );
    assert.equal(starts, 1);
    assert.equal(receipt.fixtureBuilds[0].startGate, 'UNKNOWN');
    assert.equal(JSON.parse(readFileSync(receipt.fixtureBuilds[0].receipt)).gate, 'FAIL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('cleanup recovery rejects foreign identities and sites before any AWS operation', async () => {
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'qa09-cleanup-guard-'));
  try {
    for (const patch of [
      { prefix: 'foreign' },
      { users: [{ ...plan().ownUser, email: 'foreign@example.com', preparedUserId: userId }] },
      { sites: [{ id: userId, name: 'foreign', customerId: customers[0].id }] },
    ]) {
      const input = join(dir, 'input.json'),
        output = join(dir, 'never-output.json');
      writeFileSync(
        input,
        JSON.stringify({
          prefix,
          userProvisioningMode: 'SUPPRESSED_COGNITO_AND_INVITED_DATABASE_FIXTURE',
          originalUsers: { sha256: 'a'.repeat(64) },
          users: [],
          customers,
          sites: [],
          ...patch,
        }),
      );
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/recover-qa09-user-closeout.mjs', input, output],
        { encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: dir } },
      );
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(output), false);
      assert.match(
        result.stderr,
        /EXACT_OWN_USER_RECEIPT_REQUIRED|OWN_BUSINESS_USER_SCOPE_REQUIRED|OWN_SESSION_SITE_REQUIRED/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
