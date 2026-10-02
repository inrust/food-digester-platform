import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, verify, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { PGlite } from '@electric-sql/pglite';
import { validatePlan, executeFixture } from './qa09-ten-device-db.mjs';
import { prepareFixture } from './qa09-ten-device-bridge.mjs';
import { proofHeaders, createCsr, assertOwnCloudDevice } from './run-qa09-ten-device-acceptance.mjs';
const prefix = 'qa09-1234567890abcdef';
test('CodeBuild inline source fits service limit and decompresses to exact reviewed bytes', () => {
  const prep = prepareFixture(plan());
  assert.ok(Buffer.byteLength(prep.project.source.buildspec) <= 25600);
  const commands = JSON.parse(prep.project.source.buildspec).phases.install.commands;
  for (const [name, path] of [
    ['fixture.mjs', './qa09-ten-device-db.mjs'],
    ['qa09-db-readonly-probe.mjs', './qa09-db-readonly-probe.mjs'],
  ]) {
    const command = commands.find((c) => c.includes(`writeFileSync('${name}'`));
    const encoded = command.match(/Buffer.from\('([A-Za-z0-9+/=]+)','base64'\)/)[1];
    assert.deepEqual(gunzipSync(Buffer.from(encoded, 'base64')), readFileSync(new URL(path, import.meta.url)));
  }
});
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
CREATE TABLE onboarding_provisioning_jobs(id text,request_id text REFERENCES onboarding_requests(id),status text,attempts int,issued_certificate_id text,last_error text);
CREATE TABLE ingestion_receipts(id text,device_id text,topic_type text,seq int,payload_hash text,result text,occurred_at timestamptz,processed_at timestamptz);
CREATE TABLE device_latest_state(device_id text REFERENCES devices(id),last_heartbeat_at timestamptz);
CREATE TABLE outbox_events(id text,event_type text,aggregate_type text,aggregate_id text,status text,payload jsonb);
CREATE TABLE audit_logs(object_type text,object_id text,action text,result text,reason text,created_at timestamptz default now());
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
test('closed-fixture audit and request outbox cleanup require ledger and preserve unrelated events', async () => {
  const { pg, client } = await db();
  try {
    const closed = {
      ...plan('audit-closed'),
      requestLedger: plan().devices.map((deviceId, i) => ({
        deviceId,
        requestId: `33333333-3333-4333-8333-${String(i + 1).padStart(12, '0')}`,
      })),
    };
    assert.throws(() => validatePlan({ ...closed, requestLedger: closed.requestLedger.slice(1) }));
    await pg.exec('UPDATE customers SET deleted_at=now()');
    for (const r of closed.requestLedger)
      await pg.query(
        "INSERT INTO audit_logs(object_type,object_id,action,result)VALUES('onboarding_request',$1,'onboarding.request.approve','SUCCESS')",
        [r.requestId],
      );
    const id = closed.requestLedger[0].requestId;
    await pg.query(
      "INSERT INTO outbox_events VALUES('own','ONBOARDING_PROVISIONING_FAILED','onboarding_request',$1,'PENDING',$2::jsonb)",
      [id, JSON.stringify({ requestId: id, error: 'opaque' })],
    );
    await pg.exec(
      "INSERT INTO outbox_events VALUES('old','ONBOARDING_PROVISIONING_FAILED','onboarding_request','historical','PENDING','{\"requestId\":\"historical\"}')",
    );
    const audit = await executeFixture(client, closed);
    assert.equal(audit.outbox.length, 1);
    assert.equal((await pg.query('SELECT * FROM outbox_events')).rows.length, 2);
    const cleaned = await executeFixture(client, { ...closed, action: 'cleanup-closed' });
    assert.equal(cleaned.deletedRequestOutbox, 1);
    assert.deepEqual((await pg.query('SELECT id FROM outbox_events')).rows, [{ id: 'old' }]);
    assert.equal((await pg.query('SELECT id FROM device_certificates')).rows[0].id, 'original-cert');
  } finally {
    await pg.close();
  }
});
test('closed-fixture access rejects missing approval audit and live customer', async () => {
  const { pg, client } = await db();
  try {
    const closed = {
      ...plan('audit-closed'),
      requestLedger: plan().devices.map((deviceId, i) => ({
        deviceId,
        requestId: `33333333-3333-4333-8333-${String(i + 1).padStart(12, '0')}`,
      })),
    };
    await assert.rejects(executeFixture(client, closed), /CLOSED_CUSTOMER_NOT_VERIFIED/);
    await pg.exec('UPDATE customers SET deleted_at=now()');
    await assert.rejects(executeFixture(client, closed), /REQUEST_APPROVAL_AUDIT_MISSING/);
  } finally {
    await pg.close();
  }
});

test('unseeded capacity attempt has read-only empty audit with deleted customers and fixed original baseline', async () => {
  const { pg, client } = await db();
  try {
    const before = await executeFixture(client, plan('observe'));
    await pg.exec('UPDATE customers SET deleted_at=now()');
    const empty = { ...plan('audit-empty'), baseline: before.originalFingerprints };
    assert.equal((await executeFixture(client, empty)).empty, true);
    await assert.rejects(executeFixture(client, { ...empty, baseline: undefined }), /BASELINE_REQUIRED/);
    await pg.query('INSERT INTO devices(id,serial_number,customer_id) VALUES($1,$1,$2)', [
      plan().devices[0],
      plan().customers[0].id,
    ]);
    await assert.rejects(executeFixture(client, empty), /FIXTURE_NOT_EMPTY/);
    assert.equal(
      (await pg.query("SELECT status FROM device_certificates WHERE id='original-cert'")).rows[0].status,
      'ACTIVE',
    );
  } finally {
    await pg.close();
  }
});
