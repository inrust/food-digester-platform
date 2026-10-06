import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readAllMigrationSql } from '../packages/database/test/helpers.ts';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { PGlite } from '@electric-sql/pglite';
import { executeFixture } from './qa09-ten-device-db.mjs';
const prefix = 'qa09-1234567890abcdef';
const customers = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'].map((id, i) => ({
  id,
  suffix: i ? 'b' : 'a',
  name: prefix + (i ? '-b' : '-a'),
}));
const devices = Array.from({ length: 10 }, (_, i) => prefix + '-' + String(i + 1).padStart(2, '0'));
const plan = { prefix, customers, devices, action: 'business-seed-semantic-data' };
// Keep one Wasm instance alive until the file completes: Node 24's V8 can
// abort while reclaiming wrappers after repeated PGlite create/close cycles.
// Rebuild the schema for every test so fixture state never carries across cases.
let pg;
before(async () => {
  pg = new PGlite({ extensions: { btree_gist } });
  await pg.waitReady;
});
after(async () => {
  await pg?.close();
});
async function setup() {
  await pg.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pg.exec(readAllMigrationSql());
  for (const c of customers) {
    await pg.query('INSERT INTO customers(id,name,updated_at)VALUES($1,$2,now())', [c.id, c.name]);
    await pg.query('INSERT INTO sites(id,customer_id,name,updated_at)VALUES($1,$2,$1,now())', [c.id + '-site', c.id]);
  }
  for (const [i, id] of devices.entries())
    await pg.query(
      "INSERT INTO devices(id,serial_number,model,hardware_version,manufacturer,manufacture_date,customer_id,site_id,lifecycle_status,updated_at)VALUES($1,$1,'BNX-100','1','QA09','2026-01-01',$2,$3,'Assigned',now())",
      [id, customers[i < 5 ? 0 : 1].id, customers[i < 5 ? 0 : 1].id + '-site'],
    );
  const client = {
    query: async (sql, args) => {
      if (sql === 'SELECT current_database() AS database') return { rows: [{ database: 'fdp' }], rowCount: 1 };
      const r = await pg.query(sql, args);
      return { rows: r.rows, rowCount: /^SELECT/.test(sql) ? r.rows.length : r.affectedRows };
    },
  };
  return { pg, client };
}
test('semantic SQL creates two scoped read models without lifecycle or authentication claims and refuses reuse', async () => {
  const { pg, client } = await setup();
  const baseline = await executeFixture(client, { ...plan, action: 'business-baseline' });
  const r = await executeFixture(client, plan);
  assert.match(r.fixtureMode, /SYNTHETIC.*NO_DEVICE/);
  assert.ok(Object.values(r.counts).every((n) => n === 2));
  const metrics = (await pg.query('SELECT metrics FROM telemetry_hourly ORDER BY device_id')).rows[0].metrics;
  assert.equal(metrics.heatTemperatureC.avg, 42);
  assert.equal(
    (await pg.query("SELECT count(*)::int AS n FROM devices WHERE lifecycle_status='Assigned'")).rows[0].n,
    10,
  );
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM device_certificates')).rows[0].n, 0);
  await assert.rejects(executeFixture(client, plan), /ALREADY_EXISTS/);
  const cleanup = await executeFixture(client, {
    ...plan,
    action: 'business-cleanup',
    businessBaseline: baseline.businessFingerprints,
  });
  assert.ok(Object.values(cleanup.counts).every((n) => n === 0));
  await executeFixture(client, {
    ...plan,
    action: 'business-audit',
    businessBaseline: baseline.businessFingerprints,
  });
});
for (const mutation of [
  "UPDATE devices SET lifecycle_status='Active'",
  'UPDATE devices SET site_id=NULL',
  "UPDATE sites SET customer_id='22222222-2222-2222-2222-222222222222' WHERE customer_id='11111111-1111-1111-1111-111111111111'",
  "UPDATE customers SET name='outside'",
])
  test('semantic SQL refuses scope/state drift: ' + mutation.split(' SET ')[1], async () => {
    const { pg, client } = await setup();
    await pg.exec(mutation);
    await assert.rejects(executeFixture(client, plan), /OWN_ASSIGNMENT_REQUIRED/);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM esg_reports')).rows[0].n, 0);
  });

test('platform exports require the exact ledger and own frozen filters; foreign jobs remain unchanged', async () => {
  const { pg, client } = await setup();
  const own = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    foreign = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  await pg.query(
    "INSERT INTO esg_export_jobs(id,requested_by,dataset,filters)VALUES($1,'fixture','DAILY_SUMMARY',$2)",
    [foreign, { customerId: 'outside' }],
  );
  const baseline = await executeFixture(client, { ...plan, action: 'business-baseline' });
  await pg.query(
    "INSERT INTO esg_export_jobs(id,requested_by,dataset,filters)VALUES($1,'fixture','DAILY_SUMMARY',$2)",
    [own, { customerId: customers[0].id }],
  );
  await assert.rejects(
    executeFixture(client, { ...plan, action: 'business-cleanup', businessBaseline: baseline.businessFingerprints }),
    /BUSINESS_BASELINE_DRIFT/,
  );
  await assert.rejects(
    executeFixture(client, {
      ...plan,
      action: 'business-cleanup',
      semanticExportIds: [foreign],
      businessBaseline: baseline.businessFingerprints,
    }),
    /OWN_EXPORT_FILTER_SCOPE_DRIFT/,
  );
  const cleaned = await executeFixture(client, {
    ...plan,
    action: 'business-cleanup',
    semanticExportIds: [own],
    businessBaseline: baseline.businessFingerprints,
  });
  assert.equal(cleaned.deleted.esg_export_jobs, 1);
  assert.deepEqual((await pg.query('SELECT id,filters FROM esg_export_jobs')).rows, [
    { id: foreign, filters: { customerId: 'outside' } },
  ]);
  await executeFixture(client, {
    ...plan,
    action: 'business-audit',
    semanticExportIds: [own],
    businessBaseline: baseline.businessFingerprints,
  });
});
