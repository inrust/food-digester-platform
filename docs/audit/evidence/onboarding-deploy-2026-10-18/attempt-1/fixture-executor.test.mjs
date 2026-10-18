import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { execute, validatePlan } from './fixture-executor.mjs';
const require = createRequire(new URL('../../../../../packages/database/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');
const { btree_gist } = require('@electric-sql/pglite/contrib/btree_gist');
const dir = new URL('../../../../../packages/database/prisma/migrations/', import.meta.url);
const migrations = readdirSync(dir)
  .filter((n) => /^\d{14}_/.test(n))
  .sort()
  .map((n) => readFileSync(new URL(n + '/migration.sql', dir), 'utf8'))
  .join('\n');
const plan = {
  prefix: 'qa09-1234567890abcdef',
  serialNumber: 'qa09-1234567890abcdef-onboarding',
  applicationCommit: 'a'.repeat(40),
  action: 'cleanup',
  requestId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
  certificateIds: ['a'.repeat(64)],
  cloudCleanupVerified: true,
};
async function setup() {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(migrations);
  await db.query(
    "INSERT INTO devices(id,serial_number,model,hardware_version,manufacturer,manufacture_date,lifecycle_status,updated_at) VALUES($1,$2,'M','1','B','2026-01-01','OnboardingApproved',now()),('outside','OUTSIDE','M','1','B','2026-01-01','Onboarded',now())",
    [plan.deviceId, plan.serialNumber],
  );
  await db.query(
    "INSERT INTO onboarding_requests(id,serial_number,submitted_by,model,hardware_version,manufacturer,manufacture_date,csr_pem,public_key_fingerprint,status) VALUES($1,$2,'DEVICE','M','1','B','2026-01-01','CSR','fp','APPROVED')",
    [plan.requestId, plan.serialNumber],
  );
  await db.query(
    "INSERT INTO onboarding_provisioning_jobs(id,request_id,operation_id,status,updated_at) VALUES('job',$1,'test-operation','COMPLETED',now())",
    [plan.requestId],
  );
  await db.query(
    "INSERT INTO device_certificates(id,device_id,fingerprint,status,not_before,not_after) VALUES($1,$2,'fp','PENDING_CLAIM',now(),now()+interval '1 year')",
    [plan.certificateIds[0], plan.deviceId],
  );
  await db.query("INSERT INTO device_public_keys(fingerprint,device_id) VALUES('fp',$1)", [plan.deviceId]);
  const client = {
    query: (sql, args) =>
      sql.startsWith('SELECT current_database()')
        ? Promise.resolve({ rows: [{ database: 'fdp', read_only: 'on' }] })
        : db.query(sql, args),
  };
  return { db, client };
}
test('fixture rejects non-owned serials, missing exact IDs and missing cloud cleanup proof', () => {
  validatePlan(plan);
  for (const change of [
    { serialNumber: '05DCFF33-32594232-43027614' },
    { cloudCleanupVerified: false },
    { requestId: 'outside' },
    { certificateIds: [] },
  ])
    assert.throws(() => validatePlan({ ...plan, ...change }));
});
test('cleanup removes only exact completed own fixtures and preserves outside rows', async () => {
  const { db, client } = await setup();
  try {
    const before = await db.query("SELECT * FROM devices WHERE id='outside'");
    const result = await execute(client, plan);
    assert.equal(result.deleted.devices, 1);
    assert.equal(result.deleted.onboarding_requests, 1);
    assert.deepEqual(await db.query("SELECT * FROM devices WHERE id='outside'"), before);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM onboarding_requests')).rows[0].n, 0);
  } finally {
    await db.close();
  }
});
test('processing jobs block cleanup and rollback without removing data', async () => {
  const { db, client } = await setup();
  try {
    await db.query("UPDATE onboarding_provisioning_jobs SET status='PROCESSING'");
    await assert.rejects(() => execute(client, plan), /JOB_NOT_COMPLETED/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM devices')).rows[0].n, 2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM onboarding_requests')).rows[0].n, 1);
  } finally {
    await db.close();
  }
});
