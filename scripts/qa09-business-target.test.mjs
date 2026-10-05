import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  runBusinessTarget,
  assertBusinessContext,
  validateTargetStage,
  validateTargetAssertions,
} from './qa09-business-target.mjs';
import { executeFixture } from './qa09-ten-device-db.mjs';
const prefix = 'qa09-1234567890abcdef';
const plan = {
  prefix,
  devices: Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`),
  customers: [
    { id: '11111111-1111-1111-1111-111111111111', name: prefix + '-a', suffix: 'a' },
    { id: '22222222-2222-2222-2222-222222222222', name: prefix + '-b', suffix: 'b' },
  ],
};
test('target gates reject missing finish cleanup required case and foreign device before live calls', () => {
  assertBusinessContext(plan);
  assert.throws(() => assertBusinessContext({ ...plan, devices: ['foreign', ...plan.devices.slice(1)] }));
  const r = {
    mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
    finishedAt: '2026-10-03T00:00:00Z',
    fullQa09Accepted: false,
    cleanupComplete: true,
    checks: [{ stage: 'core', id: 'workflow', result: 'PASS' }],
  };
  assert.equal(validateTargetStage(r, 'core', ['workflow']).gate, 'PASS');
  for (const patch of [
    { finishedAt: null },
    { cleanupComplete: false },
    { checks: [] },
    { checks: [{ stage: 'core', id: 'workflow', result: 'FAIL' }] },
  ])
    assert.throws(() => validateTargetStage({ ...r, ...patch }, 'core', ['workflow']));
});
test('business cleanup preserves outside rows, rejects baseline drift and deletes own dependent rows atomically', async () => {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE customers(id text,name text);CREATE TABLE devices(id text,customer_id text,site_id text);CREATE TABLE device_certificates(device_id text);CREATE TABLE sites(id text,customer_id text);CREATE TABLE outbox_events(id text,event_type text,aggregate_type text,aggregate_id text,status text,created_at timestamptz,published_at timestamptz);
 CREATE TABLE device_user_sync_receipts(device_id text);CREATE TABLE device_user_assignments(customer_id text);CREATE TABLE device_users(id text,customer_id text);CREATE TABLE license_history(license_id text);CREATE TABLE license_entitlements(license_id text);CREATE TABLE contract_devices(customer_id text);CREATE TABLE licenses(id text,customer_id text);CREATE TABLE contracts(id text,customer_id text);CREATE TABLE configuration_versions(id text,configuration_id text);CREATE TABLE device_configurations(id text,target_device_id text);CREATE TABLE consumable_requests(customer_id text);CREATE TABLE esg_export_jobs(customer_id text);CREATE TABLE device_assignments(device_id text);CREATE TABLE device_commands(id text,device_id text);CREATE TABLE command_attempts(command_id text);CREATE TABLE command_acks(command_id text);CREATE TABLE device_retirements(device_id text);
 INSERT INTO devices VALUES('original','original-customer','original-site');INSERT INTO licenses VALUES('original-license','original-customer');INSERT INTO license_history VALUES('original-license');
 INSERT INTO device_configurations VALUES('global-model-config',NULL);INSERT INTO esg_export_jobs VALUES(NULL);INSERT INTO outbox_events(aggregate_id) VALUES('original-license');INSERT INTO sites VALUES('foreign-site','original-customer');INSERT INTO outbox_events(aggregate_id) VALUES('foreign-site');`);
  for (const c of plan.customers) await pg.query('INSERT INTO customers VALUES($1,$2)', [c.id, c.name]);
  const client = {
    query: async (sql, args) => {
      if (sql === 'SELECT current_database() AS database') return { rows: [{ database: 'fdp' }], rowCount: 1 };
      const x = await pg.query(sql, args);
      return { rows: x.rows, rowCount: /^SELECT/.test(sql) ? x.rows.length : x.affectedRows };
    },
  };
  try {
    const baseline = await executeFixture(client, { ...plan, action: 'business-baseline' });
    for (const table of ['device_configurations', 'esg_export_jobs'])
      assert.equal(baseline.businessFingerprints.find((row) => row.table === table).count, '1');
    await pg.exec("UPDATE device_configurations SET id='changed-global-model-config' WHERE target_device_id IS NULL");
    await assert.rejects(
      executeFixture(client, { ...plan, action: 'business-cleanup', businessBaseline: baseline.businessFingerprints }),
      /BUSINESS_BASELINE_DRIFT/,
    );
    await pg.exec("UPDATE device_configurations SET id='global-model-config' WHERE target_device_id IS NULL");
    await pg.query('INSERT INTO licenses VALUES($1,$2)', ['own-license', plan.customers[0].id]);
    await pg.exec(
      "INSERT INTO license_history VALUES('own-license');INSERT INTO outbox_events(aggregate_id) VALUES('own-license');",
    );
    await pg.query('INSERT INTO device_commands VALUES($1,$2)', ['OWN-CMD', plan.devices[0]]);
    await pg.exec("INSERT INTO outbox_events(aggregate_id) VALUES('OWN-CMD');");
    await pg.query('INSERT INTO device_configurations VALUES($1,$2)', ['own-configuration', plan.devices[0]]);
    await pg.query('INSERT INTO configuration_versions VALUES($1,$2)', ['own-config-version', 'own-configuration']);
    await pg.query('INSERT INTO outbox_events(aggregate_id) VALUES($1),($2)', [
      'own-configuration',
      'own-config-version',
    ]);
    await assert.rejects(
      executeFixture(client, { ...plan, action: 'business-cleanup', businessBaseline: [] }),
      /BUSINESS_BASELINE_DRIFT/,
    );
    assert.equal((await pg.query("SELECT count(*)::int n FROM licenses WHERE id='own-license'")).rows[0].n, 1);
    const result = await executeFixture(client, {
      ...plan,
      action: 'business-cleanup',
      businessBaseline: baseline.businessFingerprints,
    });
    assert.equal(
      Object.values(result.counts).reduce((a, b) => a + b, 0),
      0,
    );
    assert.deepEqual(result.businessFingerprints, baseline.businessFingerprints);
    assert.equal((await pg.query('SELECT count(*)::int n FROM licenses')).rows[0].n, 1);
    assert.equal((await pg.query('SELECT count(*)::int n FROM outbox_events')).rows[0].n, 2);
    assert.equal((await pg.query('SELECT count(*)::int n FROM license_history')).rows[0].n, 1);
    assert.equal(
      (await pg.query('SELECT count(*)::int n FROM device_configurations WHERE target_device_id IS NULL')).rows[0].n,
      1,
    );
    assert.equal(
      (await pg.query('SELECT count(*)::int n FROM esg_export_jobs WHERE customer_id IS NULL')).rows[0].n,
      1,
    );
    await executeFixture(client, {
      ...plan,
      action: 'business-audit',
      businessBaseline: baseline.businessFingerprints,
    });
  } finally {
    await pg.close();
  }
});

