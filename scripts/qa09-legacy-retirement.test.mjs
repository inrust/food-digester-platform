import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { ALLOWED, retireLegacy, validateApproval } from './qa09-retire-legacy-onboarding.mjs';
const plan = {
  ...JSON.parse(
    readFileSync(new URL('../docs/audit/evidence/qa-09-csr-migration-change-request-2026-10-02.json', import.meta.url)),
  ),
  status: 'APPROVED',
  snapshot: {
    Status: 'available',
    Encrypted: true,
    DBInstanceIdentifier: 'fdp-test-db',
    SnapshotType: 'manual',
    DBSnapshotArn: 'arn:aws:rds:ap-southeast-1:065986019555:snapshot:fdp-test-qa09-pre-csr-20261002-test',
  },
};
async function database() {
  const db = new PGlite();
  await db.exec(
    "CREATE TABLE devices(id text PRIMARY KEY, serial_number text UNIQUE, lifecycle_status text); CREATE TABLE onboarding_requests(id text PRIMARY KEY,status text,serial_number text); CREATE TABLE onboarding_provisioning_jobs(id text PRIMARY KEY,request_id text UNIQUE REFERENCES onboarding_requests(id),status text,issued_certificate_id text);CREATE TABLE device_certificates(id text PRIMARY KEY,status text,device_id text,fingerprint text);CREATE TABLE users(id text PRIMARY KEY,name text);INSERT INTO users VALUES('existing','Keep');",
  );
  for (const [i, r] of ALLOWED.entries()) {
    await db.query('INSERT INTO devices VALUES($1,$2,$3)', [r.device_id, 'serial-' + i, 'Onboarded']);
    await db.query('INSERT INTO onboarding_requests VALUES($1,$2,$3)', [r.request_id, 'APPROVED', 'serial-' + i]);
    await db.query('INSERT INTO onboarding_provisioning_jobs VALUES($1,$2,$3,$4)', [
      r.job_id,
      r.request_id,
      'COMPLETED',
      r.issued_certificate_id,
    ]);
    await db.query('INSERT INTO device_certificates (id,status) VALUES($1,$2)', [r.issued_certificate_id, 'ACTIVE']);
  }
  // PGlite's fixed local database is postgres; only the deployment identity read is
  // adapted here. Locks, parameterized deletes, FK behavior and rollback use SQL.
  const client = {
    async query(sql, params) {
      if (sql === 'SELECT current_database() AS database') return { rows: [{ database: 'fdp' }] };
      const r = await db.query(sql, params);
      return { ...r, rowCount: r.affectedRows ?? r.rows.length };
    },
  };
  return { db, client };
}
test('snapshot must be available encrypted manual and exact whitelist cannot expand', () => {
  validateApproval(plan);
  for (const p of [
    { ...plan, status: 'NOT_APPROVED' },
    { ...plan, snapshot: { ...plan.snapshot, Status: 'creating' } },
    { ...plan, snapshot: { ...plan.snapshot, Encrypted: false } },
    { ...plan, requestAndJobWhitelist: [...plan.requestAndJobWhitelist, plan.requestAndJobWhitelist[0]] },
  ])
    assert.throws(() => validateApproval(p));
});
test('real local SQL retires exactly two jobs/requests and preserves every other table', async () => {
  const { db, client } = await database();
  try {
    const r = await retireLegacy(client, plan);
    assert.equal(r.deletedRequests.length, 2);
    assert.equal(r.deletedJobs.length, 2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM onboarding_requests')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM device_certificates')).rows[0].n, 2);
    assert.equal(r.preservedTables.users.count, '1');
    await assert.rejects(() => retireLegacy(client, plan), /LIVE_WHITELIST_OR_STATE_DRIFT/);
  } finally {
    await db.close();
  }
});
test('live status drift aborts with original rows intact', async () => {
  const { db, client } = await database();
  try {
    await db.query("UPDATE onboarding_provisioning_jobs SET status='PROCESSING' WHERE id=$1", [ALLOWED[0].job_id]);
    await assert.rejects(() => retireLegacy(client, plan), /LIVE_WHITELIST_OR_STATE_DRIFT/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM onboarding_requests')).rows[0].n, 2);
  } finally {
    await db.close();
  }
});
test('unexpected cascade/trigger changing a preserved table rolls back all deletes', async () => {
  const { db, client } = await database();
  try {
    await db.exec(
      "CREATE FUNCTION mutate_preserved() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE users SET name='changed'; RETURN OLD; END $$;CREATE TRIGGER mutate AFTER DELETE ON onboarding_provisioning_jobs FOR EACH ROW EXECUTE FUNCTION mutate_preserved();",
    );
    await assert.rejects(() => retireLegacy(client, plan), /PRESERVED_DATA_CHANGED/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM onboarding_provisioning_jobs')).rows[0].n, 2);
    assert.equal((await db.query('SELECT name FROM users')).rows[0].name, 'Keep');
  } finally {
    await db.close();
  }
});
