import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, verify, createPublicKey } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { validatePlan, executeFixture } from './qa09-ten-device-db.mjs';
import { prepareFixture } from './qa09-ten-device-bridge.mjs';
import { proofHeaders, createCsr, assertOwnCloudDevice } from './run-qa09-ten-device-acceptance.mjs';
const prefix = 'qa09-1234567890abcdef';
function plan(action = 'seed') {
  return {
    prefix,
    action,
    devices: Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`),
    customers: [
      { id: '11111111-1111-1111-1111-111111111111', name: prefix + '-a', suffix: 'a' },
      { id: '22222222-2222-2222-2222-222222222222', name: prefix + '-b', suffix: 'b' },
    ],
  };
}
async function db() {
  const pg = new PGlite();
  await pg.exec(`
CREATE TABLE customers(id text PRIMARY KEY,name text,deleted_at timestamptz);
CREATE TABLE devices(id text PRIMARY KEY,serial_number text UNIQUE,model text,hardware_version text,manufacturer text,manufacture_date date,lifecycle_status text,customer_id text REFERENCES customers(id),updated_at timestamptz);
CREATE TABLE device_certificates(id text PRIMARY KEY,device_id text REFERENCES devices(id),status text,fingerprint text,mqtt_verified_at timestamptz,rest_verified_at timestamptz,claimed_at timestamptz,package_ciphertext bytea);
CREATE TABLE onboarding_requests(id text PRIMARY KEY,serial_number text,status text);
CREATE TABLE onboarding_proof_nonces(request_id text REFERENCES onboarding_requests(id));
CREATE TABLE onboarding_provisioning_jobs(id text,request_id text REFERENCES onboarding_requests(id),status text,attempts int,issued_certificate_id text);
CREATE TABLE ingestion_receipts(id text,device_id text,topic_type text,seq int,payload_hash text,result text,occurred_at timestamptz,processed_at timestamptz);
CREATE TABLE device_latest_state(device_id text REFERENCES devices(id),last_heartbeat_at timestamptz);
CREATE TABLE outbox_events(id text,event_type text,aggregate_id text,status text,payload jsonb);
INSERT INTO devices(id,serial_number)VALUES('original','original');
INSERT INTO device_certificates(id,device_id,status)VALUES('original-cert','original','ACTIVE');
`);
  for (const c of plan().customers) await pg.query('INSERT INTO customers(id,name)VALUES($1,$2)', [c.id, c.name]);
  for (const t of [
    'ingestion_gaps',
    'telemetry_hourly',
    'telemetry_daily',
    'device_events',
    'tamper_events',
    'alarms',
    'device_state_history',
    'device_public_keys',
  ])
    await pg.exec(`CREATE TABLE ${t}(device_id text${t === 'telemetry_hourly' ? ',sample_count integer' : ''})`);
  const client = {
    query: async (sql, args) => {
      if (sql === 'SELECT current_database() AS database') return { rows: [{ database: 'fdp' }], rowCount: 1 };
      const r = await pg.query(sql, args);
      return { rows: r.rows, rowCount: /^SELECT/i.test(sql) ? r.rows.length : r.affectedRows };
    },
  };
  return { pg, client };
}
test('exact own-ten plan rejects expansion, historical identity and wrong customer namespace', () => {
  validatePlan(plan());
  for (const changed of [
    { ...plan(), devices: [...plan().devices, 'old-device'] },
    { ...plan(), prefix: 'old' },
    { ...plan(), customers: [{ ...plan().customers[0], name: 'old' }, plan().customers[1]] },
  ])
    assert.throws(() => validatePlan(changed));
  assert.throws(() => assertOwnCloudDevice('original', prefix));
  assert.throws(() => assertOwnCloudDevice(prefix + '-11', prefix));
  const prep = prepareFixture(plan());
  assert.equal(prep.project.name, 'fdp-test-qa09-ten-device-fixtures');
  assert.equal(prep.project.source.type, 'NO_SOURCE');
  assert.ok(!prep.project.source.buildspec.includes('migrate deploy'));
});
test('real SQL creates exact fixtures and cleanup preserves original devices/certificates', async () => {
  const { pg, client } = await db();
  try {
    const seed = await executeFixture(client, plan());
    assert.equal(seed.devices.length, 10);
    await assert.rejects(executeFixture(client, plan()), /FIXTURES_ALREADY_EXIST/);
    const result = await executeFixture(client, { ...plan('cleanup'), baseline: seed.originalFingerprints });
    assert.equal(result.deleted.devices, 10);
    assert.deepEqual((await pg.query('SELECT id FROM devices')).rows, [{ id: 'original' }]);
    assert.deepEqual(result.originalFingerprints, seed.originalFingerprints);
  } finally {
    await pg.close();
  }
});
test('unexpected original-data trigger mutation rolls back fixture creation', async () => {
  const { pg, client } = await db();
  try {
    await pg.exec(
      "CREATE FUNCTION tamper() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE device_certificates SET status='REVOKED' WHERE id='original-cert';RETURN NEW;END $$; CREATE TRIGGER bad_seed AFTER INSERT ON devices FOR EACH ROW EXECUTE FUNCTION tamper();",
    );
    await assert.rejects(executeFixture(client, plan()), /ORIGINAL_DEVICE_OR_CERTIFICATE_CHANGED/);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM devices')).rows[0].n, 1);
    assert.equal((await pg.query('SELECT status FROM device_certificates')).rows[0].status, 'ACTIVE');
  } finally {
    await pg.close();
  }
});
test('processing provisioning job prevents cleanup without deleting any own devices', async () => {
  const { pg, client } = await db();
  try {
    await executeFixture(client, plan());
    await pg.query("INSERT INTO onboarding_requests VALUES('r',$1,'APPROVED')", [plan().devices[0]]);
    await pg.exec("INSERT INTO onboarding_provisioning_jobs(id,request_id,status)VALUES('j','r','PROCESSING')");
    await assert.rejects(executeFixture(client, plan('cleanup')), /JOB_STILL_PROCESSING/);
    assert.equal((await pg.query('SELECT count(*)::int AS n FROM devices')).rows[0].n, 11);
  } finally {
    await pg.close();
  }
});
test('CSR proofs bind method, path, request ID, timestamp, nonce and independent key', () => {
  const a = createCsr(plan().devices[0]),
    b = createCsr(plan().devices[1]);
  const requestId = '33333333-3333-3333-3333-333333333333',
    timestamp = String(Date.now()),
    nonce = randomBytes(24).toString('base64url');
  const h = proofHeaders(requestId, a.key, timestamp, nonce);
  const body = Buffer.from(`GET\n/api/v1/device/onboarding/status\n${requestId}\n${timestamp}\n${nonce}`);
  const signature = Buffer.from(h['X-Onboarding-Signature'], 'base64');
  assert.equal(verify('sha256', body, createPublicKey(a.key), signature), true);
  assert.equal(verify('sha256', body, createPublicKey(b.key), signature), false);
  assert.equal(verify('sha256', Buffer.from(body + 'changed'), createPublicKey(a.key), signature), false);
});