test('fault injection rejects missing authorization and foreign export identity without mutation', async () => {
  const client = {
    query: async (sql) => {
      if (sql === 'SELECT current_database() AS database') return { rows: [{ database: 'fdp' }] };
      if (sql.includes("SELECT 'devices' AS entity")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(
    executeFixture(client, {
      ...plan,
      action: 'business-inject-export-lease',
      exportId: '11111111-1111-1111-1111-111111111111',
    }),
    /OWN_FAULT_AUTHORIZATION_REQUIRED/,
  );
  await assert.rejects(
    executeFixture(client, {
      ...plan,
      action: 'business-inject-export-lease',
      exportId: '11111111-1111-1111-1111-111111111111',
      faultAuthorization: 'USER_CONFIRMED_OWN_FIXTURE_ONLY_2026_10_03',
    }),
    /OWN_EXPORT_NOT_READY_FOR_INJECTION/,
  );
});

test('assertion-only validation cannot stand in for cleanup or whole target acceptance', () => {
  const r = {
    mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
    finishedAt: '2026-10-03T00:00:00Z',
    fullQa09Accepted: false,
    cleanupComplete: false,
    checks: [{ stage: 'core', id: 'workflow', result: 'PASS' }],
  };
  const proof = validateTargetAssertions(r, 'core', ['workflow']);
  assert.equal(proof.assertionsGate, 'PASS');
  assert.equal(proof.gate, undefined);
  assert.throws(() => validateTargetStage(r, 'core', ['workflow']), /CLEANUP_MISSING/);
  assert.throws(() => validateTargetAssertions({ ...r, checks: [] }, 'core', ['workflow']), /REQUIRED_PROOF/);
});

test('nonActive scope cannot enter the full wave that contains Active dependent probes', async () => {
  await assert.rejects(
    runBusinessTarget(null, '/tmp/not-written.json', { nonActiveOnly: true, coreOnly: false }),
    /NONACTIVE_FULL_WAVE_FORBIDDEN/,
  );
});
